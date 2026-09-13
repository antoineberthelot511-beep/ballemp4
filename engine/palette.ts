import { TAU } from './math.ts';

export interface Palette {
  /** Couleur d'index i, cyclique et déterministe. */
  color(i: number): string;
  /** Même couleur, avec alpha explicite. */
  colorAlpha(i: number, alpha: number): string;
  readonly background: string;
  readonly ink: string;
  readonly dim: string;
}

interface Hsl {
  h: number;
  s: number;
  l: number;
}

function hsl(c: Hsl, alpha: number): string {
  const h = ((c.h % 360) + 360) % 360;
  return alpha >= 1
    ? `hsl(${h.toFixed(1)} ${c.s.toFixed(1)}% ${c.l.toFixed(1)}%)`
    : `hsl(${h.toFixed(1)} ${c.s.toFixed(1)}% ${c.l.toFixed(1)}% / ${alpha.toFixed(3)})`;
}

/**
 * Palette en spirale sur la roue chromatique : l'angle d'or évite que deux
 * index proches se ressemblent, et la luminosité oscille légèrement pour que
 * les billes voisines restent lisibles une fois superposées.
 */
function spiralPalette(opts: {
  hue0: number;
  hueSpan: number;
  sat: number;
  light: number;
  background: string;
  ink: string;
  dim: string;
}): Palette {
  const golden = 360 * (1 - 1 / 1.618033988749895);
  const cache = new Map<number, Hsl>();
  const at = (i: number): Hsl => {
    let c = cache.get(i);
    if (!c) {
      const spread = opts.hueSpan >= 360 ? golden * i : (golden * i) % opts.hueSpan;
      c = {
        h: opts.hue0 + spread,
        s: opts.sat + 6 * Math.sin(i * 1.7),
        l: opts.light + 7 * Math.sin(i * 0.9 + 1.2),
      };
      cache.set(i, c);
    }
    return c;
  };
  return {
    color: (i) => hsl(at(i), 1),
    colorAlpha: (i, a) => hsl(at(i), a),
    background: opts.background,
    ink: opts.ink,
    dim: opts.dim,
  };
}

export const PALETTES: Record<string, () => Palette> = {
  /** Fond noir franc, traits blancs, couleurs saturées pour les mobiles. */
  mono: () =>
    spiralPalette({
      hue0: 200, hueSpan: 360, sat: 90, light: 60,
      background: '#000000', ink: '#ffffff', dim: 'rgba(255,255,255,0.30)',
    }),
  neon: () =>
    spiralPalette({
      hue0: 190, hueSpan: 360, sat: 92, light: 62,
      background: '#05060c', ink: '#ffffff', dim: 'rgba(255,255,255,0.22)',
    }),
  sunset: () =>
    spiralPalette({
      hue0: 340, hueSpan: 140, sat: 88, light: 60,
      background: '#0b0409', ink: '#fff2e8', dim: 'rgba(255,210,180,0.22)',
    }),
  ice: () =>
    spiralPalette({
      hue0: 175, hueSpan: 110, sat: 84, light: 64,
      background: '#03080f', ink: '#eaf6ff', dim: 'rgba(190,230,255,0.22)',
    }),
  acid: () =>
    spiralPalette({
      hue0: 70, hueSpan: 200, sat: 95, light: 58,
      background: '#060a05', ink: '#f2ffe8', dim: 'rgba(220,255,180,0.22)',
    }),
};

export function getPalette(name: string): Palette {
  const make = PALETTES[name];
  if (!make) {
    throw new Error(`Palette inconnue "${name}". Disponibles : ${Object.keys(PALETTES).join(', ')}`);
  }
  return make();
}

/** Couleur d'accent d'un point du cercle, pour les anneaux d'arène. */
export function ringColor(p: Palette, angle: number, count: number): string {
  return p.color(Math.floor((angle / TAU) * count));
}
