import type { Rng } from './types.ts';

/** Hash de chaîne xmur3 : produit une graine 32 bits bien dispersée. */
function xmur3(str: string): () => number {
  let h = 1779033703 ^ str.length;
  for (let i = 0; i < str.length; i++) {
    h = Math.imul(h ^ str.charCodeAt(i), 3432918353);
    h = (h << 13) | (h >>> 19);
  }
  return () => {
    h = Math.imul(h ^ (h >>> 16), 2246822507);
    h = Math.imul(h ^ (h >>> 13), 3266489909);
    h ^= h >>> 16;
    return h >>> 0;
  };
}

/** sfc32 : petit, rapide, période > 2^128, qualité suffisante ici. */
function sfc32(a: number, b: number, c: number, d: number): () => number {
  return () => {
    a >>>= 0; b >>>= 0; c >>>= 0; d >>>= 0;
    let t = (a + b) | 0;
    a = b ^ (b >>> 9);
    b = (c + (c << 3)) | 0;
    c = (c << 21) | (c >>> 11);
    d = (d + 1) | 0;
    t = (t + d) | 0;
    c = (c + t) | 0;
    return (t >>> 0) / 4294967296;
  };
}

class SeededRng implements Rng {
  private readonly seed: string;
  private readonly gen: () => number;

  constructor(seed: string) {
    this.seed = seed;
    const h = xmur3(seed);
    this.gen = sfc32(h(), h(), h(), h());
    // Les premières sorties de sfc32 sont corrélées à la graine : on brûle.
    for (let i = 0; i < 16; i++) this.gen();
  }

  next(): number {
    return this.gen();
  }

  range(min: number, max: number): number {
    return min + this.gen() * (max - min);
  }

  int(min: number, max: number): number {
    return min + Math.floor(this.gen() * (max - min + 1));
  }

  pick<T>(items: readonly T[]): T {
    return items[Math.floor(this.gen() * items.length)];
  }

  fork(label: string): Rng {
    return new SeededRng(`${this.seed}/${label}`);
  }
}

export function createRng(seed: string): Rng {
  return new SeededRng(seed);
}
