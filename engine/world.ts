import type { AnySim, Ctx2D, Sim, SimConfig, StepCtx } from './types.ts';
import { AudioBus } from './audio.ts';
import { createRng } from './rng.ts';

/**
 * Boucle temporelle à pas fixe.
 *
 * C'est le seul endroit qui décide de l'avancement du temps, et il n'existe
 * qu'une seule façon d'avancer : `advanceFrame()`, qui exécute exactement
 * `substeps` sous-pas de `1 / (fps * substeps)` seconde. Le mode preview et le
 * mode headless appellent la même méthode ; ils ne diffèrent que par ce qui
 * les cadence (rAF d'un côté, une boucle `for` de l'autre).
 *
 * Aucune horloge murale n'entre ici. `frame` est la seule notion de temps.
 */
/**
 * Fusionne les surcharges avec la configuration déclarée par la sim, puis lui
 * laisse le dernier mot via `resolveConfig`. Exposée à part pour que la CLI
 * puisse annoncer la durée réelle avant de lancer le rendu, sans dupliquer la
 * règle de fusion.
 */
export function resolveSimConfig(sim: AnySim, overrides: Partial<SimConfig> = {}): SimConfig {
  // `params` se fusionne clé par clé : surcharger un réglage ne doit pas
  // effacer les autres.
  const merged: SimConfig = {
    ...sim.config,
    ...overrides,
    params: { ...sim.config.params, ...(overrides.params ?? {}) },
  };
  return sim.resolveConfig ? sim.resolveConfig(merged, overrides) : merged;
}

export class World<S> {
  readonly sim: Sim<S>;
  readonly config: SimConfig;
  readonly audio: AudioBus;
  readonly totalFrames: number;

  state: S;
  frame = 0;

  private readonly stepCtx: StepCtx;

  constructor(sim: Sim<S>, overrides: Partial<SimConfig> = {}, audioOpts?: { perFrameLimit?: number }) {
    this.sim = sim;
    this.config = resolveSimConfig(sim, overrides);
    this.audio = new AudioBus(audioOpts);
    this.totalFrames = Math.max(1, Math.round(this.config.duration * this.config.fps));

    const rng = createRng(this.config.seed);
    this.state = sim.init({ config: this.config, rng, audio: this.audio });

    this.stepCtx = {
      config: this.config,
      rng: createRng(`${this.config.seed}/step`),
      audio: this.audio,
      h: 1 / (this.config.fps * this.config.substeps),
      t: 0,
      frame: 0,
      substep: 0,
      substeps: this.config.substeps,
    };
  }

  /** Temps de simulation écoulé, en secondes. */
  get time(): number {
    return this.frame / this.config.fps;
  }

  get done(): boolean {
    return this.frame >= this.totalFrames;
  }

  /** Avance d'exactement une image. */
  advanceFrame(): void {
    const { substeps } = this.config;
    const h = this.stepCtx.h;
    const base = this.frame / this.config.fps;

    this.audio.beginFrame(this.frame);
    this.stepCtx.frame = this.frame;

    for (let s = 0; s < substeps; s++) {
      this.stepCtx.substep = s;
      this.stepCtx.t = base + s * h;
      this.sim.step(this.state, this.stepCtx);
    }

    this.frame++;
  }

  /** Dessine l'état courant. Ne modifie jamais l'état. */
  render(ctx: Ctx2D): void {
    this.sim.draw(this.state, {
      ctx,
      config: this.config,
      width: this.config.width,
      height: this.config.height,
      frame: this.frame,
      t: this.time,
    });
  }
}

export function createWorld(sim: AnySim, overrides: Partial<SimConfig> = {}): World<any> {
  return new World(sim, overrides);
}
