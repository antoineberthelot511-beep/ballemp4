import type { Ctx2D, Surface } from './types.ts';
import { createSurface } from './surface.ts';

/**
 * Un dégradé radial par bille et par image coûte très cher (allocation +
 * rastérisation de gradient). On pré-rend donc chaque combinaison
 * (couleur, rayon quantifié) une seule fois dans un petit canvas, puis on la
 * blitte avec `drawImage`.
 *
 * Le cache est borné : au-delà de `maxEntries`, il est vidé entièrement plutôt
 * qu'en LRU, pour rester parfaitement déterministe (une politique LRU ne
 * changerait pas le rendu, mais un vidage total est plus simple à raisonner).
 */
export interface GlowAtlas {
  /** Bille complète : lueur + disque. */
  draw(ctx: Ctx2D, x: number, y: number, radius: number, color: string, alpha?: number): void;
  /** Lueur seule — traînées, flashs d'impact. À composer en `lighter`. */
  drawHalo(ctx: Ctx2D, x: number, y: number, radius: number, color: string, alpha?: number): void;
  /** Disque seul, avec son reflet. À composer en `source-over`. */
  drawBody(ctx: Ctx2D, x: number, y: number, radius: number, color: string, alpha?: number): void;
  readonly size: number;
}

export interface GlowOptions {
  /** Rayon du halo en multiples du rayon de la bille. */
  spread?: number;
  /** Pas de quantification du rayon, en pixels. */
  step?: number;
  /** Sur-échantillonnage du sprite, pour garder des bords nets à l'agrandissement. */
  oversample?: number;
  maxEntries?: number;
}

/**
 * `halo` : lueur seule, à composer en `lighter`.
 * `body` : disque plein + reflet, à composer en `source-over` pour que la
 *          bille garde une silhouette nette au lieu de se noyer dans sa lueur.
 * `ball` : les deux d'un coup, pour les cas simples.
 */
type Kind = 'ball' | 'halo' | 'body';

function renderSprite(kind: Kind, radius: number, color: string, spread: number, oversample: number): Surface {
  const outer = radius * spread;
  const half = Math.ceil(outer * oversample);
  const s = createSurface(half * 2, half * 2);
  const g = s.ctx;
  const c = half;
  const rr = radius * oversample;
  const oo = outer * oversample;

  if (kind !== 'body') {
    // Halo : dégradé radial avec une décroissance douce (proche d'un carré
    // inverse tronqué), ce qui « brille » nettement mieux qu'une rampe linéaire.
    const grad = g.createRadialGradient(c, c, rr * 0.25, c, c, oo);
    grad.addColorStop(0, withAlpha(color, kind === 'halo' ? 0.55 : 0.9));
    grad.addColorStop(0.18, withAlpha(color, 0.3));
    grad.addColorStop(0.42, withAlpha(color, 0.12));
    grad.addColorStop(0.72, withAlpha(color, 0.03));
    grad.addColorStop(1, withAlpha(color, 0));
    g.fillStyle = grad;
    g.beginPath();
    g.arc(c, c, oo, 0, Math.PI * 2);
    g.fill();
  }

  if (kind !== 'halo') {
    // Disque plein.
    g.fillStyle = color;
    g.beginPath();
    g.arc(c, c, rr, 0, Math.PI * 2);
    g.fill();

    // Reflet spéculaire décalé vers le haut-gauche : donne du volume.
    const spec = g.createRadialGradient(
      c - rr * 0.32, c - rr * 0.36, 0,
      c - rr * 0.32, c - rr * 0.36, rr * 0.85,
    );
    spec.addColorStop(0, 'rgba(255,255,255,0.72)');
    spec.addColorStop(0.45, 'rgba(255,255,255,0.12)');
    spec.addColorStop(1, 'rgba(255,255,255,0)');
    g.fillStyle = spec;
    g.beginPath();
    g.arc(c, c, rr, 0, Math.PI * 2);
    g.fill();
  }

  return s;
}

/** Ajoute un alpha à une couleur `hsl(...)` ou `#rrggbb`. */
function withAlpha(color: string, alpha: number): string {
  if (color.startsWith('hsl(')) {
    const inner = color.slice(4, -1).split('/')[0].trim();
    return `hsl(${inner} / ${alpha})`;
  }
  if (color.startsWith('#') && (color.length === 7 || color.length === 4)) {
    const hex = color.length === 4
      ? color[1] + color[1] + color[2] + color[2] + color[3] + color[3]
      : color.slice(1);
    const n = parseInt(hex, 16);
    return `rgba(${(n >> 16) & 255},${(n >> 8) & 255},${n & 255},${alpha})`;
  }
  if (color.startsWith('rgb(')) {
    return `rgba(${color.slice(4, -1)},${alpha})`;
  }
  return color;
}

export function createGlowAtlas(options: GlowOptions = {}): GlowAtlas {
  const spread = options.spread ?? 3.2;
  const step = options.step ?? 1;
  const oversample = options.oversample ?? 2;
  const maxEntries = options.maxEntries ?? 512;
  const cache = new Map<string, Surface>();

  function sprite(kind: Kind, radius: number, color: string): { s: Surface; r: number } {
    const q = Math.max(step, Math.round(radius / step) * step);
    const key = `${kind}|${q}|${color}`;
    let s = cache.get(key);
    if (!s) {
      if (cache.size >= maxEntries) cache.clear();
      s = renderSprite(kind, q, color, spread, oversample);
      cache.set(key, s);
    }
    return { s, r: q };
  }

  function blit(ctx: Ctx2D, kind: Kind, x: number, y: number, radius: number, color: string, alpha: number): void {
    if (radius <= 0 || alpha <= 0) return;
    const { s, r } = sprite(kind, radius, color);
    // Le sprite a été rendu pour le rayon quantifié `r` ; on le remet à
    // l'échelle du rayon demandé pour que le mouvement reste continu.
    const scale = radius / r;
    const w = (s.width / oversample) * scale;
    const prev = ctx.globalAlpha;
    if (alpha < 1) ctx.globalAlpha = prev * alpha;
    ctx.drawImage(s.image, x - w / 2, y - w / 2, w, w);
    if (alpha < 1) ctx.globalAlpha = prev;
  }

  return {
    draw: (ctx, x, y, radius, color, alpha = 1) => blit(ctx, 'ball', x, y, radius, color, alpha),
    drawHalo: (ctx, x, y, radius, color, alpha = 1) => blit(ctx, 'halo', x, y, radius, color, alpha),
    drawBody: (ctx, x, y, radius, color, alpha = 1) => blit(ctx, 'body', x, y, radius, color, alpha),
    get size() {
      return cache.size;
    },
  };
}
