import type { AudioEvent, AudioSink } from './types.ts';
import { clamp } from './math.ts';

/**
 * Le moteur ne synthétise pas de son : il enregistre une liste d'événements
 * horodatés en temps de simulation. Le rendu headless la transforme en WAV
 * (voir `render/wav.ts`), la preview la joue via WebAudio. Le même flux
 * d'événements donne donc exactement la même bande-son.
 */
export class AudioBus implements AudioSink {
  readonly events: AudioEvent[] = [];

  /** Limite d'événements par image, pour éviter la bouillie sonore. */
  private readonly perFrameLimit: number;
  private readonly totalLimit: number;
  private frameKey = -1;
  private frameCount = 0;

  constructor(opts: { perFrameLimit?: number; totalLimit?: number } = {}) {
    // Aligné sur le nombre maximal de sous-pas : en pratique aucun impact n'est
    // jamais écarté, la limite ne sert que de garde-fou contre un emballement.
    this.perFrameLimit = opts.perFrameLimit ?? 16;
    this.totalLimit = opts.totalLimit ?? 200_000;
  }

  /** Appelé par le World au début de chaque image. */
  beginFrame(frame: number): void {
    if (frame !== this.frameKey) {
      this.frameKey = frame;
      this.frameCount = 0;
    }
  }

  emit(ev: AudioEvent): void {
    if (this.frameCount >= this.perFrameLimit) return;
    if (this.events.length >= this.totalLimit) return;
    this.frameCount++;
    this.events.push(ev);
  }
}

/** Gamme pentatonique mineure : quasiment aucune combinaison ne sonne faux. */
export const PENTATONIC_MINOR: readonly number[] = [0, 3, 5, 7, 10];
/** Pentatonique majeure : plus lumineuse. */
export const PENTATONIC_MAJOR: readonly number[] = [0, 2, 4, 7, 9];

export function midiToFreq(midi: number): number {
  return 440 * Math.pow(2, (midi - 69) / 12);
}

/**
 * Transforme un index d'événement en hauteur musicale : le degré monte dans la
 * gamme puis change d'octave, ce qui donne l'impression d'une montée continue.
 */
export function scalePitch(
  index: number,
  opts: { root?: number; scale?: readonly number[]; octaves?: number } = {},
): number {
  const scale = opts.scale ?? PENTATONIC_MINOR;
  const root = opts.root ?? 57; // A3
  const octaves = opts.octaves ?? 3;
  const steps = scale.length * octaves;
  const i = ((index % steps) + steps) % steps;
  const octave = Math.floor(i / scale.length);
  return midiToFreq(root + octave * 12 + scale[i % scale.length]);
}

export interface PingOptions {
  freq: number;
  /** Vitesse d'impact, utilisée pour le volume. */
  intensity?: number;
  decay?: number;
  /** Position horizontale normalisée 0..1, convertie en panoramique. */
  xNorm?: number;
  voice?: AudioEvent['voice'];
}

export function ping(sink: AudioSink, t: number, o: PingOptions): void {
  sink.emit({
    t,
    freq: o.freq,
    gain: clamp(o.intensity ?? 1, 0, 1),
    decay: o.decay ?? 0.22,
    pan: clamp(((o.xNorm ?? 0.5) - 0.5) * 1.4, -1, 1),
    voice: o.voice ?? 'ping',
  });
}

export interface SampleOptions {
  /** Nom du fichier, résolu par l'hôte. */
  sample: string;
  /** 0..1 */
  gain?: number;
  /** Position horizontale normalisée 0..1, convertie en panoramique. */
  xNorm?: number;
  /** Vitesse de lecture. 1 = hauteur d'origine. */
  rate?: number;
}

/** Déclenche un échantillon audio à l'instant `t` du temps de simulation. */
export function playSample(sink: AudioSink, t: number, o: SampleOptions): void {
  sink.emit({
    t,
    freq: 0,
    gain: clamp(o.gain ?? 1, 0, 1),
    decay: 0,
    pan: clamp(((o.xNorm ?? 0.5) - 0.5) * 1.4, -1, 1),
    voice: 'ping',
    sample: o.sample,
    rate: o.rate,
  });
}
