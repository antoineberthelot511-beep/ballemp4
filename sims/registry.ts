import type { AnySim } from '../engine/index.ts';
import bounce from './bounce.ts';
import bouncing from './bouncing.ts';

/**
 * Ajouter une sim = un fichier dans /sims + une ligne ici.
 * Chaque module exporte `{ config, init, step, draw }`.
 */
export const SIMS: Record<string, AnySim> = {
  bounce,
  bouncing,
};

export function getSim(id: string): AnySim {
  const sim = SIMS[id];
  if (!sim) {
    throw new Error(`Sim inconnue "${id}". Disponibles : ${Object.keys(SIMS).join(', ')}`);
  }
  return sim;
}
