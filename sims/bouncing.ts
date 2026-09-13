import type {
  Body,
  DrawCtx,
  InitCtx,
  Palette,
  Rng,
  Sim,
  SimConfig,
  SimProbe,
  StepCtx,
  Surface,
} from '../engine/index.ts';
import {
  clamp,
  counterAnchor,
  createRng,
  createSurface,
  drawHud,
  fonts,
  playSample,
  TAU,
} from '../engine/index.ts';

/**
 * « Bouncing ball but every bounce it gets bigger and faster ».
 *
 * Une bille dans un cercle rouge, sous pesanteur constante, sans aucune perte :
 * à chaque rebond elle grossit d'un cran, accélère d'un cran, et avance d'un
 * cran sur la roue chromatique. Le cercle se remplit de ses propres traces
 * jusqu'à ce qu'elle n'ait plus la place d'exister.
 *
 * L'élément central du rendu n'est pas la bille mais sa TRACE : chaque image,
 * la bille est estampée définitivement sur une surface qui n'est jamais
 * effacée. Les disques se chevauchent, leur contour noir les sépare, et il en
 * sort des rubans de couleur en « chenille ».
 */

// --------------------------------------------------------------------------
// Constantes de rendu
// --------------------------------------------------------------------------

/** Rayon de collision. La SURFACE de la bille le touche, pas son centre. */
const ARENA_R = 420;
/** Épaisseur du contour rouge. */
const RING_W = 14;
const RING_COLOR = '#FF0000';

const START_R = 14;
/** Décalage du point de départ par rapport au centre. */
const START_OFFSET = 60;

/**
 * Le cahier des charges est exprimé en px/frame à 60 i/s, alors que le moteur
 * intègre en secondes. On convertit une fois, à l'initialisation, pour que la
 * sim donne le même mouvement à n'importe quel `fps`.
 */
const START_SPEED_PF = 6;
const GRAVITY_PF2 = 0.35;

/** Contour noir de chaque estampe : c'est lui qui découpe la chenille. */
const STAMP_STROKE = 3;

/** Fin de partie : la bille occupe cette fraction du rayon de l'arène. */
const END_FRACTION = 0.92;
/** Fondu final, en secondes. */
const FADE_SECONDS = 1;

const POP_SECONDS = 0.6;
const POP_Y = 462;
const POP_RISE = 62;
const POP_SPREAD = 90;
const MAX_POPS = 5;

const HUD_VALUE_SIZE = 150;
/**
 * Libellé dessiné ici plutôt que confié à `drawHud` : celui-ci le pose à 42 px
 * et à 0,62 × la taille du chiffre, ce qui le collait au compteur et ne se lit
 * pas comme le petit libellé gris attendu. Le HUD partagé reste inchangé pour
 * la sim `bounce`, qui en dépend.
 */
const HUD_LABEL_SIZE = 30;
const HUD_LABEL_Y = 350;

/** Bruitage d'impact. Cherché dans `assets/` puis à la racine du projet. */
const BOUNCE_SOUND = 'dry-fart.mp3';

/**
 * Gamme pentatonique majeure, bouclée sur l'octave. Sert de vitesse de lecture
 * de l'échantillon : la hauteur monte d'un cran à chaque rebond puis repart du
 * bas une fois l'octave atteinte.
 */
const SCALE: readonly number[] = [0, 2, 4, 7, 9, 12];

/**
 * Palette figée : fond noir pur, chiffre blanc, libellé gris. La seule couleur
 * de l'image est celle de la bille, qui n'a donc pas sa place ici.
 */
const PALETTE: Palette = {
  color: () => '#FFFFFF',
  colorAlpha: (_i, a) => `rgba(255,255,255,${a.toFixed(3)})`,
  background: '#000000',
  ink: '#FFFFFF',
  dim: '#8A8A96',
};

// --------------------------------------------------------------------------
// État
// --------------------------------------------------------------------------

interface Ball extends Body {
  /** Teinte courante, en degrés. */
  hue: number;
}

interface Arena {
  cx: number;
  cy: number;
  r: number;
}

/**
 * Physique nue, partagée à l'identique par la pré-simulation et le rendu.
 * Ne contient rien de graphique ni de sonore : c'est ce qui garantit que la
 * durée annoncée est exactement celle du rendu.
 */
interface Core {
  ball: Ball;
  arena: Arena;
  /** px/s². */
  gravity: number;
  bounces: number;
  /** Compté en sous-pas, jamais en images : voir `contain`. */
  cooldown: number;
  grow: number;
  speedup: number;
  hueStep: number;
}

interface Pop {
  frame: number;
  dx: number;
}

interface State {
  core: Core;
  /** Surface jamais effacée : toute la peinture accumulée. */
  trail: Surface;
  pops: Pop[];
  /** Image à laquelle la bille a rempli le cercle. -1 tant que ça tourne. */
  endFrame: number;
  lastBounceFrame: number;
}

export const config: SimConfig = {
  id: 'bouncing',
  title: 'bouncing ball',
  width: 1080,
  height: 1920,
  fps: 60,
  // Recalculée par resolveConfig : la partie s'arrête quand la bille remplit
  // le cercle, pas à une date choisie.
  duration: 32,
  // 32 sous-pas. Borne la distance dont la bille peut franchir la paroi avant
  // qu'on la détecte : au plus fort, à ~4500 px/s, elle n'avance que de 2,3 px
  // par sous-pas. À 4 sous-pas elle s'enfonçait de 15 px, mesuré.
  substeps: 32,
  // Graine par défaut choisie pour tomber à ~29 s, dans la fenêtre utile d'un
  // Reel. La durée dépend entièrement de la trajectoire, donc de la graine.
  seed: 'bouncing-007',
  params: {
    /** Rayon multiplié par ce facteur à chaque rebond. */
    grow: 1.035,
    /** Norme de la vitesse multipliée par ce facteur à chaque rebond. */
    speedup: 1.02,
    /** Degrés de teinte gagnés à chaque rebond. */
    hueStep: 7,
    /** Secondes conservées après le fondu final. */
    tail: 1.5,
  },
};

function ballColor(hue: number): string {
  return `hsl(${(((hue % 360) + 360) % 360).toFixed(1)}, 100%, 55%)`;
}

// --------------------------------------------------------------------------
// Physique
// --------------------------------------------------------------------------

/**
 * Même ordre de tirage que dans la pré-simulation, donc mêmes conditions
 * initiales : les deux décrivent la même trajectoire.
 */
function makeCore(cfg: SimConfig, rng: Rng): Core {
  const arena: Arena = { cx: cfg.width / 2, cy: cfg.height / 2, r: ARENA_R };
  const a0 = rng.next() * TAU;
  const a1 = rng.next() * TAU;
  const speed = START_SPEED_PF * cfg.fps;
  return {
    ball: {
      x: arena.cx + Math.cos(a0) * START_OFFSET,
      y: arena.cy + Math.sin(a0) * START_OFFSET,
      vx: Math.cos(a1) * speed,
      vy: Math.sin(a1) * speed,
      r: START_R,
      hue: rng.next() * 360,
    },
    arena,
    gravity: GRAVITY_PF2 * cfg.fps * cfg.fps,
    bounces: 0,
    cooldown: 0,
    grow: cfg.params.grow,
    speedup: cfg.params.speedup,
    hueStep: cfg.params.hueStep,
  };
}

function finished(c: Core): boolean {
  return c.ball.r >= c.arena.r * END_FRACTION;
}

/**
 * Contact avec la paroi. Trois points sans lesquels la simulation se dérègle :
 *
 * 1. La bille est REPOSITIONNÉE sur le point de contact avant toute décision.
 *    Sans ça elle reste collée au bord et le compteur s'emballe.
 * 2. On ne réfléchit que si elle va effectivement vers la paroi (`vn > 0`).
 *    C'est ce test, et non le cooldown, qui rend une double détection
 *    impossible : après réflexion `vn` est négatif.
 * 3. Le cooldown est compté en SOUS-PAS. En fin de course il tombe jusqu'à
 *    trois rebonds dans la même image ; un cooldown d'une image entière en
 *    avalerait deux sur trois.
 *
 * Renvoie la normale si un rebond a eu lieu, `null` sinon.
 */
function contain(c: Core): { nx: number; ny: number } | null {
  const b = c.ball;
  const a = c.arena;
  const dx = b.x - a.cx;
  const dy = b.y - a.cy;
  const d = Math.hypot(dx, dy) || 1e-9;
  if (d + b.r < a.r) return null;

  const nx = dx / d;
  const ny = dy / d;
  b.x = a.cx + nx * (a.r - b.r);
  b.y = a.cy + ny * (a.r - b.r);

  const vn = b.vx * nx + b.vy * ny;
  if (vn <= 0) return null;
  if (c.cooldown > 0) return null;

  // v' = v - 2(v·n)n
  b.vx -= 2 * vn * nx;
  b.vy -= 2 * vn * ny;

  c.bounces++;
  b.r *= c.grow;
  b.vx *= c.speedup;
  b.vy *= c.speedup;
  b.hue += c.hueStep;

  // Le rayon vient d'augmenter alors que la bille était pile au contact : sans
  // ce second recollage elle s'enfonce d'un cran de croissance dans la paroi à
  // chaque rebond, cumulativement.
  b.x = a.cx + nx * (a.r - b.r);
  b.y = a.cy + ny * (a.r - b.r);

  c.cooldown = 1;
  return { nx, ny };
}

/** Un sous-pas d'intégration. Renvoie la normale du rebond, s'il y en a eu. */
function integrate(c: Core, h: number): { nx: number; ny: number } | null {
  const b = c.ball;
  b.vy += c.gravity * h;
  b.x += b.vx * h;
  b.y += b.vy * h;
  if (c.cooldown > 0) c.cooldown--;
  return contain(c);
}

// --------------------------------------------------------------------------
// Durée : la partie s'arrête d'elle-même, il faut donc la mesurer
// --------------------------------------------------------------------------

/**
 * Rejoue la physique seule — sans trace, sans son, sans dessin — pour savoir
 * en combien d'images la bille remplit le cercle. Pure et déterministe.
 */
function runFrames(cfg: SimConfig): number {
  const c = makeCore(cfg, createRng(cfg.seed).fork('core'));
  const h = 1 / (cfg.fps * cfg.substeps);
  const limit = cfg.fps * 600;

  for (let frame = 0; frame < limit; frame++) {
    for (let s = 0; s < cfg.substeps; s++) {
      integrate(c, h);
      if (finished(c)) return frame + 1;
    }
  }
  return limit;
}

/**
 * La recherche coûte quelques dizaines de millisecondes et ne dépend que de la
 * configuration. En preview la sim est reconstruite à chaque bouclage, et
 * repayer la mesure y provoquerait un à-coup visible.
 */
const lengthCache = new Map<string, number>();

function runFramesFor(cfg: SimConfig): number {
  const key = [
    cfg.seed,
    cfg.fps,
    cfg.substeps,
    cfg.width,
    cfg.height,
    cfg.params.grow,
    cfg.params.speedup,
  ].join('|');
  const hit = lengthCache.get(key);
  if (hit !== undefined) return hit;
  const value = runFrames(cfg);
  lengthCache.set(key, value);
  return value;
}

/**
 * La durée n'est pas un réglage libre : elle est dictée par la physique. On la
 * mesure, sauf si une durée est explicitement demandée — auquel cas la vidéo
 * coupe plus tôt, ou tient sur l'image finale plus longtemps.
 */
function resolveConfig(cfg: SimConfig, overrides: Partial<SimConfig>): SimConfig {
  const grow = clamp(cfg.params.grow, 1.001, 1.2);
  const speedup = clamp(cfg.params.speedup, 1, 1.2);
  const tail = Math.max(0, cfg.params.tail);
  const params = { ...cfg.params, grow, speedup, tail };

  if (overrides.duration !== undefined) return { ...cfg, params };

  const seconds = runFramesFor({ ...cfg, params }) / cfg.fps;
  return { ...cfg, duration: seconds + FADE_SECONDS + tail, params };
}

// --------------------------------------------------------------------------
// Sim
// --------------------------------------------------------------------------

function init(ctx: InitCtx): State {
  return {
    core: makeCore(ctx.config, ctx.rng.fork('core')),
    trail: createSurface(ctx.config.width, ctx.config.height),
    pops: [],
    endFrame: -1,
    lastBounceFrame: -999,
  };
}

/**
 * Estampe la bille sur la trace, une fois par image, à sa position de fin
 * d'image. C'est le pas entre deux estampes qui donne les écailles de la
 * chenille : le faire à chaque sous-pas donnerait un ruban lisse.
 */
function stamp(s: State): void {
  const g = s.trail.ctx;
  const b = s.core.ball;
  g.beginPath();
  g.arc(b.x, b.y, b.r, 0, TAU);
  g.fillStyle = ballColor(b.hue);
  g.fill();
  g.lineWidth = STAMP_STROKE;
  g.strokeStyle = '#000000';
  g.stroke();
}

function step(s: State, ctx: StepCtx): void {
  if (s.endFrame >= 0) return;

  const hit = integrate(s.core, ctx.h);

  if (hit) {
    s.lastBounceFrame = ctx.frame;
    s.pops.push({ frame: ctx.frame, dx: ctx.rng.range(-POP_SPREAD / 2, POP_SPREAD / 2) });
    // En fin de course les rebonds tombent à plusieurs par image : sans
    // plafond ni décalage, les « +1 » s'empilent au même pixel.
    if (s.pops.length > MAX_POPS) s.pops.shift();

    playSample(ctx.audio, ctx.t, {
      sample: BOUNCE_SOUND,
      gain: 0.85,
      xNorm: s.core.ball.x / ctx.config.width,
      rate: Math.pow(2, SCALE[(s.core.bounces - 1) % SCALE.length] / 12),
    });

    if (finished(s.core)) s.endFrame = ctx.frame;
  }

  // Dernier sous-pas de l'image, ou image où la partie s'achève.
  if (ctx.substep === ctx.substeps - 1 || s.endFrame >= 0) stamp(s);
}

function disc(d: DrawCtx, x: number, y: number, r: number, color: string, outline: boolean): void {
  const { ctx } = d;
  ctx.beginPath();
  ctx.arc(x, y, Math.max(0, r), 0, TAU);
  ctx.fillStyle = color;
  ctx.fill();
  if (outline) {
    ctx.lineWidth = STAMP_STROKE;
    ctx.strokeStyle = '#000000';
    ctx.stroke();
  }
}

/**
 * Le tracé est centré sur `ARENA_R + RING_W / 2` : le bord INTÉRIEUR de
 * l'anneau tombe donc pile sur le rayon de collision, et la bille le touche
 * visuellement au lieu de le chevaucher.
 */
function ring(d: DrawCtx, a: Arena): void {
  const { ctx } = d;
  ctx.beginPath();
  ctx.arc(a.cx, a.cy, a.r + RING_W / 2, 0, TAU);
  ctx.lineWidth = RING_W;
  ctx.strokeStyle = RING_COLOR;
  ctx.stroke();
}

function draw(s: State, d: DrawCtx): void {
  const { ctx, width, height, frame, config: cfg } = d;
  const c = s.core;
  const b = c.ball;

  ctx.fillStyle = PALETTE.background;
  ctx.fillRect(0, 0, width, height);

  const fade =
    s.endFrame < 0 ? 0 : clamp((frame - s.endFrame) / (FADE_SECONDS * cfg.fps), 0, 1);
  const eased = 1 - Math.pow(1 - fade, 3);

  // 1) la trace accumulée, qui s'efface pendant le fondu final.
  ctx.save();
  ctx.globalAlpha = 1 - eased;
  ctx.drawImage(s.trail.image, 0, 0);
  ctx.restore();

  // 2) l'anneau rouge par-dessus : il doit toujours rester net.
  ring(d, c.arena);

  // 3) la bille.
  if (s.endFrame < 0) {
    disc(d, b.x, b.y, b.r, ballColor(b.hue), true);
  } else {
    // Elle grossit jusqu'à remplir tout le cercle, sans mordre sur l'anneau,
    // qu'on repasse ensuite pour le garder franc.
    const inner = c.arena.r - RING_W / 2;
    disc(d, c.arena.cx, c.arena.cy, b.r + (inner - b.r) * eased, ballColor(b.hue), false);
    ring(d, c.arena);
  }

  // 4) l'interface : le compteur, et rien d'autre.
  const pulse = clamp(1 - (frame - s.lastBounceFrame) / (0.18 * cfg.fps), 0, 1);
  drawHud(ctx, width, height, {
    value: c.bounces,
    palette: PALETTE,
    valueColor: PALETTE.ink,
    valueSize: HUD_VALUE_SIZE,
    pulse,
  });

  const anchor = counterAnchor(width);
  ctx.textAlign = 'center';
  ctx.textBaseline = 'alphabetic';
  ctx.font = `700 ${HUD_LABEL_SIZE}px ${fonts.display}`;
  ctx.fillStyle = PALETTE.dim;
  ctx.fillText('BOUNCES', anchor.x, HUD_LABEL_Y);

  ctx.font = `800 40px ${fonts.display}`;
  for (const p of s.pops) {
    const k = (frame - p.frame) / (POP_SECONDS * cfg.fps);
    if (k < 0 || k > 1) continue;
    ctx.save();
    ctx.globalAlpha = 1 - k;
    ctx.fillStyle = PALETTE.ink;
    ctx.fillText('+1', anchor.x + p.dx, POP_Y - k * POP_RISE);
    ctx.restore();
  }
}

function probe(s: State): SimProbe {
  return {
    bodies: [s.core.ball],
    count: s.core.bounces,
    accent: ballColor(s.core.ball.hue),
  };
}

const sim: Sim<State> = {
  config,
  assets: [BOUNCE_SOUND],
  resolveConfig,
  init,
  step,
  draw,
  probe,
};

export default sim;
