import type { AnySim, AudioEvent, Ctx2D, SimConfig } from '../engine/types.ts';
import { World } from '../engine/world.ts';
import { Mp4Muxer } from './mp4.ts';
import type { SoundBank } from './sounds.ts';

/**
 * Export mp4 dans le navigateur, image par image.
 *
 * Ce n'est pas une capture de l'écran : la simulation est rejouée depuis sa
 * graine et chaque image est encodée telle qu'elle est calculée. Le fichier
 * obtenu est donc identique quelle que soit la machine, et ne dépend ni de la
 * fréquence de l'écran ni de la charge du navigateur — exactement comme le
 * rendu en ligne de commande.
 */

export type ExportStage = 'video' | 'audio' | 'assemblage';

export interface ExportOptions {
  sim: AnySim;
  overrides: Partial<SimConfig>;
  sounds: SoundBank;
  onProgress: (stage: ExportStage, ratio: number) => void;
  signal?: AbortSignal;
}

/**
 * État réel de la bande-son du fichier produit, mesuré et non supposé.
 *
 * `absente` : aucune piste muxée. `silencieuse` : une piste existe mais son
 * niveau crête est nul. `synthétisée` : les échantillons manquaient, les
 * impacts ont été fabriqués. `ok` : la bande-son attendue.
 */
export type AudioOutcome = 'ok' | 'synthétisée' | 'silencieuse' | 'absente';

export interface ExportResult {
  blob: Blob;
  frames: number;
  duration: number;
  audio: AudioOutcome;
  /** Ce que contient réellement la piste, pour diagnostic. */
  audioDetail: string;
}

export function canExport(): boolean {
  return typeof VideoEncoder !== 'undefined' && typeof AudioEncoder !== 'undefined';
}

/** Rend la main au navigateur pour que la barre de progression s'affiche. */
function breathe(): Promise<void> {
  return new Promise((r) => setTimeout(r, 0));
}

/**
 * Attend que l'encodeur ait vidé une partie de sa file.
 *
 * On écoute l'événement `dequeue` plutôt que de sonder avec `setTimeout` : dans
 * un onglet en arrière-plan les minuteries sont bridées à une seconde, ce qui
 * ferait ramper l'export. Un événement, lui, n'est pas bridé.
 */
function waitForDequeue(encoder: VideoEncoder): Promise<void> {
  if (typeof encoder.addEventListener !== 'function') return breathe();
  return new Promise((resolve) => {
    encoder.addEventListener('dequeue', () => resolve(), { once: true });
  });
}

function abortIfNeeded(signal?: AbortSignal): void {
  if (signal?.aborted) throw new DOMException('Export annulé', 'AbortError');
}

export async function exportMp4(o: ExportOptions): Promise<ExportResult> {
  const world = new World(o.sim, o.overrides);
  const { width, height, fps } = world.config;
  const total = world.totalFrames;

  const canvas = document.createElement('canvas');
  canvas.width = width;
  canvas.height = height;
  const ctx = canvas.getContext('2d', { alpha: false }) as unknown as Ctx2D;

  const muxer = new Mp4Muxer({ width, height, fps });

  let encoderError: Error | null = null;
  const video = new VideoEncoder({
    output: (chunk, meta) => muxer.addVideoChunk(chunk, meta?.decoderConfig?.description),
    error: (e) => {
      encoderError = e;
    },
  });
  video.configure({
    codec: 'avc1.640028',
    width,
    height,
    // ~6 Mb/s : les aplats de cette sim se compressent très bien, et au-delà le
    // fichier devient lourd à partager sans gain visible.
    bitrate: 6_000_000,
    framerate: fps,
    avc: { format: 'avc' },
  });

  const keyEvery = fps * 2;
  for (let f = 0; f < total; f++) {
    abortIfNeeded(o.signal);
    if (encoderError) throw encoderError;

    world.advanceFrame();
    world.render(ctx);

    const frame = new VideoFrame(canvas, { timestamp: Math.round((f * 1_000_000) / fps) });
    video.encode(frame, { keyFrame: f % keyEvery === 0 });
    frame.close();

    // La file de l'encodeur se vide plus lentement qu'on ne la remplit ; sans
    // ce frein, la mémoire enfle et l'onglet se fige.
    while (video.encodeQueueSize > 8) {
      abortIfNeeded(o.signal);
      await waitForDequeue(video);
    }
    if (f % 15 === 0) {
      o.onProgress('video', f / total);
      await breathe();
    }
  }

  await video.flush();
  video.close();
  if (encoderError) throw encoderError;
  o.onProgress('video', 1);

  const { outcome, peakDb } = await encodeAudio(world.audio.events, world.config, o, muxer);

  o.onProgress('assemblage', 0);
  await breathe();
  const blob = muxer.finalize();
  const relu = await relisten(blob);
  o.onProgress('assemblage', 1);

  return {
    blob,
    frames: total,
    duration: world.config.duration,
    audio: muxer.hasAudio ? outcome : 'absente',
    audioDetail: `${muxer.audioSummary()} · pic ${peakDb} · relu ${relu}`,
  };
}

/**
 * Relit le fichier produit avec le décodeur de l'appareil.
 *
 * C'est la mesure qui compte sur un téléphone : `decodeAudioData` passe par
 * CoreAudio sur iOS et par MediaCodec sur Android, les décodeurs mêmes qui
 * liront le fichier une fois enregistré. Un niveau relu ici vaut donc preuve
 * que la piste s'entendra dans la pellicule.
 *
 * L'inverse est un indice, pas un verdict : ces décodeurs peuvent refuser un
 * fichier valide au seul motif qu'il porte aussi une piste vidéo. D'où un
 * résultat purement informatif, qui ne fait jamais échouer l'export.
 */
async function relisten(blob: Blob): Promise<string> {
  // Au-delà, le doublement en mémoire coûte plus que le diagnostic ne rapporte.
  if (blob.size > 96 * 1024 * 1024) return 'non vérifié (trop lourd)';
  try {
    const bytes = await blob.arrayBuffer();
    const ctx = new OfflineAudioContext(1, 1, 48000);
    const buffer = await new Promise<AudioBuffer>((resolve, reject) => {
      const maybe = ctx.decodeAudioData(bytes, resolve, reject) as Promise<AudioBuffer> | undefined;
      if (maybe && typeof maybe.then === 'function') maybe.then(resolve, reject);
    });
    if (!buffer || !buffer.length) return 'REFUSÉ (piste vide)';
    let peak = 0;
    for (let c = 0; c < buffer.numberOfChannels; c++) {
      const d = buffer.getChannelData(c);
      for (let i = 0; i < d.length; i++) {
        const m = Math.abs(d[i]);
        if (m > peak) peak = m;
      }
    }
    if (peak <= 1e-6) return 'MUET à la relecture';
    return `ok ${(20 * Math.log10(peak)).toFixed(1)} dB`;
  } catch (err) {
    return `REFUSÉ par le décodeur (${err instanceof Error ? err.name : 'erreur'})`;
  }
}

/**
 * Reconstitue la bande-son hors-ligne puis l'encode en AAC.
 *
 * On passe par un OfflineAudioContext plutôt que par un mixage à la main : il
 * fait le rééchantillonnage, le panoramique et la somme, et il rend plus vite
 * que le temps réel.
 */
async function encodeAudio(
  events: readonly AudioEvent[],
  config: SimConfig,
  o: ExportOptions,
  muxer: Mp4Muxer,
): Promise<{ outcome: AudioOutcome; peakDb: string }> {
  const sampleRate = 48000;
  const tail = 1.2;
  const frames = Math.ceil((config.duration + tail) * sampleRate);
  if (frames <= 0 || events.length === 0) return { outcome: 'absente', peakDb: 'n/a' };

  const wanted = [...new Set(events.map((e) => e.sample).filter((n): n is string => !!n))];

  let synthesized = 0;

  const offline = new OfflineAudioContext(2, frames, sampleRate);

  // Les tampons sont décodés par le contexte qui va les jouer, et par lui seul.
  // L'export empruntait ceux de la lecture temps réel, décodés par un autre
  // contexte — la règle que cette page s'impose partout ailleurs, justement
  // parce qu'iOS ne garantit rien sur un tampon venu d'ailleurs. Un tampon
  // refusé ne lève rien : il ne produit aucun son, et le fichier sort muet
  // sans que personne ne puisse dire pourquoi.
  //
  // Décoder ici a un second mérite : cela ne réclame aucun geste préalable ni
  // aucun contexte réveillé, contrairement au décodage temps réel.
  const samples: Map<string, AudioBuffer> = wanted.length
    ? await o.sounds.decodeFor(offline, wanted)
    : new Map();
  const master = offline.createGain();
  master.gain.value = 1;
  master.connect(offline.destination);

  for (const ev of events) {
    if (ev.t >= config.duration + tail) continue;
    const pan = offline.createStereoPanner();
    pan.pan.value = ev.pan;
    pan.connect(master);

    if (ev.sample) {
      const buffer = samples.get(ev.sample);
      // Sauter l'événement rendait la vidéo entièrement muette dès que
      // l'échantillon manquait, et sans le dire. Mieux vaut un impact
      // fabriqué qu'un fichier silencieux.
      if (!buffer) {
        synthesized++;
        synthImpact(offline, master, ev);
        continue;
      }
      const src = offline.createBufferSource();
      src.buffer = buffer;
      src.playbackRate.value = Math.max(0.05, ev.rate ?? 1);
      const gain = offline.createGain();
      gain.gain.value = ev.gain;
      src.connect(gain).connect(pan);
      src.start(ev.t);
      continue;
    }

    const osc = offline.createOscillator();
    osc.type = ev.voice === 'thud' ? 'sine' : 'triangle';
    osc.frequency.setValueAtTime(ev.freq, ev.t);
    if (ev.voice === 'thud') {
      osc.frequency.exponentialRampToValueAtTime(Math.max(20, ev.freq * 0.5), ev.t + 0.06);
    }
    const gain = offline.createGain();
    gain.gain.setValueAtTime(0, ev.t);
    gain.gain.linearRampToValueAtTime(ev.gain * 0.6, ev.t + 0.0025);
    gain.gain.exponentialRampToValueAtTime(0.0001, ev.t + ev.decay * 4);
    osc.connect(gain).connect(pan);
    osc.start(ev.t);
    osc.stop(ev.t + ev.decay * 4 + 0.05);
  }

  o.onProgress('audio', 0.2);
  const rendered = await offline.startRendering();
  o.onProgress('audio', 0.5);

  const left = rendered.getChannelData(0);
  const right = rendered.getChannelData(1);

  // Normalisation à 0,89 : même niveau de sortie que le rendu en ligne de
  // commande, donc les deux fichiers s'entendent pareil.
  let peak = 0;
  for (let i = 0; i < left.length; i++) {
    const m = Math.max(Math.abs(left[i]), Math.abs(right[i]));
    if (m > peak) peak = m;
  }
  const norm = peak > 1e-6 ? 0.89 / peak : 1;
  // Un pic nul veut dire que rien n'a été produit : la piste serait encodée,
  // mais silencieuse. C'est ce que l'appelant doit pouvoir annoncer.
  const outcome: AudioOutcome = peak <= 1e-6 ? 'silencieuse' : synthesized > 0 ? 'synthétisée' : 'ok';
  const peakDb = peak > 1e-6 ? `${(20 * Math.log10(peak)).toFixed(1)} dB` : 'silence';

  let audioError: Error | null = null;
  const encoder = new AudioEncoder({
    output: (chunk, meta) => muxer.addAudioChunk(chunk, meta?.decoderConfig),
    error: (e) => {
      audioError = e;
    },
  });
  encoder.configure({ codec: 'mp4a.40.2', sampleRate, numberOfChannels: 2, bitrate: 192_000 });

  // On calcule la queue pour que les dernières notes s'éteignent proprement,
  // mais on n'encode que jusqu'à la fin de l'image : sans cette coupe, la piste
  // audio dépasse la vidéo et le lecteur affiche une seconde de noir. C'est ce
  // que fait `-shortest` côté ligne de commande.
  const audioLimit = Math.min(left.length, Math.ceil(config.duration * sampleRate));

  const block = 1024;
  for (let i = 0; i < audioLimit; i += block) {
    abortIfNeeded(o.signal);
    if (audioError) throw audioError;

    const n = Math.min(block, audioLimit - i);
    const planar = new Float32Array(n * 2);
    for (let k = 0; k < n; k++) {
      planar[k] = left[i + k] * norm;
      planar[n + k] = right[i + k] * norm;
    }
    const audioData = new AudioData({
      format: 'f32-planar',
      sampleRate,
      numberOfFrames: n,
      numberOfChannels: 2,
      timestamp: Math.round((i / sampleRate) * 1_000_000),
      data: planar,
    });
    encoder.encode(audioData);
    // Un AudioData non fermé n'attend que le ramasse-miettes. Sur un téléphone
    // les quelques milliers de blocs d'un export suffisent à faire lâcher
    // l'encodeur avant la fin.
    audioData.close();
    if ((i / block) % 200 === 0) {
      o.onProgress('audio', 0.5 + 0.5 * (i / audioLimit));
      await breathe();
    }
  }

  await encoder.flush();
  encoder.close();
  if (audioError) throw audioError;
  o.onProgress('audio', 1);
  return { outcome, peakDb };
}

/**
 * Impact de secours, quand l'échantillon n'a pas pu être décodé.
 *
 * Un coup bref : une sinusoïde qui chute, plus un claquement plus haut pour
 * l'attaque. La hauteur suit `rate`, donc la montée de gamme reste audible.
 */
function synthImpact(offline: OfflineAudioContext, master: GainNode, ev: AudioEvent): void {
  const pan = offline.createStereoPanner();
  pan.pan.value = ev.pan;
  pan.connect(master);

  const rate = Math.max(0.05, ev.rate ?? 1);
  const gain = offline.createGain();
  gain.gain.setValueAtTime(0, ev.t);
  gain.gain.linearRampToValueAtTime(ev.gain * 0.9, ev.t + 0.004);
  gain.gain.exponentialRampToValueAtTime(0.0001, ev.t + 0.18);
  gain.connect(pan);

  const body = offline.createOscillator();
  body.type = 'sine';
  body.frequency.setValueAtTime(320 * rate, ev.t);
  body.frequency.exponentialRampToValueAtTime(90 * rate, ev.t + 0.14);
  body.connect(gain);
  body.start(ev.t);
  body.stop(ev.t + 0.2);

  const click = offline.createOscillator();
  click.type = 'triangle';
  click.frequency.setValueAtTime(1800 * rate, ev.t);
  const clickGain = offline.createGain();
  clickGain.gain.setValueAtTime(ev.gain * 0.35, ev.t);
  clickGain.gain.exponentialRampToValueAtTime(0.0001, ev.t + 0.03);
  click.connect(clickGain).connect(pan);
  click.start(ev.t);
  click.stop(ev.t + 0.04);
}
