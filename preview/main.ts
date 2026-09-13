import type { Ctx2D, SimConfig } from '../engine/types.ts';
import { World } from '../engine/world.ts';
import { getSim, SIMS } from '../sims/registry.ts';
import { installBrowserSurfaces } from './browser-surface.ts';
import { PreviewAudio } from './audio-player.ts';

/**
 * Pilote de preview.
 *
 * C'est le SEUL fichier du projet qui appelle requestAnimationFrame, et rAF
 * n'y sert qu'à cadencer : il décide *quand* appeler `World.advanceFrame()`,
 * jamais *de combien* le temps avance. La simulation ne voit donc rigoureusement
 * que la même suite de pas fixes qu'en rendu headless — à image égale, l'image
 * affichée ici est celle qui sortira dans le mp4.
 */

installBrowserSurfaces();

const params = new URLSearchParams(location.search);
const simId = params.get('sim') ?? 'bounce';
const sim = getSim(simId);

function overridesFromUrl(): Partial<SimConfig> {
  const o: Partial<SimConfig> = {};
  const seed = params.get('seed');
  const duration = params.get('duration');
  const fps = params.get('fps');
  const substeps = params.get('substeps');
  const title = params.get('title');
  if (seed) o.seed = seed;
  if (duration) o.duration = Number(duration);
  if (fps) o.fps = Number(fps);
  if (substeps) o.substeps = Number(substeps);
  if (title) o.title = title;

  // Tout paramètre d'URL non reconnu ci-dessus est traité comme un réglage de
  // sim : `?burst=45` arrive dans params.burstAfter, `?p.foo=3` dans params.foo.
  const RESERVED = new Set(['sim', 'seed', 'duration', 'fps', 'substeps', 'title']);
  const simParams: Record<string, number> = {};
  for (const [key, value] of params.entries()) {
    if (RESERVED.has(key)) continue;
    const n = Number(value);
    if (!Number.isFinite(n)) continue;
    simParams[key === 'burst' ? 'burstAfter' : key.replace(/^p\./, '')] = n;
  }
  if (Object.keys(simParams).length > 0) o.params = simParams;
  return o;
}

let overrides = overridesFromUrl();
let seedCounter = 0;

const canvas = document.getElementById('stage') as HTMLCanvasElement;
canvas.width = (overrides.width ?? sim.config.width);
canvas.height = (overrides.height ?? sim.config.height);
const ctx = canvas.getContext('2d') as unknown as Ctx2D;

const audio = new PreviewAudio();
// Téléchargés tout de suite ; le décodage attendra l'AudioContext, donc le
// premier clic. Sans préchargement les premiers impacts seraient muets.
void audio.preload(sim.assets ?? []);
let world = new World(sim, overrides);
let playing = true;
let loopAtEnd = true;

const hud = {
  sim: document.getElementById('v-sim') as HTMLElement,
  seed: document.getElementById('v-seed') as HTMLElement,
  frame: document.getElementById('v-frame') as HTMLElement,
  fps: document.getElementById('v-fps') as HTMLElement,
  state: document.getElementById('v-state') as HTMLElement,
};

const controls = {
  duration: document.getElementById('c-duration') as HTMLInputElement,
  burst: document.getElementById('c-burst') as HTMLInputElement,
  seed: document.getElementById('c-seed') as HTMLInputElement,
  apply: document.getElementById('c-apply') as HTMLButtonElement,
  cmd: document.getElementById('c-cmd') as HTMLElement,
  copy: document.getElementById('c-copy') as HTMLButtonElement,
};

function restart(newSeed?: string): void {
  if (newSeed !== undefined) overrides = { ...overrides, seed: newSeed };
  world = new World(sim, overrides);
  audio.reset(0);
  syncPanel();
  render();
}

/**
 * Recharge les champs depuis la configuration RÉSOLUE, pas depuis les
 * surcharges : c'est ainsi que modifier la durée fait apparaître l'instant
 * d'éclatement recalculé, et réciproquement.
 */
function syncPanel(): void {
  const c = world.config;
  controls.duration.value = String(Number(c.duration.toFixed(2)));
  controls.seed.value = c.seed;
  const burst = c.params.burstAfter;
  if (burst === undefined) {
    controls.burst.value = '';
    controls.burst.disabled = true;
  } else {
    controls.burst.disabled = false;
    controls.burst.value = String(Number(burst.toFixed(2)));
  }

  const bits = [`node render/cli.ts --sim ${c.id}`, `--seed ${c.seed}`];
  if (burst !== undefined) bits.push(`--burst ${Number(burst.toFixed(2))}`);
  bits.push(`--duration ${Number(c.duration.toFixed(2))}`);
  bits.push(`--out out/${c.id}-${c.seed}.mp4`);
  controls.cmd.textContent = bits.join(' ');

  // L'URL suit l'état pour rester partageable et rechargeable telle quelle.
  const q = new URLSearchParams({ sim: c.id, seed: c.seed });
  if (burst !== undefined) q.set('burst', String(Number(burst.toFixed(2))));
  q.set('duration', String(Number(c.duration.toFixed(2))));
  history.replaceState(null, '', `?${q}`);
}

/** Applique les champs. Le temps modifié devient la consigne, l'autre suit. */
function applyPanel(changed: 'duration' | 'burst' | 'seed' | null): void {
  const next: Partial<SimConfig> = { ...overrides };
  next.seed = controls.seed.value.trim() || world.config.seed;

  const duration = Number(controls.duration.value);
  const burst = Number(controls.burst.value);

  if (changed === 'duration' && Number.isFinite(duration)) {
    next.duration = duration;
    // On retire la consigne d'éclatement pour qu'elle se recalcule à partir de
    // la durée ; sinon les deux resteraient figées et l'un des champs mentirait.
    const { burstAfter: _drop, ...rest } = next.params ?? {};
    next.params = rest;
  } else if (changed === 'burst' && Number.isFinite(burst)) {
    next.params = { ...next.params, burstAfter: burst };
    delete next.duration;
  } else {
    if (Number.isFinite(duration)) next.duration = duration;
    if (Number.isFinite(burst)) next.params = { ...next.params, burstAfter: burst };
  }

  overrides = next;
  playing = true;
  lastWall = 0;
  accumulator = 0;
  restart();
}

function render(): void {
  world.render(ctx);
  // Le panneau est mis à jour avant l'audio : si la programmation WebAudio
  // échoue, le compteur ne doit pas rester figé sur une vieille valeur — un
  // compteur bloqué alors que la simulation tourne est indiscernable d'une
  // boucle morte, et envoie chercher le bug au mauvais endroit.
  hud.sim.textContent = world.config.id;
  hud.seed.textContent = world.config.seed;
  hud.frame.textContent = `${world.frame} / ${world.totalFrames}`;
  hud.state.textContent = playing ? 'lecture' : 'pause';
  audio.drain(world.audio.events);
}

/**
 * Une exception non rattrapée dans le pas de simulation ne casse pas la chaîne
 * rAF (elle est replanifiée en première instruction), mais elle se répéterait
 * silencieusement à chaque image. On met la preview en pause et on l'affiche :
 * un échec visible vaut mieux qu'une image figée sans explication.
 */
function fail(err: unknown): void {
  playing = false;
  hud.state.textContent = 'erreur — voir la console';
  console.error('[preview] la simulation a levé une exception :', err);
}

// Cadence : on accumule le temps mural, mais on ne consomme que des pas
// entiers. Un ralentissement de la machine fait sauter des images à l'écran,
// jamais dériver la physique.
let lastWall = 0;
let accumulator = 0;
let smoothedFps = 0;

function frameLoop(now: number): void {
  // TOUJOURS en première instruction : la prochaine image est réservée avant
  // que quoi que ce soit puisse échouer. En dernière instruction, la première
  // exception romprait la chaîne définitivement et tout se figerait sans bruit.
  requestAnimationFrame(frameLoop);

  if (lastWall === 0) lastWall = now;
  // dt plafonné à 0,25 s : après un onglet en arrière-plan ou une pause du
  // débogueur, `now - lastWall` peut valoir plusieurs minutes. Non plafonné, il
  // remplirait l'accumulateur et la boucle de rattrapage ne se terminerait plus.
  const wallDelta = Math.min(0.25, (now - lastWall) / 1000);
  lastWall = now;
  if (wallDelta > 0) smoothedFps = smoothedFps * 0.9 + (1 / wallDelta) * 0.1;
  hud.fps.textContent = smoothedFps.toFixed(0);

  if (!playing) return;

  const stepDuration = 1 / world.config.fps;
  accumulator += wallDelta;

  // Plafond de rattrapage : mieux vaut ralentir l'affichage que bloquer l'onglet.
  const maxSteps = 6;
  let steps = 0;
  try {
    while (accumulator >= stepDuration && steps < maxSteps) {
      if (world.done) {
        if (loopAtEnd) restart();
        else {
          playing = false;
          break;
        }
      }
      world.advanceFrame();
      accumulator -= stepDuration;
      steps++;
    }
    // Le reliquat est jeté plutôt que reporté : sinon un à-coup se rembourse
    // sur les images suivantes et la boucle ne rattrape jamais son retard.
    if (accumulator > stepDuration * maxSteps) accumulator = 0;

    if (steps > 0) render();
  } catch (err) {
    fail(err);
  }
}

document.addEventListener('keydown', (e) => {
  // Sans ce garde, taper une graine dans le champ déclencherait les raccourcis :
  // le « s » de « seed » relancerait la sim à chaque frappe.
  const target = e.target as HTMLElement | null;
  if (target && (target.tagName === 'INPUT' || target.tagName === 'SELECT')) {
    if (e.key === 'Enter') applyPanel(null);
    return;
  }

  switch (e.key) {
    case ' ':
      e.preventDefault();
      playing = !playing;
      lastWall = 0;
      accumulator = 0;
      audio.resume(world.time);
      break;
    case 'r':
      restart();
      break;
    case 's':
      seedCounter++;
      restart(`${sim.config.seed}-${seedCounter}`);
      break;
    case 'm':
      audio.muted = !audio.muted;
      break;
    case 'ArrowRight':
      playing = false;
      if (!world.done) {
        world.advanceFrame();
        render();
      }
      break;
    case 'l':
      loopAtEnd = !loopAtEnd;
      break;
  }
});

// L'audio ne peut démarrer qu'après une interaction : on l'arme au premier clic.
canvas.addEventListener('click', () => audio.resume(world.time), { once: false });

const picker = document.getElementById('sim-picker') as HTMLSelectElement;
for (const id of Object.keys(SIMS)) {
  const opt = document.createElement('option');
  opt.value = id;
  opt.textContent = id;
  if (id === simId) opt.selected = true;
  picker.appendChild(opt);
}
picker.addEventListener('change', () => {
  params.set('sim', picker.value);
  location.search = params.toString();
});

controls.duration.addEventListener('change', () => applyPanel('duration'));
controls.burst.addEventListener('change', () => applyPanel('burst'));
controls.seed.addEventListener('change', () => applyPanel('seed'));
controls.apply.addEventListener('click', () => applyPanel(null));
controls.copy.addEventListener('click', async () => {
  const text = controls.cmd.textContent ?? '';
  try {
    await navigator.clipboard.writeText(text);
    controls.copy.textContent = 'copié';
  } catch {
    // Le presse-papier est refusé hors contexte sécurisé : on sélectionne le
    // texte pour que la copie manuelle reste possible.
    const range = document.createRange();
    range.selectNodeContents(controls.cmd);
    const sel = window.getSelection();
    sel?.removeAllRanges();
    sel?.addRange(range);
    controls.copy.textContent = 'sélectionné, Ctrl+C';
  }
  setTimeout(() => {
    controls.copy.textContent = 'copier la commande';
  }, 1600);
});

syncPanel();
render();
requestAnimationFrame(frameLoop);
