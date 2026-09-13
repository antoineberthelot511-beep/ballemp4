/**
 * Grille spatiale uniforme (broad phase).
 *
 * Déterminisme : les cellules sont parcourues dans l'ordre des index, et les
 * corps sont rangés dans chaque cellule par un tri par comptage stable. Deux
 * exécutions produisent donc exactement la même séquence de paires.
 *
 * Chaque paire n'est visitée qu'une fois : à l'intérieur d'une cellule, puis
 * vers quatre voisines « en avant » seulement (droite, bas-gauche, bas,
 * bas-droite).
 */

import type { Body } from './types.ts';

export type { Body };

const FORWARD_NEIGHBOURS: ReadonlyArray<readonly [number, number]> = [
  [1, 0],
  [-1, 1],
  [0, 1],
  [1, 1],
];

export class SpatialGrid {
  private cols = 0;
  private rows = 0;
  private cell = 1;
  private minX = 0;
  private minY = 0;
  private count = 0;

  private cellStart = new Int32Array(0);
  private cellOf = new Int32Array(0);
  private items = new Int32Array(0);

  /** Nombre maximal de cellules, pour borner la mémoire sur des rayons minuscules. */
  private readonly maxCells: number;

  constructor(maxCells = 1 << 20) {
    this.maxCells = maxCells;
  }

  build(bodies: readonly Body[]): void {
    const n = bodies.length;
    this.count = n;
    if (n === 0) {
      this.cols = this.rows = 0;
      return;
    }

    let minX = Infinity, minY = Infinity, maxX = -Infinity, maxY = -Infinity, maxR = 0;
    for (let i = 0; i < n; i++) {
      const b = bodies[i];
      if (b.x < minX) minX = b.x;
      if (b.y < minY) minY = b.y;
      if (b.x > maxX) maxX = b.x;
      if (b.y > maxY) maxY = b.y;
      if (b.r > maxR) maxR = b.r;
    }

    // Une cellule doit couvrir le plus gros diamètre : deux corps qui se
    // touchent sont alors toujours dans des cellules voisines ou identiques.
    let cell = Math.max(maxR * 2, 1e-6);
    let cols = Math.max(1, Math.ceil((maxX - minX) / cell) + 1);
    let rows = Math.max(1, Math.ceil((maxY - minY) / cell) + 1);
    while (cols * rows > this.maxCells) {
      cell *= 2;
      cols = Math.max(1, Math.ceil((maxX - minX) / cell) + 1);
      rows = Math.max(1, Math.ceil((maxY - minY) / cell) + 1);
    }

    this.cell = cell;
    this.cols = cols;
    this.rows = rows;
    this.minX = minX;
    this.minY = minY;

    const nCells = cols * rows;
    if (this.cellStart.length < nCells + 1) this.cellStart = new Int32Array(nCells + 1);
    else this.cellStart.fill(0, 0, nCells + 1);
    if (this.cellOf.length < n) this.cellOf = new Int32Array(n);
    if (this.items.length < n) this.items = new Int32Array(n);

    const counts = this.cellStart;
    for (let i = 0; i < n; i++) {
      const b = bodies[i];
      let cx = ((b.x - minX) / cell) | 0;
      let cy = ((b.y - minY) / cell) | 0;
      if (cx < 0) cx = 0; else if (cx >= cols) cx = cols - 1;
      if (cy < 0) cy = 0; else if (cy >= rows) cy = rows - 1;
      const c = cy * cols + cx;
      this.cellOf[i] = c;
      counts[c + 1]++;
    }
    for (let c = 0; c < nCells; c++) counts[c + 1] += counts[c];

    // Deuxième passe : insertion stable dans l'ordre croissant des index.
    const cursor = new Int32Array(nCells);
    for (let i = 0; i < n; i++) {
      const c = this.cellOf[i];
      this.items[counts[c] + cursor[c]] = i;
      cursor[c]++;
    }
  }

  /** Appelle `cb` une fois par paire de corps potentiellement en contact. */
  forEachPair(cb: (i: number, j: number) => void): void {
    const { cols, rows, cellStart, items } = this;
    if (this.count === 0) return;

    for (let cy = 0; cy < rows; cy++) {
      for (let cx = 0; cx < cols; cx++) {
        const c = cy * cols + cx;
        const s = cellStart[c];
        const e = cellStart[c + 1];
        if (s === e) continue;

        for (let a = s; a < e; a++) {
          const ia = items[a];
          for (let b = a + 1; b < e; b++) cb(ia, items[b]);
        }

        for (let k = 0; k < FORWARD_NEIGHBOURS.length; k++) {
          const nx = cx + FORWARD_NEIGHBOURS[k][0];
          const ny = cy + FORWARD_NEIGHBOURS[k][1];
          if (nx < 0 || ny < 0 || nx >= cols || ny >= rows) continue;
          const nc = ny * cols + nx;
          const ns = cellStart[nc];
          const ne = cellStart[nc + 1];
          for (let a = s; a < e; a++) {
            const ia = items[a];
            for (let b = ns; b < ne; b++) cb(ia, items[b]);
          }
        }
      }
    }
  }
}
