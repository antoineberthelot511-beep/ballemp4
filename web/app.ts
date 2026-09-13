import type { Ctx2D, SimConfig } from '../engine/types.ts';
import { World, resolveSimConfig } from '../engine/world.ts';
import { getSim } from '../sims/registry.ts';
import { installSurfaceFactory } from '../engine/surface.ts';
import { setFonts } from '../engine/fonts.ts';
import { SoundBank } from './sounds.ts';
import { canExport, exportMp4, type AudioOutcome, type ExportStage } from './export.ts';

/**
 * Application autonome : la même simulation que le rendu en ligne de commande,
 * jouée en direct et exportable en mp4 sans quitter la page.
 *
 * requestAnimationFrame n'apparaît qu'ici, et seulement pour cadencer : il
 * décide QUAND avancer d'un pas fixe, jamais de combien. L'export, lui, ne
 * dépend pas du tout de rAF — il rejoue la simulation image par image.
 */

// ---------------------------------------------------------------- plateforme

installSurfaceFactory((w, h) => {
  const c = document.createElement('canvas');
  c.width = w;
  c.height = h;
  return {
    get width() {
      return c.width;
    },
    get height() {
      return c.height;
    },
    ctx: c.getContext('2d') as unknown as Ctx2D,
    image: c,
  };
});
setFonts({ display: 'Archivo, "Segoe UI", system-ui, sans-serif' });

/**
 * Le panneau sert plusieurs sims, qui n'ont pas le même réglage à offrir.
 * Chacune déclare ici le paramètre que son deuxième champ pilote — le premier
 * est toujours la durée, le troisième toujours la graine.
 */
interface Knob {
  param: string;
  label: string;
  min: number;
  max: number;
  step: number;
  tagline: string;
}

const KNOBS: Record<string, Knob> = {
  bouncing: {
    param: 'grow',
    label: 'croissance par rebond · 1.005 à 1.2',
    min: 1.005,
    max: 1.2,
    step: 0.005,
    tagline:
      'Une bille dans un cercle rouge. Elle grossit et accélère à chaque rebond, et peint sa propre trace jusqu’à remplir le cercle.',
  },
  bounce: {
    param: 'burstAfter',
    label: 'éclatement à (s) · 10 à 120',
    min: 10,
    max: 120,
    step: 0.5,
    tagline:
      'Une bille dans un cercle. Elle grossit d’un cran fixe à chaque rebond, jusqu’à faire éclater la paroi.',
  },
};

const DEFAULT_SIM = 'bouncing';
const simId = new URLSearchParams(location.search).get('sim') ?? DEFAULT_SIM;
const sim = getSim(KNOBS[simId] ? simId : DEFAULT_SIM);
const knob = KNOBS[sim.config.id] ?? KNOBS[DEFAULT_SIM];
const sounds = new SoundBank();

const el = <T extends HTMLElement>(id: string) => document.getElementById(id) as T;

const canvas = el<HTMLCanvasElement>('stage');
canvas.width = sim.config.width;
canvas.height = sim.config.height;
const ctx = canvas.getContext('2d', { alpha: false }) as unknown as Ctx2D;

const ui = {
  duration: el<HTMLInputElement>('f-duration'),
  knob: el<HTMLInputElement>('f-knob'),
  knobLabel: el<HTMLElement>('f-knob-label'),
  seed: el<HTMLInputElement>('f-seed'),
  play: el<HTMLButtonElement>('b-play'),
  shuffle: el<HTMLButtonElement>('b-shuffle'),
  replay: el<HTMLButtonElement>('b-replay'),
  sound: el<HTMLButtonElement>('b-sound'),
  exportBtn: el<HTMLButtonElement>('b-export'),
  save: el<HTMLButtonElement>('b-save'),
  progress: el<HTMLElement>('export-progress'),
  bar: el<HTMLElement>('export-bar'),
  status: el<HTMLElement>('export-status'),
  bounces: el<HTMLElement>('v-bounces'),
  clock: el<HTMLElement>('v-clock'),
  hint: el<HTMLElement>('audio-hint'),
  tagline: el<HTMLElement>('tagline'),
};

ui.knobLabel.textContent = knob.label;
ui.knob.min = String(knob.min);
ui.knob.max = String(knob.max);
ui.knob.step = String(knob.step);
ui.tagline.textContent = knob.tagline;

let overrides: Partial<SimConfig> = readUrl();
let world = new World(sim, overrides);
let playing = true;
let seedCounter = 0;

// ------------------------------------------------------------------- lecture

let audioCtx: AudioContext | null = null;
let master: GainNode | null = null;
let consumed = 0;
let audioOrigin = 0;
let muted = false;

function armAudio(): void {
  if (!audioCtx) {
    // Le même contexte que la banque de sons : iOS en plafonne le nombre, et
    // un AudioBuffer décodé ailleurs n'est pas garanti jouable ici.
    audioCtx = sounds.context();
    master = audioCtx.createGain();
    master.gain.value = 0.6;
    master.connect(audioCtx.destination);
    ui.hint.hidden = true;
  }
  void audioCtx.resume();
  // Le décodage lancé au chargement de la page échoue sur iOS tant que le
  // contexte dort. Ce geste est la première occasion de le réveiller : on
  // réessaie donc ici, et `load` ne refait que ce qui manque.
  const assets = sim.assets ?? [];
  if (assets.length && !sounds.ready(assets)) void sounds.load(assets);
  audioOrigin = audioCtx.currentTime - world.time;
}

function drainAudio(): void {
  const events = world.audio.events;
  if (!audioCtx || !master) {
    consumed = events.length;
    return;
  }
  while (consumed < events.length) {
    const ev = events[consumed];
    consumed++;
    if (muted) continue;
    try {
      const when = Math.max(audioCtx.currentTime, audioOrigin + ev.t);
      const pan = audioCtx.createStereoPanner();
      pan.pan.value = ev.pan;
      pan.connect(master);

      if (ev.sample) {
        const buffer = sounds.get(ev.sample);
        if (!buffer) continue;
        const src = audioCtx.createBufferSource();
        src.buffer = buffer;
        src.playbackRate.value = Math.max(0.05, ev.rate ?? 1);
        const g = audioCtx.createGain();
        g.gain.value = ev.gain;
        src.connect(g).connect(pan);
        src.start(when);
      } else {
        const osc = audioCtx.createOscillator();
        osc.type = ev.voice === 'thud' ? 'sine' : 'triangle';
        osc.frequency.setValueAtTime(ev.freq, when);
        const g = audioCtx.createGain();
        g.gain.setValueAtTime(0, when);
        g.gain.linearRampToValueAtTime(ev.gain * 0.6, when + 0.0025);
        g.gain.exponentialRampToValueAtTime(0.0001, when + ev.decay * 4);
        osc.connect(g).connect(pan);
        osc.start(when);
        osc.stop(when + ev.decay * 4 + 0.05);
      }
    } catch {
      // Une note refusée est abandonnée : jamais rejouée en boucle.
    }
  }
}

// -------------------------------------------------------------------- rendu

function paint(): void {
  world.render(ctx);

  const probe = sim.probe?.(world.state);
  if (probe) {
    ui.bounces.textContent = String(probe.count);
    // L'accent de l'interface suit la bille : la page change de couleur en
    // même temps que la simulation.
    if (probe.accent) document.documentElement.style.setProperty('--accent', probe.accent);
  }
  ui.clock.textContent = `${world.time.toFixed(1)} / ${world.config.duration.toFixed(1)} s`;
  drainAudio();
}

function restart(seed?: string): void {
  if (seed !== undefined) overrides = { ...overrides, seed };
  world = new World(sim, overrides);
  consumed = 0;
  if (audioCtx) audioOrigin = audioCtx.currentTime;
  syncPanel();
  paint();
}

let lastWall = 0;
let accumulator = 0;

function loop(now: number): void {
  requestAnimationFrame(loop);

  if (lastWall === 0) lastWall = now;
  const wallDelta = Math.min(0.25, (now - lastWall) / 1000);
  lastWall = now;
  if (!playing) return;

  const step = 1 / world.config.fps;
  accumulator += wallDelta;
  let steps = 0;
  try {
    while (accumulator >= step && steps < 6) {
      if (world.done) restart();
      world.advanceFrame();
      accumulator -= step;
      steps++;
    }
    if (accumulator > step * 6) accumulator = 0;
    if (steps > 0) paint();
  } catch (err) {
    playing = false;
    ui.play.textContent = 'Erreur';
    console.error(err);
  }
}

// ----------------------------------------------------------------- panneau

function readUrl(): Partial<SimConfig> {
  const q = new URLSearchParams(location.search);
  const o: Partial<SimConfig> = {};
  const seed = q.get('seed');
  const duration = q.get('duration');
  const raw = q.get(knob.param);
  if (seed) o.seed = seed;
  if (duration && Number.isFinite(Number(duration))) o.duration = Number(duration);
  if (raw && Number.isFinite(Number(raw))) o.params = { [knob.param]: Number(raw) };
  return o;
}

function syncPanel(): void {
  const c = world.config;
  ui.duration.value = String(Number(c.duration.toFixed(1)));
  ui.knob.value = String(c.params[knob.param] ?? 0);
  ui.seed.value = c.seed;

  const q = new URLSearchParams({
    sim: c.id,
    seed: c.seed,
    duration: String(Number(c.duration.toFixed(1))),
    [knob.param]: String(c.params[knob.param] ?? 0),
  });
  history.replaceState(null, '', `?${q}`);
}

/** Le champ modifié devient la consigne, l'autre se recalcule. */
function apply(changed: 'duration' | 'knob' | 'seed'): void {
  const next: Partial<SimConfig> = { ...overrides };
  next.seed = ui.seed.value.trim() || world.config.seed;

  if (changed === 'duration') {
    const v = Number(ui.duration.value);
    if (Number.isFinite(v)) next.duration = v;
    // La durée demandée doit primer : on retire la surcharge du réglage, sinon
    // `resolveConfig` recalculerait une durée à partir de lui.
    const { [knob.param]: _drop, ...rest } = next.params ?? {};
    next.params = rest;
  } else if (changed === 'knob') {
    const v = Number(ui.knob.value);
    if (Number.isFinite(v)) next.params = { ...next.params, [knob.param]: v };
    delete next.duration;
  }

  overrides = next;
  playing = true;
  ui.play.textContent = 'Pause';
  lastWall = 0;
  accumulator = 0;
  restart();
}

// ------------------------------------------------------------------- export

let exporting = false;
let abort: AbortController | null = null;

/**
 * L'état de la bande-son est annoncé, jamais supposé : c'est la seule façon de
 * distinguer un problème de muxage d'un échantillon qui n'a pas pu être lu.
 */
const AUDIO_NOTE: Record<AudioOutcome, string> = {
  ok: '',
  'synthétisée': ' · échantillon illisible, impacts synthétisés',
  silencieuse: ' · PISTE SILENCIEUSE',
  absente: ' · SANS piste audio',
};

const STAGE_LABEL: Record<ExportStage, string> = {
  video: 'Encodage de l’image',
  audio: 'Encodage du son',
  assemblage: 'Assemblage du fichier',
};

async function runExport(): Promise<void> {
  if (exporting) {
    abort?.abort();
    return;
  }

  exporting = true;
  abort = new AbortController();
  pending = null;
  ui.save.hidden = true;
  const wasPlaying = playing;
  playing = false;
  ui.exportBtn.textContent = 'Annuler';
  ui.status.textContent = 'Préparation…';
  ui.bar.style.width = '0%';

  const resolved = resolveSimConfig(sim, overrides);
  const seconds = resolved.duration;

  try {
    const { blob, audio, audioDetail } = await exportMp4({
      sim,
      overrides,
      sounds,
      signal: abort.signal,
      onProgress: (stage, ratio) => {
        // L'image représente l'essentiel du travail ; la barre le reflète
        // plutôt que de donner trois segments qui repartent de zéro.
        const weight = stage === 'video' ? ratio * 0.86 : stage === 'audio' ? 0.86 + ratio * 0.12 : 0.98 + ratio * 0.02;
        ui.bar.style.width = `${(weight * 100).toFixed(1)}%`;
        ui.status.textContent = `${STAGE_LABEL[stage]} · ${Math.round(weight * 100)} %`;
      },
    });

    ui.status.textContent =
      `Prêt · ${(blob.size / 1024 / 1024).toFixed(1)} Mo${AUDIO_NOTE[audio]}` +
      `
${audioDetail}`;
    const name = `${resolved.id}-${resolved.seed}-${Math.round(seconds)}s.mp4`;
    await deliver(blob, name);
  } catch (err) {
    const aborted = err instanceof DOMException && err.name === 'AbortError';
    ui.status.textContent = aborted
      ? 'Export annulé.'
      : `Échec de l’export : ${err instanceof Error ? err.message : String(err)}`;
    if (!aborted) console.error(err);
  } finally {
    exporting = false;
    abort = null;
    ui.exportBtn.textContent = 'Exporter en mp4';
    playing = wasPlaying;
    lastWall = 0;
    accumulator = 0;
    ui.bar.style.width = '0%';
  }
}

/**
 * iOS et iPadOS, y compris l'iPad qui se déclare « MacIntel ».
 *
 * Sur ces appareils un téléchargement classique atterrit dans Fichiers, jamais
 * dans Photos. Seule la feuille de partage propose « Enregistrer la vidéo »,
 * qui écrit dans la pellicule.
 */
const IOS =
  /iPad|iPhone|iPod/.test(navigator.userAgent) ||
  (navigator.platform === 'MacIntel' && navigator.maxTouchPoints > 1);

function videoFile(blob: Blob, filename: string): File {
  return new File([blob], filename, { type: 'video/mp4' });
}

function canShareVideo(blob: Blob, filename: string): boolean {
  if (typeof navigator.canShare !== 'function' || typeof navigator.share !== 'function') {
    return false;
  }
  try {
    return navigator.canShare({ files: [videoFile(blob, filename)] });
  } catch {
    return false;
  }
}

type Downloads = { save(r: { filename: string; data: Blob }): Promise<unknown> };

let downloads: Downloads | null = null;
let hosted = false;

/**
 * Vérifie dès le chargement par où le fichier pourra sortir.
 *
 * Une page publiée ne peut remettre un fichier que par le canal `downloads` :
 * un lien de téléchargement classique y est inerte. Mieux vaut le savoir tout
 * de suite que de laisser quelqu'un attendre deux minutes d'encodage pour
 * découvrir que rien ne peut être livré.
 */
async function probeDelivery(): Promise<void> {
  ui.progress.hidden = false;
  // Un navigateur sans WebCodecs a déjà posé son message : ne pas l'écraser par
  // un état de livraison qui ne servira jamais.
  if (ui.exportBtn.disabled) return;

  const claude = (window as unknown as { claude?: { use(n: string): Promise<Downloads | null> } }).claude;
  const format = `Sortie ${sim.config.width}×${sim.config.height}, ${sim.config.fps} i/s`;

  if (!claude?.use) {
    ui.status.textContent = format;
    return;
  }

  hosted = true;
  ui.status.textContent = `${format} · vérification…`;
  downloads = await claude.use('downloads');
  if (downloads) {
    ui.status.textContent = `${format} · enregistrement prêt`;
  } else {
    ui.status.textContent = "Enregistrement indisponible ici : l’export ne pourrait pas être remis.";
    ui.exportBtn.disabled = true;
  }
}

/** Fichier prêt, en attente du geste qui l'enregistrera. */
let pending: { blob: Blob; filename: string } | null = null;

/**
 * Arme le bouton d'enregistrement au lieu de partager tout de suite.
 *
 * `navigator.share` exige une activation utilisateur, et l'encodage a
 * largement consommé celle du clic d'export : partager ici lèverait
 * `NotAllowedError`. Le geste doit donc venir après, sur un bouton dédié.
 */
function armSave(blob: Blob, filename: string): void {
  pending = { blob, filename };
  ui.save.hidden = false;
  ui.status.textContent = 'Vidéo prête · enregistre-la dans Photos.';
}

async function runSave(): Promise<void> {
  if (!pending) return;
  const { blob, filename } = pending;
  try {
    await navigator.share({ files: [videoFile(blob, filename)] });
    ui.status.textContent = 'Feuille de partage ouverte · choisis « Enregistrer la vidéo ».';
  } catch (err) {
    // Un partage refusé n'est pas une panne : on ne perd pas le fichier.
    if (err instanceof DOMException && err.name === 'AbortError') {
      ui.status.textContent = 'Enregistrement annulé. La vidéo est toujours prête.';
      return;
    }
    ui.status.textContent = 'Partage indisponible · téléchargement du fichier.';
    downloadViaAnchor(blob, filename);
  }
}

function downloadViaAnchor(blob: Blob, filename: string): void {
  if (IOS && canShareVideo(blob, filename)) {
    armSave(blob, filename);
    return;
  }

  downloadViaAnchor(blob, filename);
}

/** Remet le fichier par le canal disponible. */
async function deliver(blob: Blob, filename: string): Promise<void> {
  if (hosted && downloads) {
    try {
      await downloads.save({ filename, data: blob });
      ui.status.textContent = 'Vidéo enregistrée.';
    } catch (err) {
      const code = (err as { code?: string })?.code;
      ui.status.textContent =
        code === 'declined'
          ? 'Enregistrement annulé. La vidéo est prête, relance quand tu veux.'
          : `Enregistrement impossible : ${(err as Error)?.message ?? String(err)}`;
    }
    return;
  }

  const url = URL.createObjectURL(blob);
  const a = document.createElement('a');
  a.href = url;
  a.download = filename;
  a.click();
  setTimeout(() => URL.revokeObjectURL(url), 30_000);
  ui.status.textContent = 'Vidéo téléchargée.';
}

// -------------------------------------------------------------------- liens

ui.duration.addEventListener('change', () => apply('duration'));
ui.knob.addEventListener('change', () => apply('knob'));
ui.seed.addEventListener('change', () => apply('seed'));

ui.play.addEventListener('click', () => {
  playing = !playing;
  ui.play.textContent = playing ? 'Pause' : 'Lecture';
  lastWall = 0;
  accumulator = 0;
  armAudio();
});
ui.replay.addEventListener('click', () => {
  armAudio();
  restart();
});
ui.shuffle.addEventListener('click', () => {
  seedCounter++;
  armAudio();
  restart(`${sim.config.seed}-${seedCounter}`);
});
ui.sound.addEventListener('click', () => {
  armAudio();
  muted = !muted;
  ui.sound.textContent = muted ? 'Son coupé' : 'Son actif';
  ui.sound.setAttribute('aria-pressed', String(!muted));
});
ui.exportBtn.addEventListener('click', () => void runExport());
ui.save.addEventListener('click', () => void runSave());
canvas.addEventListener('click', () => {
  armAudio();
  playing = !playing;
  ui.play.textContent = playing ? 'Pause' : 'Lecture';
});

document.addEventListener('keydown', (e) => {
  const t = e.target as HTMLElement | null;
  if (t && (t.tagName === 'INPUT' || t.tagName === 'BUTTON')) return;
  if (e.key === ' ') {
    e.preventDefault();
    ui.play.click();
  } else if (e.key === 'r') ui.replay.click();
  else if (e.key === 's') ui.shuffle.click();
  else if (e.key === 'm') ui.sound.click();
});

if (!canExport()) {
  ui.exportBtn.disabled = true;
  ui.exportBtn.textContent = 'Export indisponible ici';
  ui.status.textContent =
    'Ce navigateur n’a pas WebCodecs. L’export mp4 fonctionne sur Chrome, Edge et Safari 17+.';
}

void sounds.load(sim.assets ?? []);
void probeDelivery();
syncPanel();
paint();
requestAnimationFrame(loop);
