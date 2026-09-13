import { existsSync } from 'node:fs';
import { createCanvas, GlobalFonts, type Canvas } from '@napi-rs/canvas';
import type { Ctx2D, Surface } from '../engine/types.ts';
import { installSurfaceFactory } from '../engine/surface.ts';
import { setFonts } from '../engine/fonts.ts';

/**
 * Polices candidates, testées dans l'ordre. On enregistre explicitement le
 * fichier plutôt que de compter sur la résolution système : c'est la seule
 * façon de garantir que deux machines produisent le même rendu de texte.
 */
const DISPLAY_CANDIDATES: ReadonlyArray<{ path: string; family: string }> = [
  { path: 'C:/Windows/Fonts/segoeuib.ttf', family: 'SimPhysDisplay' },
  { path: 'C:/Windows/Fonts/arialbd.ttf', family: 'SimPhysDisplay' },
  { path: '/usr/share/fonts/truetype/dejavu/DejaVuSans-Bold.ttf', family: 'SimPhysDisplay' },
  { path: '/System/Library/Fonts/Helvetica.ttc', family: 'SimPhysDisplay' },
];

let fontsReady = false;

export function registerFonts(): string {
  if (fontsReady) return 'SimPhysDisplay';
  for (const c of DISPLAY_CANDIDATES) {
    if (existsSync(c.path) && GlobalFonts.registerFromPath(c.path, c.family)) {
      setFonts({ display: c.family });
      fontsReady = true;
      return c.family;
    }
  }
  // Repli : on garde la famille générique, le texte sortira avec la police par
  // défaut de la plateforme.
  fontsReady = true;
  return 'sans-serif';
}

class NodeSurface implements Surface {
  readonly canvas: Canvas;
  readonly ctx: Ctx2D;

  constructor(width: number, height: number) {
    this.canvas = createCanvas(width, height);
    this.ctx = this.canvas.getContext('2d') as unknown as Ctx2D;
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

export function installNodeSurfaces(): void {
  registerFonts();
  installSurfaceFactory((w, h) => new NodeSurface(w, h));
}

export function createNodeSurface(width: number, height: number): NodeSurface {
  return new NodeSurface(width, height);
}

export type { NodeSurface };
