import type { Surface, SurfaceFactory } from './types.ts';

let factory: SurfaceFactory | null = null;

/**
 * Installé une fois par l'hôte : `render/node-surface.ts` en headless,
 * `preview/browser-surface.ts` dans le navigateur. Le moteur et les sims
 * n'appellent que `createSurface`, ce qui les garde indépendants de la
 * plateforme.
 */
export function installSurfaceFactory(f: SurfaceFactory): void {
  factory = f;
}

export function createSurface(width: number, height: number): Surface {
  if (!factory) {
    throw new Error(
      'Aucune SurfaceFactory installée. Appelle installSurfaceFactory() avant de créer une sim.',
    );
  }
  return factory(Math.max(1, Math.ceil(width)), Math.max(1, Math.ceil(height)));
}
