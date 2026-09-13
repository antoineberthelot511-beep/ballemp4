/**
 * Interfaces partagées entre le mode preview (navigateur) et le mode headless
 * (Node + @napi-rs/canvas).
 *
 * Le code de simulation ne doit JAMAIS importer `window`, `document`,
 * `performance`, `Date` ou `Math.random`. Il ne voit que ces types.
 */

/** Objet acceptable par `drawImage` (HTMLCanvasElement ou Canvas napi-rs). */
export type ImageLike = unknown;

export interface Gradient {
  addColorStop(offset: number, color: string): void;
}

/**
 * Sous-ensemble structurel de CanvasRenderingContext2D réellement utilisé.
 * Déclaré à la main pour que les sims compilent à l'identique côté DOM et
 * côté napi-rs, dont les typages divergent.
 */
export interface Ctx2D {
  fillStyle: string | Gradient;
  strokeStyle: string | Gradient;
  lineWidth: number;
  lineCap: 'butt' | 'round' | 'square';
  lineJoin: 'round' | 'bevel' | 'miter';
  globalAlpha: number;
  globalCompositeOperation: string;
  font: string;
  textAlign: 'left' | 'right' | 'center' | 'start' | 'end';
  textBaseline: 'top' | 'hanging' | 'middle' | 'alphabetic' | 'ideographic' | 'bottom';
  shadowBlur: number;
  shadowColor: string;

  save(): void;
  restore(): void;
  translate(x: number, y: number): void;
  rotate(angle: number): void;
  scale(x: number, y: number): void;
  setTransform(a: number, b: number, c: number, d: number, e: number, f: number): void;

  beginPath(): void;
  closePath(): void;
  moveTo(x: number, y: number): void;
  lineTo(x: number, y: number): void;
  arc(x: number, y: number, r: number, a0: number, a1: number, ccw?: boolean): void;
  rect(x: number, y: number, w: number, h: number): void;
  fill(): void;
  stroke(): void;
  clip(): void;

  fillRect(x: number, y: number, w: number, h: number): void;
  strokeRect(x: number, y: number, w: number, h: number): void;
  clearRect(x: number, y: number, w: number, h: number): void;

  fillText(text: string, x: number, y: number): void;
  strokeText(text: string, x: number, y: number): void;
  measureText(text: string): { width: number };

  createRadialGradient(x0: number, y0: number, r0: number, x1: number, y1: number, r1: number): Gradient;
  createLinearGradient(x0: number, y0: number, x1: number, y1: number): Gradient;

  drawImage(img: ImageLike, dx: number, dy: number): void;
  drawImage(img: ImageLike, dx: number, dy: number, dw: number, dh: number): void;
}

/** Un canvas offscreen, quelle que soit la plateforme. */
export interface Surface {
  readonly width: number;
  readonly height: number;
  readonly ctx: Ctx2D;
  /** À passer à `drawImage`. */
  readonly image: ImageLike;
}

export type SurfaceFactory = (width: number, height: number) => Surface;

/** Générateur pseudo-aléatoire déterministe. */
export interface Rng {
  /** [0, 1) */
  next(): number;
  /** [min, max) */
  range(min: number, max: number): number;
  /** Entier dans [min, max] */
  int(min: number, max: number): number;
  pick<T>(items: readonly T[]): T;
  /** Nouveau flux indépendant, dérivé de manière déterministe. */
  fork(label: string): Rng;
}

export interface AudioEvent {
  /** Temps de simulation, en secondes. */
  t: number;
  /** Fréquence fondamentale en Hz. Ignorée si `sample` est renseigné. */
  freq: number;
  /** 0..1 */
  gain: number;
  /** Constante de décroissance de l'enveloppe, en secondes. Ignorée si `sample`. */
  decay: number;
  /** -1 (gauche) .. 1 (droite) */
  pan: number;
  /** Timbre du synthétiseur. Ignoré si `sample` est renseigné. */
  voice: 'ping' | 'thud' | 'pop';
  /**
   * Nom d'un fichier audio à jouer au lieu du son de synthèse. Le moteur ne le
   * charge pas lui-même : il se contente de le nommer, à charge de l'hôte de le
   * décoder (ffmpeg en headless, WebAudio en preview).
   */
  sample?: string;
  /** Vitesse de lecture de l'échantillon. 1 = hauteur d'origine. */
  rate?: number;
}

export interface AudioSink {
  emit(ev: AudioEvent): void;
}

/** Un disque en mouvement. */
export interface Body {
  x: number;
  y: number;
  vx: number;
  vy: number;
  r: number;
}

/**
 * Vue en lecture seule de l'état, exposée pour les vérifications automatiques
 * (`render/verify.ts`). Une sim qui ne l'implémente pas est simplement ignorée
 * par le vérificateur.
 */
export interface SimProbe {
  /** Corps à surveiller : NaN, vitesse, sortie d'arène. */
  bodies: readonly Body[];
  /** Valeur du compteur affiché dans le HUD. */
  count: number;
  /** Norme de vitesse imposée par la sim, si elle en impose une. */
  expectedSpeed?: number;
  /** Couleur dominante de l'instant, pour qu'une interface s'y accorde. */
  accent?: string;
}

export interface SimConfig {
  id: string;
  title: string;
  width: number;
  height: number;
  /** Images par seconde de la vidéo ET de la simulation. */
  fps: number;
  /** Durée en secondes. */
  duration: number;
  /** Sous-pas d'intégration par image. */
  substeps: number;
  seed: string;
  /**
   * Réglages numériques propres à la sim, fusionnés clé par clé avec ceux
   * qu'elle déclare par défaut. Alimentés en ligne de commande par `--param`,
   * ou par la query string en preview.
   */
  params: Record<string, number>;
}

export interface InitCtx {
  config: SimConfig;
  rng: Rng;
  audio: AudioSink;
}

export interface StepCtx {
  config: SimConfig;
  rng: Rng;
  audio: AudioSink;
  /** Durée du sous-pas, en secondes (= 1 / (fps * substeps)). */
  h: number;
  /** Temps de simulation au début du sous-pas. */
  t: number;
  /** Index de l'image en cours. */
  frame: number;
  /** Index du sous-pas dans l'image, 0-based. */
  substep: number;
  substeps: number;
}

export interface DrawCtx {
  ctx: Ctx2D;
  config: SimConfig;
  width: number;
  height: number;
  frame: number;
  /** Temps de simulation à la fin de l'image. */
  t: number;
}

/**
 * Une simulation. `step` avance la physique d'exactement `ctx.h` secondes et
 * ne dessine rien ; `draw` dessine et ne modifie pas l'état.
 */
export interface Sim<S> {
  config: SimConfig;
  /**
   * Fichiers son que la sim est susceptible de déclencher. Sert à les précharger
   * avant le démarrage : découverts au premier événement, les premiers impacts
   * seraient muets le temps du téléchargement.
   */
  assets?: readonly string[];
  /**
   * Facultatif : dernier mot de la sim sur sa configuration, une fois les
   * surcharges fusionnées. Sert aux sims dont un champ peut se déduire d'un
   * autre — par exemple une durée totale et l'instant d'un événement scénarisé,
   * dont chacun se calcule à partir de l'autre.
   *
   * `overrides` est reçu tel quel pour distinguer « pas demandé » de « demandé
   * à la valeur par défaut » : sans cette information, impossible de savoir
   * lequel des deux champs doit suivre l'autre. Doit être pure et déterministe.
   */
  resolveConfig?(config: SimConfig, overrides: Partial<SimConfig>): SimConfig;
  init(ctx: InitCtx): S;
  step(state: S, ctx: StepCtx): void;
  draw(state: S, ctx: DrawCtx): void;
  /** Facultatif : permet à `render/verify.ts` d'auditer la sim. */
  probe?(state: S): SimProbe;
}

/** Sim dont le type d'état est effacé, pour le stockage en registre. */
export type AnySim = Sim<any>;
