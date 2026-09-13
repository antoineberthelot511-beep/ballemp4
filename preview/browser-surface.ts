import type { Ctx2D, Surface } from '../engine/types.ts';
import { installSurfaceFactory } from '../engine/surface.ts';
import { setFonts } from '../engine/fonts.ts';

class DomSurface implements Surface {
  readonly canvas: HTMLCanvasElement;
  readonly ctx: Ctx2D;

  constructor(width: number, height: number) {
    this.canvas = document.createElement('canvas');
    this.canvas.width = width;
    this.canvas.height = height;
    const c = this.canvas.getContext('2d', { alpha: true });
    if (!c) throw new Error('Contexte 2D indisponible');
    this.ctx = c as unknown as Ctx2D;
  }

  get width(): number {
    return this.canvas.width;
  }

  get height(): number {
    return this.canvas.height;
  }

  get image(): unknown {
    return this.canvas;
  }
}

export function installBrowserSurfaces(): void {
  installSurfaceFactory((w, h) => new DomSurface(w, h));
  // Doit correspondre à la police enregistrée côté headless
  // (render/node-surface.ts), sinon les deux modes ne cadrent pas le texte
  // de la même façon.
  setFonts({ display: '"Segoe UI", "Helvetica Neue", Arial, sans-serif' });
}

export { DomSurface };
