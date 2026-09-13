export const TAU = Math.PI * 2;

export function clamp(v: number, lo: number, hi: number): number {
  return v < lo ? lo : v > hi ? hi : v;
}

export function lerp(a: number, b: number, t: number): number {
  return a + (b - a) * t;
}

/** Interpolation lissée sur [edge0, edge1], utile pour les fondus de HUD. */
export function smoothstep(edge0: number, edge1: number, x: number): number {
  const t = clamp((x - edge0) / (edge1 - edge0), 0, 1);
  return t * t * (3 - 2 * t);
}

export function length(x: number, y: number): number {
  return Math.hypot(x, y);
}

/** Ramène un vecteur à une norme donnée. Sans effet si le vecteur est nul. */
export function setLength(out: { x: number; y: number }, x: number, y: number, len: number): void {
  const m = Math.hypot(x, y);
  if (m < 1e-12) {
    out.x = len;
    out.y = 0;
    return;
  }
  const s = len / m;
  out.x = x * s;
  out.y = y * s;
}
