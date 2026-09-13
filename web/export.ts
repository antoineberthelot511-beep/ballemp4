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

export interface ExportResult {
  blob: Blob;
  frames: number;
  duration: number;
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

  await encodeAudio(world.audio.events, world.config, o, muxer);

  o.onProgress('assemblage', 0);
  await breathe();
  const blob = muxer.finalize();
  o.onProgress('assemblage', 1);

  return { blob, frames: total, duration: world.config.duration };
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
): Promise<void> {
  const sampleRate = 48000;
  const tail = 1.2;
  const frames = Math.ceil((config.duration + tail) * sampleRate);
  if (frames <= 0 || events.length === 0) return;

  const offline = new OfflineAudioContext(2, frames, sampleRate);
  const master = offline.createGain();
  master.gain.value = 1;
  master.connect(offline.destination);

  for (const ev of events) {
    if (ev.t >= config.duration + tail) continue;
    const pan = offline.createStereoPanner();
    pan.pan.value = ev.pan;
    pan.connect(master);

    if (ev.sample) {
      const buffer = o.sounds.get(ev.sample);
      if (!buffer) continue;
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
    encoder.encode(
      new AudioData({
        format: 'f32-planar',
        sampleRate,
        numberOfFrames: n,
        numberOfChannels: 2,
        timestamp: Math.round((i / sampleRate) * 1_000_000),
        data: planar,
      }),
    );
    if ((i / block) % 200 === 0) {
      o.onProgress('audio', 0.5 + 0.5 * (i / audioLimit));
      await breathe();
    }
  }

  await encoder.flush();
  encoder.close();
  if (audioError) throw audioError;
  o.onProgress('audio', 1);
}
