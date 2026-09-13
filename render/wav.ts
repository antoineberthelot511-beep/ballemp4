import type { AudioEvent } from '../engine/types.ts';
import { createRng } from '../engine/rng.ts';
import type { DecodedSample } from './audio-assets.ts';

/**
 * Synthèse hors-ligne de la liste d'événements produite par l'AudioBus.
 *
 * Tout est calculé à partir des seuls `AudioEvent` : mêmes événements = même
 * WAV, bit pour bit. Aucun bruit non seedé, aucune horloge.
 */

export interface WavOptions {
  sampleRate?: number;
  /** Durée de la vidéo, en secondes. */
  duration: number;
  /** Marge après la fin, pour laisser les dernières notes s'éteindre. */
  tail?: number;
  /** Niveau crête visé après normalisation. */
  peak?: number;
  seed?: string;
  /** Sons décodés, indexés par le nom porté par les événements. */
  samples?: Map<string, DecodedSample>;
}

/**
 * Mixe un échantillon dans les pistes, avec panoramique à puissance constante.
 * `rate` rééchantillonne par interpolation linéaire : suffisant pour de courts
 * bruitages, et sans dépendance.
 */
function mixSample(
  sample: DecodedSample,
  left: Float32Array,
  right: Float32Array,
  start: number,
  gain: number,
  pan: number,
  rate: number,
): void {
  const total = left.length;
  const frames = sample.left.length;
  if (frames === 0) return;

  const angle = ((pan + 1) * Math.PI) / 4;
  const gl = Math.cos(angle) * gain;
  const gr = Math.sin(angle) * gain;
  const outFrames = Math.floor(frames / rate);

  for (let i = 0; i < outFrames; i++) {
    const dst = start + i;
    if (dst < 0) continue;
    if (dst >= total) break;

    const src = i * rate;
    const i0 = Math.floor(src);
    const i1 = Math.min(frames - 1, i0 + 1);
    const f = src - i0;
    const l = sample.left[i0] * (1 - f) + sample.left[i1] * f;
    const r = sample.right[i0] * (1 - f) + sample.right[i1] * f;

    left[dst] += l * gl;
    right[dst] += r * gr;
  }
}

function voiceSample(ev: AudioEvent, t: number, noise: () => number): number {
  const w = 2 * Math.PI * ev.freq;
  switch (ev.voice) {
    case 'thud': {
      // Chute de hauteur rapide : lit comme un choc lourd.
      const f = ev.freq * (0.5 + 0.5 * Math.exp(-t / 0.05));
      return Math.sin(2 * Math.PI * f * t) * 0.9 + Math.sin(4 * Math.PI * f * t) * 0.1;
    }
    case 'pop': {
      const click = t < 0.004 ? noise() * (1 - t / 0.004) : 0;
      return Math.sin(w * t) * 0.6 + click * 0.6;
    }
    default: {
      // Cloche : partiels légèrement inharmoniques, plus vivants qu'une sinus pure.
      return (
        Math.sin(w * t) * 0.68 +
        Math.sin(w * 2.01 * t) * 0.22 +
        Math.sin(w * 3.03 * t) * 0.08 +
        Math.sin(w * 4.7 * t) * 0.02
      );
    }
  }
}

export function renderWav(events: readonly AudioEvent[], opts: WavOptions): Buffer {
  const sampleRate = opts.sampleRate ?? 48000;
  const tail = opts.tail ?? 1.2;
  const peakTarget = opts.peak ?? 0.89;
  const totalSamples = Math.max(1, Math.ceil((opts.duration + tail) * sampleRate));

  const left = new Float32Array(totalSamples);
  const right = new Float32Array(totalSamples);
  const rng = createRng(opts.seed ?? 'audio');
  const noise = () => rng.next() * 2 - 1;

  for (const ev of events) {
    const start = Math.round(ev.t * sampleRate);
    if (start >= totalSamples) continue;

    if (ev.sample) {
      const decoded = opts.samples?.get(ev.sample);
      // Son absent : impact muet plutôt qu'échec du rendu. L'avertissement a
      // déjà été émis au décodage.
      if (decoded) {
        mixSample(decoded, left, right, start, ev.gain, ev.pan, Math.max(0.05, ev.rate ?? 1));
      }
      continue;
    }

    // On coupe à 6 constantes de temps : au-delà, l'enveloppe est inaudible.
    const len = Math.min(totalSamples - start, Math.ceil(ev.decay * 6 * sampleRate));
    if (len <= 0) continue;

    const angle = ((ev.pan + 1) * Math.PI) / 4;
    const gl = Math.cos(angle) * ev.gain;
    const gr = Math.sin(angle) * ev.gain;

    for (let i = 0; i < len; i++) {
      const t = i / sampleRate;
      // Attaque de 2,5 ms : supprime le clic de discontinuité.
      const attack = t < 0.0025 ? t / 0.0025 : 1;
      const env = attack * Math.exp(-t / ev.decay);
      const s = voiceSample(ev, t, noise) * env;
      left[start + i] += s * gl;
      right[start + i] += s * gr;
    }
  }

  // Saturation douce puis normalisation : les empilements de notes restent
  // ronds au lieu de saturer carré.
  let peak = 0;
  for (let i = 0; i < totalSamples; i++) {
    const l = Math.tanh(left[i] * 0.85);
    const r = Math.tanh(right[i] * 0.85);
    left[i] = l;
    right[i] = r;
    const m = Math.max(Math.abs(l), Math.abs(r));
    if (m > peak) peak = m;
  }
  const norm = peak > 1e-6 ? peakTarget / peak : 1;

  const bytesPerSample = 2;
  const blockAlign = bytesPerSample * 2;
  const dataSize = totalSamples * blockAlign;
  const buf = Buffer.alloc(44 + dataSize);

  buf.write('RIFF', 0, 'ascii');
  buf.writeUInt32LE(36 + dataSize, 4);
  buf.write('WAVE', 8, 'ascii');
  buf.write('fmt ', 12, 'ascii');
  buf.writeUInt32LE(16, 16);
  buf.writeUInt16LE(1, 20); // PCM
  buf.writeUInt16LE(2, 22); // stéréo
  buf.writeUInt32LE(sampleRate, 24);
  buf.writeUInt32LE(sampleRate * blockAlign, 28);
  buf.writeUInt16LE(blockAlign, 32);
  buf.writeUInt16LE(16, 34);
  buf.write('data', 36, 'ascii');
  buf.writeUInt32LE(dataSize, 40);

  let off = 44;
  for (let i = 0; i < totalSamples; i++) {
    buf.writeInt16LE(Math.max(-32768, Math.min(32767, Math.round(left[i] * norm * 32767))), off);
    buf.writeInt16LE(Math.max(-32768, Math.min(32767, Math.round(right[i] * norm * 32767))), off + 2);
    off += 4;
  }
  return buf;
}
