import type {
  DrawCtx,
  InitCtx,
  LobedWall,
  Palette,
  Rng,
  Sim,
  SimConfig,
  SimProbe,
  SpinBody,
  StepCtx,
} from '../engine/index.ts';
import {
  clamp,
  containInLobedCircle,
  counterAnchor,
  drawHud,
  fonts,
  getPalette,
  ping,
  playSample,
  smoothstep,
  TAU,
} from '../engine/index.ts';

/**
 * Une bille dans un cercle, sous pesanteur terrestre. Elle grossit d'un cran fixe
 * à chaque rebond ; l'espace libre se réduit, le rythme s'accélère, et quand
 * elle n'a plus la place elle fait éclater le cercle et s'échappe.
 *
 * Rendu plat : fond noir, cercle blanc, aplats opaques. La seule couleur est
 * celle de la bille, qui change à chaque impact.
 */

/**
 * Pesanteur terrestre, et une échelle de 240 px pour 1 m — l'arène fait donc
 * environ 3,9 m de diamètre.
 *
 * La pesanteur lunaire donnait des cloches de deux à trois secondes : joli, mais
 * l'œil ne le lit pas comme une chute, il le lit comme un ralenti. À 9,81 m/s²
 * la bille retombe en une demi-seconde et le mouvement redevient crédible.
 */
const PX_PER_M = 240;
const GRAVITY_MS2 = 9.81;

const START_RADIUS = 20;
/** Fraction du rayon de l'arène à laquelle la bille fait éclater le cercle. */
const BURST_FRACTION = 0.86;

/**
 * Bornes du réglage `burstAfter` : le temps, en secondes, entre l'arrivée de la
 * bille et l'éclatement du cercle.
 */
const MIN_BURST_AFTER = 10;
const MAX_BURST_AFTER = 120;
const DEFAULT_BURST_AFTER = 21.8;

/**
 * Temps laissé après l'éclatement. Exprimé en secondes et non en fraction de la
 * durée : la bille libérée met ~1,2 s à quitter le cadre, une constante physique
 * qui ne s'étire pas avec la longueur de la vidéo.
 */
const AFTERMATH_SECONDS = 1.5;

/** Vitesse conservée par la bille après avoir défoncé le cercle. */
const BURST_DRAG = 0.26;

/**
 * Plafond de vitesse, purement de sécurité. La paroi qui se resserre injecte de
 * l'énergie à chaque impact ; sans borne les derniers rebonds partiraient en
 * vrille. Il est volontairement haut : une fenêtre étroite — j'avais imposé
 * 680 à 1400 px/s — renormalise la bille à chaque rebond et détruit le
 * mouvement balistique, qui est justement ce qui rend une chute crédible.
 */
const MAX_SPEED = 3200;

/**
 * Plancher d'énergie, exprimé en hauteur de rebond : après un impact, la bille
 * doit pouvoir remonter au moins cette fraction de la hauteur libre.
 *
 * Le frottement de contact convertit de la translation en rotation, et cette
 * rotation ne revient jamais entièrement. Sur une longue partie la bille finit
 * par s'épuiser et vibrer au fond — mesuré à 2 px/s et un impact par image sur
 * un rendu de 45 s. Le plancher ne se déclenche que dans ce cas : il n'agit
 * jamais tant que la bille a de l'élan, et il ne change que la norme de la
 * vitesse, jamais sa direction. Entre deux rebonds le mouvement reste
 * strictement balistique, ce qui est précisément ce qui le rend crédible.
 */
const MIN_BOUNCE_RISE = 0.45;

const FRAGMENTS = 56;

/**
 * Micro-rugosité de la paroi. Dans un cercle parfaitement lisse l'angle
 * d'incidence est conservé et la bille répète la même figure du début à la fin.
 * L'inclinaison de la normale vaut atan(A·k) et dépend du PRODUIT amplitude ×
 * lobes, alors que l'écart visible vaut A·R et ne dépend que de l'amplitude :
 * ici 0,47 px de relief, invisible sous un trait de 6 px, pour ±12° de normale.
 */
const LOBES = 220;
const LOBE_AMPLITUDE = 0.001;

/** Frottement de contact, pour le couplage rotation/translation. */
const FRICTION = 0.15;

/**
 * Bruitage joué à chaque contact avec la paroi. Cherché dans `assets/` puis à
 * la racine du projet.
 */
const BOUNCE_SOUND = 'dry-fart.mp3';

/** Positions gardées pour le flou de mouvement, en sous-pas. */
const BLUR_SAMPLES = 12;

interface Ball extends SpinBody {
  /** Angle accumulé, pour le rendu. */
  angle: number;
}

interface Ripple {
  x: number;
  y: number;
  frame: number;
  color: string;
}

/** Un « +1 » qui monte et s'efface au-dessus du compteur. */
interface Pop {
  frame: number;
  dx: number;
  color: string;
}

/** Un éclat du cercle : un arc qui dérive et tombe. */
interface Fragment {
  a0: number;
  a1: number;
  ox: number;
  oy: number;
  vx: number;
  vy: number;
}

interface State {
  ball: Ball;
  wall: LobedWall;
  gravity: number;
  burstTime: number;
  burstRadius: number;
  /** Gain de rayon par rebond. Identique du premier au dernier impact. */
  growthStep: number;
  bounces: number;
  burstFrame: number;
  fragments: Fragment[];
  ripples: Ripple[];
  pops: Pop[];
  lastBounceFrame: number;
  /** Positions récentes, en tampon circulaire, pour le flou de mouvement. */
  blur: Float64Array;
  blurHead: number;
  blurLen: number;
  palette: Palette;
}

export const config: SimConfig = {
  id: 'bounce',
  title: 'bounce',
  width: 1080,
  height: 1920,
  fps: 60,
  // Recalculée par resolveConfig.
  duration: DEFAULT_BURST_AFTER + AFTERMATH_SECONDS,
  // 16 sous-pas : même à 3200 px/s la bille n'avance que de 3 px par sous-pas,
  // donc le point de contact est trouvé finement et le mouvement ne saccade pas.
  substeps: 16,
  seed: 'bounce-001',
  params: {
    /** Secondes entre l'arrivée de la bille et l'éclatement du cercle. */
    burstAfter: DEFAULT_BURST_AFTER,
    /** Secondes conservées après l'éclatement, le temps que la bille sorte. */
    tail: AFTERMATH_SECONDS,
  },
};

/**
 * Durée totale et instant d'éclatement sont indépendants : celui qui n'est pas
 * demandé se déduit de l'autre.
 */
function resolveConfig(cfg: SimConfig, overrides: Partial<SimConfig>): SimConfig {
  const tail = Math.max(0.5, cfg.params.tail);
  const askedBurst = overrides.params?.burstAfter !== undefined;
  const askedDuration = overrides.duration !== undefined;

  let burstAfter: number;
  let duration: number;

  if (askedDuration && !askedBurst) {
    duration = cfg.duration;
    burstAfter = clamp(duration - tail, MIN_BURST_AFTER, MAX_BURST_AFTER);
  } else {
    burstAfter = clamp(cfg.params.burstAfter, MIN_BURST_AFTER, MAX_BURST_AFTER);
    duration = askedDuration ? cfg.duration : burstAfter + tail;
  }

  duration = Math.max(duration, burstAfter + 0.5);
  return { ...cfg, duration, params: { ...cfg.params, burstAfter, tail } };
}

// --------------------------------------------------------------------------
// Physique nue, partagée entre la pré-simulation et le rendu.
// --------------------------------------------------------------------------

function makeWall(cfg: SimConfig, rng: Rng): LobedWall {
  return {
    cx: cfg.width / 2,
    cy: cfg.height * 0.53,
    radius: Math.min(cfg.width, cfg.height) * 0.435,
    lobes: LOBES,
    amplitude: LOBE_AMPLITUDE,
    phase: rng.range(0, TAU),
    // Restitution 1 : sans dissipation normale, la bille ne s'endort jamais.
    restitution: 1,
    friction: FRICTION,
  };
}

function makeBall(wall: LobedWall, rng: Rng): Ball {
  // Lancée avec de l'élan plutôt que lâchée : la première chute libre durerait
  // sinon plus d'une seconde, et la vidéo démarrerait sur un temps mort.
  const launch = rng.range(0, TAU);
  return {
    x: wall.cx + rng.range(-0.35, 0.35) * wall.radius,
    y: wall.cy - wall.radius * 0.45,
    vx: Math.cos(launch) * 780,
    vy: Math.abs(Math.sin(launch)) * 780,
    r: START_RADIUS,
    omega: rng.range(-14, 14),
    angle: 0,
  };
}

/**
 * Avance d'un sous-pas et renvoie la vitesse d'impact, ou 0. Ne touche à rien
 * d'autre que la bille : c'est ce qui permet de rejouer exactement la même
 * trajectoire pendant la pré-simulation, sans effets ni audio.
 */
function advance(
  ball: Ball,
  wall: LobedWall,
  gravity: number,
  h: number,
  growthStep: number,
  maxRadius: number,
): number {
  ball.vy += gravity * h;
  ball.x += ball.vx * h;
  ball.y += ball.vy * h;
  ball.angle += ball.omega * h;

  const impact = containInLobedCircle(ball, wall);
  if (impact <= 0) return 0;

  ball.r = Math.min(maxRadius, ball.r + growthStep);

  const free = Math.max(1, wall.radius - ball.r);
  const kinetic = 0.5 * (ball.vx * ball.vx + ball.vy * ball.vy);
  // Potentiel compté depuis le point le plus bas de la cavité.
  const potential = gravity * Math.max(0, wall.cy + free - ball.y);
  const floor = gravity * MIN_BOUNCE_RISE * 2 * free;
  const needed = floor - potential;
  if (needed > kinetic && kinetic > 1e-9) {
    const k = Math.sqrt(needed / kinetic);
    ball.vx *= k;
    ball.vy *= k;
  }

  const sp = Math.hypot(ball.vx, ball.vy);
  if (sp > MAX_SPEED) {
    const k = MAX_SPEED / sp;
    ball.vx *= k;
    ball.vy *= k;
  }
  return impact;
}

/**
 * Instant du n-ième rebond pour un incrément donné, ou `Infinity` s'il n'a pas
 * lieu avant `horizon`. Sort dès que le compte est atteint.
 */
function timeOfNthBounce(
  cfg: SimConfig,
  rng: Rng,
  growthStep: number,
  n: number,
  maxRadius: number,
  horizon: number,
): number {
  const wall = makeWall(cfg, rng);
  const ball = makeBall(wall, rng);
  const gravity = GRAVITY_MS2 * PX_PER_M;
  const h = 1 / (cfg.fps * cfg.substeps);
  const steps = Math.ceil(horizon * cfg.fps) * cfg.substeps;

  let bounces = 0;
  for (let i = 0; i < steps; i++) {
    if (advance(ball, wall, gravity, h, growthStep, maxRadius) > 0) {
      bounces++;
      if (bounces >= n) return (i + 1) * h;
    }
  }
  return Infinity;
}

/**
 * Cherche le nombre de rebonds `n` tel que la bille, en grossissant du même
 * cran `span / n` à chaque impact, atteigne exactement sa taille finale au
 * moment voulu.
 *
 * Les deux exigences — cran constant et taille atteinte à l'heure — se
 * contredisent tant qu'on ignore le nombre de rebonds : ce nombre dépend de la
 * taille de la bille, qui dépend du cran, qui dépend du nombre de rebonds. On
 * le résout par pré-simulation, qui ne dessine rien et n'émet aucun son.
 *
 * Le critère porte sur l'INSTANT du n-ième rebond : c'est lui qu'on veut caler
 * sur l'échéance. Changer le cran change toute la trajectoire, qui est
 * chaotique, donc cet instant est bruité et non monotone en `n` — une dichotomie
 * élimine la bonne zone et se trompe de plusieurs secondes. On corrige donc
 * proportionnellement : s'il faut `T` secondes pour n rebonds, il en faut
 * environ `n · échéance / T` pour remplir l'échéance. On garde la meilleure
 * candidate rencontrée plutôt que la dernière, ce qui rend la recherche
 * insensible au bruit.
 *
 * Un éclatement légèrement en avance est préféré à un éclatement en retard : en
 * retard, la bille n'atteint pas sa taille de rupture avant la fin de la vidéo,
 * qui se termine alors sans explosion.
 */
function solveGrowthStep(cfg: SimConfig, fresh: () => Rng, burstTime: number, span: number): number {
  const maxRadius = START_RADIUS + span;
  const horizon = burstTime * 1.7;

  let n = Math.max(4, Math.round(burstTime * 2));
  let bestN = n;
  let bestScore = Infinity;

  for (let iter = 0; iter < 12; iter++) {
    const t = timeOfNthBounce(cfg, fresh(), span / n, n, maxRadius, horizon);

    if (!Number.isFinite(t)) {
      // Le n-ième rebond n'arrive jamais : viser moins haut.
      const next = Math.max(1, Math.round(n * 0.7));
      if (next === n) break;
      n = next;
      continue;
    }

    const err = Math.abs(t - burstTime);
    const score = t <= burstTime ? err : err * 1.5;
    if (score < bestScore) {
      bestScore = score;
      bestN = n;
    }
    if (err < 0.25) break;

    const next = Math.max(1, Math.round(n * (burstTime / t)));
    if (next === n) break;
    n = next;
  }

  // Affinage local. La correction proportionnelle peut se stabiliser à côté de
  // la solution parce que la fonction est bruitée ; un balayage serré autour de
  // la meilleure candidate rattrape ces cas (jusqu'à huit secondes d'écart sur
  // les durées longues).
  if (bestScore > 0.25) {
    // Fenêtre au moins large de six candidates de chaque côté : sur une vidéo
    // courte le compte de rebonds est petit, et ±14 % ne couvre alors que deux
    // ou trois entiers — largement trop peu, l'éclatement tombait deux secondes
    // trop tôt.
    const reach = Math.max(6, Math.round(bestN * 0.14));
    const lo = Math.max(1, bestN - reach);
    const hi = bestN + reach;
    const stride = Math.max(1, Math.round((hi - lo) / 20));
    for (let k = lo; k <= hi; k += stride) {
      const t = timeOfNthBounce(cfg, fresh(), span / k, k, maxRadius, horizon);
      if (!Number.isFinite(t)) continue;
      const err = Math.abs(t - burstTime);
      const score = t <= burstTime ? err : err * 1.5;
      if (score < bestScore) {
        bestScore = score;
        bestN = k;
      }
    }
  }

  return span / bestN;
}

/**
 * Le résultat ne dépend que de la configuration, et la recherche coûte quelques
 * dizaines de millisecondes. On le mémorise : en preview la sim est reconstruite
 * à chaque bouclage, et repayer la recherche y provoquerait un à-coup visible.
 */
const growthCache = new Map<string, number>();

function growthStepFor(cfg: SimConfig, fresh: () => Rng, burstTime: number, span: number): number {
  const key = `${cfg.seed}|${cfg.fps}|${cfg.substeps}|${cfg.width}|${cfg.height}|${burstTime}`;
  const hit = growthCache.get(key);
  if (hit !== undefined) return hit;
  const value = solveGrowthStep(cfg, fresh, burstTime, span);
  growthCache.set(key, value);
  return value;
}

// --------------------------------------------------------------------------

function init(ctx: InitCtx): State {
  const cfg = ctx.config;
  // `fork` d'un même label redonne toujours le même flux : la pré-simulation
  // rejoue donc exactement la trajectoire du rendu.
  const fresh = () => ctx.rng.fork('core');

  // Même ordre de tirage que dans `countBounces`, donc mêmes conditions
  // initiales : la pré-simulation et le rendu décrivent la même trajectoire.
  const rng = fresh();
  const wall = makeWall(cfg, rng);
  const ball = makeBall(wall, rng);

  const burstRadius = wall.radius * BURST_FRACTION;
  const burstTime = cfg.params.burstAfter;
  const growthStep = growthStepFor(cfg, fresh, burstTime, burstRadius - START_RADIUS);

  return {
    ball,
    wall,
    gravity: GRAVITY_MS2 * PX_PER_M,
    burstTime,
    burstRadius,
    growthStep,
    bounces: 0,
    burstFrame: -1,
    fragments: [],
    ripples: [],
    pops: [],
    lastBounceFrame: -999,
    blur: new Float64Array(BLUR_SAMPLES * 2),
    blurHead: 0,
    blurLen: 0,
    palette: getPalette('mono'),
  };
}

function ballColor(s: State): string {
  return s.palette.color(s.bounces);
}

function burst(s: State, ctx: StepCtx): void {
  s.burstFrame = ctx.frame;

  const b = s.ball;
  b.vx *= BURST_DRAG;
  b.vy = b.vy * BURST_DRAG - 220;

  for (let i = 0; i < FRAGMENTS; i++) {
    const a0 = (i / FRAGMENTS) * TAU;
    const a1 = ((i + 1) / FRAGMENTS) * TAU;
    const mid = (a0 + a1) / 2;
    const speed = ctx.rng.range(150, 400);
    s.fragments.push({
      a0,
      a1,
      ox: 0,
      oy: 0,
      vx: Math.cos(mid) * speed,
      // Biais vers le haut : les éclats montent avant de retomber, ce qui laisse
      // le temps de lire l'explosion.
      vy: Math.sin(mid) * speed - 210,
    });
  }
  ping(ctx.audio, ctx.t, { freq: 68, intensity: 1, decay: 0.9, voice: 'thud', xNorm: 0.5 });
}

function pushBlur(s: State, x: number, y: number): void {
  s.blur[s.blurHead * 2] = x;
  s.blur[s.blurHead * 2 + 1] = y;
  s.blurHead = (s.blurHead + 1) % BLUR_SAMPLES;
  if (s.blurLen < BLUR_SAMPLES) s.blurLen++;
}

function step(s: State, ctx: StepCtx): void {
  const b = s.ball;
  const h = ctx.h;

  if (s.burstFrame >= 0) {
    b.vy += s.gravity * h;
    b.x += b.vx * h;
    b.y += b.vy * h;
    b.angle += b.omega * h;
    for (const f of s.fragments) {
      f.vy += s.gravity * h;
      f.ox += f.vx * h;
      f.oy += f.vy * h;
    }
    pushBlur(s, b.x, b.y);
    return;
  }

  const impact = advance(b, s.wall, s.gravity, h, s.growthStep, s.burstRadius);
  pushBlur(s, b.x, b.y);
  if (impact <= 0) return;

  s.bounces++;
  s.lastBounceFrame = ctx.frame;

  const color = ballColor(s);
  s.ripples.push({ x: b.x, y: b.y, frame: ctx.frame, color });
  if (s.ripples.length > 16) s.ripples.shift();
  // Décalage horizontal dérivé du compteur : deux « +1 » consécutifs ne se
  // superposent pas, sans consommer d'aléa.
  s.pops.push({ frame: ctx.frame, dx: ((s.bounces * 37) % 11) - 5, color });
  if (s.pops.length > 8) s.pops.shift();

  // Un bruitage par contact avec la paroi, sans exception. Le volume suit la
  // force de l'impact, mais reste dans une fourchette étroite pour qu'aucun
  // rebond ne passe inaperçu.
  playSample(ctx.audio, ctx.t, {
    sample: BOUNCE_SOUND,
    gain: clamp(0.78 + impact / 6000, 0, 1),
    xNorm: b.x / ctx.config.width,
  });

  if (b.r >= s.burstRadius) burst(s, ctx);
}

function draw(s: State, d: DrawCtx): void {
  const { ctx, width, height, frame } = d;
  const p = s.palette;
  const color = ballColor(s);

  ctx.fillStyle = p.background;
  ctx.fillRect(0, 0, width, height);

  // Le cercle, blanc. Il s'épaissit un peu à l'approche de la rupture.
  const progress = clamp((s.ball.r - START_RADIUS) / (s.burstRadius - START_RADIUS), 0, 1);
  if (s.burstFrame < 0) {
    ctx.lineWidth = 6 + 6 * progress;
    ctx.strokeStyle = p.ink;
    ctx.beginPath();
    ctx.arc(s.wall.cx, s.wall.cy, s.wall.radius, 0, TAU);
    ctx.stroke();
  } else {
    const age = (frame - s.burstFrame) / 150;
    const fade = clamp(1 - age, 0, 1);
    ctx.lineWidth = 12;
    ctx.strokeStyle = `rgba(255,255,255,${(0.9 * fade).toFixed(3)})`;
    for (const f of s.fragments) {
      ctx.beginPath();
      ctx.arc(s.wall.cx + f.ox, s.wall.cy + f.oy, s.wall.radius, f.a0, f.a1);
      ctx.stroke();
    }

    const shock = clamp((frame - s.burstFrame) / 42, 0, 1);
    if (shock < 1) {
      ctx.lineWidth = 16 * (1 - shock);
      ctx.strokeStyle = `rgba(255,255,255,${(0.5 * (1 - shock)).toFixed(3)})`;
      ctx.beginPath();
      ctx.arc(s.wall.cx, s.wall.cy, s.wall.radius * (0.9 + 0.9 * shock), 0, TAU);
      ctx.stroke();
    }
  }

  // Ondes d'impact, à la couleur qu'avait la bille au moment du choc.
  for (const r of s.ripples) {
    const age = (frame - r.frame) / 30;
    if (age >= 1 || age < 0) continue;
    const k = 1 - age;
    ctx.lineWidth = 6 * k;
    ctx.strokeStyle = withAlpha(r.color, 0.55 * k * k);
    ctx.beginPath();
    ctx.arc(r.x, r.y, 18 + 110 * age, 0, TAU);
    ctx.stroke();
  }

  // Flou de mouvement : les positions des sous-pas, empilées en transparence.
  // C'est ce qui enlève la sensation de saut entre deux images.
  //
  // Sauté quand la bille est grosse : le flou n'est perceptible que si le
  // déplacement est comparable au rayon, et douze disques de 400 px pleins par
  // image coûtent la moitié du temps de rendu pour un effet invisible.
  const n = s.blurLen;
  if (n > 2) {
    const oldest = (s.blurHead - n + BLUR_SAMPLES * 2) % BLUR_SAMPLES;
    const newest = (s.blurHead - 1 + BLUR_SAMPLES * 2) % BLUR_SAMPLES;
    const travel = Math.hypot(
      s.blur[newest * 2] - s.blur[oldest * 2],
      s.blur[newest * 2 + 1] - s.blur[oldest * 2 + 1],
    );
    if (travel > s.ball.r * 0.25) {
      for (let k = 0; k < n - 1; k++) {
        const idx = (s.blurHead - n + k + BLUR_SAMPLES * 2) % BLUR_SAMPLES;
        const f = k / n;
        ctx.fillStyle = withAlpha(color, 0.06 + 0.1 * f);
        ctx.beginPath();
        ctx.arc(s.blur[idx * 2], s.blur[idx * 2 + 1], s.ball.r, 0, TAU);
        ctx.fill();
      }
    }
  }

  // La bille : un aplat opaque, un liseré sombre pour la détacher du cercle.
  ctx.fillStyle = color;
  ctx.beginPath();
  ctx.arc(s.ball.x, s.ball.y, s.ball.r, 0, TAU);
  ctx.fill();
  ctx.lineWidth = clamp(s.ball.r * 0.06, 2, 9);
  ctx.strokeStyle = 'rgba(0,0,0,0.35)';
  ctx.stroke();

  // La rotation reste simulée — elle nourrit le frottement de contact — mais
  // elle n'est plus dessinée : le repère salissait un aplat qu'on veut net.

  const total = Math.max(1, Math.round(d.config.duration * d.config.fps));
  const sinceBounce = frame - s.lastBounceFrame;
  drawHud(ctx, width, height, {
    value: s.bounces,
    label: d.config.title,
    palette: p,
    progress: frame / total,
    fade: smoothstep(0, 0.4, d.t),
    // Retombée courte : le chiffre claque puis revient, au lieu de respirer.
    pulse: 1 - clamp(sinceBounce / 8, 0, 1),
    valueColor: color,
  });

  drawPops(s, d);
}

/** Les « +1 » qui montent au-dessus du compteur à chaque impact. */
function drawPops(s: State, d: DrawCtx): void {
  const { ctx, width, frame } = d;
  const anchor = counterAnchor(width);
  ctx.save();
  ctx.textAlign = 'center';
  ctx.textBaseline = 'middle';
  for (const pop of s.pops) {
    const age = (frame - pop.frame) / 46;
    if (age >= 1 || age < 0) continue;
    const rise = smoothstep(0, 1, age);
    ctx.font = `800 ${84 - 20 * rise}px ${fonts.display}`;
    // Décalé bien au-delà du chiffre : à 210 px de corps, un nombre à trois
    // chiffres déborde de 160 px de part et d'autre de l'ancre.
    ctx.fillStyle = withAlpha(pop.color, (1 - age) * (1 - age));
    ctx.fillText('+1', anchor.x + 265 + pop.dx * 5, anchor.y - 20 - 190 * rise);
  }
  ctx.restore();
}

/** Ajoute un alpha à une couleur `hsl(...)`. */
function withAlpha(color: string, alpha: number): string {
  if (color.startsWith('hsl(')) {
    return `hsl(${color.slice(4, -1).split('/')[0].trim()} / ${alpha.toFixed(3)})`;
  }
  return color;
}

function probe(s: State): SimProbe {
  return { bodies: [s.ball], count: s.bounces, accent: ballColor(s) };
}

const sim: Sim<State> = { config, assets: [BOUNCE_SOUND], resolveConfig, init, step, draw, probe };
export default sim;
export { init, step, draw, probe, resolveConfig };
