import type { Body } from './grid.ts';

/**
 * La masse suit l'aire : une bille deux fois plus grande pousse quatre fois
 * plus fort. Sans ça, les grosses billes se font éjecter par les petites.
 */
export function mass(b: Body): number {
  return b.r * b.r;
}

export interface ImpactInfo {
  /** Vitesse relative le long de la normale, avant résolution (>= 0). */
  speed: number;
  /** Point de contact. */
  x: number;
  y: number;
  nx: number;
  ny: number;
}

/**
 * Collision disque/disque élastique, avec correction de position pour éliminer
 * l'interpénétration. Retourne les infos d'impact, ou `null` s'il n'y a pas
 * contact.
 */
export function resolvePair(a: Body, b: Body, restitution: number, out: ImpactInfo): boolean {
  const dx = b.x - a.x;
  const dy = b.y - a.y;
  const rsum = a.r + b.r;
  const d2 = dx * dx + dy * dy;
  if (d2 >= rsum * rsum) return false;

  // `|| 1e-6` : garde arithmétique, aucune division par zéro n'est possible.
  const d = Math.sqrt(d2) || 1e-6;
  let nx: number;
  let ny: number;
  if (d2 < 1e-18) {
    // Centres confondus. Une normale nulle laisserait la paire collée pour
    // toujours (la séparation ne pousserait dans aucune direction), donc on
    // impose une normale arbitraire — mais fixe, pour rester déterministe.
    nx = 1;
    ny = 0;
  } else {
    nx = dx / d;
    ny = dy / d;
  }

  const ma = mass(a);
  const mb = mass(b);
  const total = ma + mb;

  // Séparation proportionnelle à l'inverse de la masse.
  const overlap = rsum - d;
  a.x -= nx * overlap * (mb / total);
  a.y -= ny * overlap * (mb / total);
  b.x += nx * overlap * (ma / total);
  b.y += ny * overlap * (ma / total);

  const rvx = b.vx - a.vx;
  const rvy = b.vy - a.vy;
  const vn = rvx * nx + rvy * ny;

  out.x = a.x + nx * a.r;
  out.y = a.y + ny * a.r;
  out.nx = nx;
  out.ny = ny;
  out.speed = vn < 0 ? -vn : 0;

  // Déjà en train de se séparer : on a corrigé la position, pas d'impulsion.
  if (vn > 0) return true;

  const j = (-(1 + restitution) * vn) / (1 / ma + 1 / mb);
  a.vx -= (j * nx) / ma;
  a.vy -= (j * ny) / ma;
  b.vx += (j * nx) / mb;
  b.vy += (j * ny) / mb;
  return true;
}

/**
 * Confine un corps à l'intérieur d'une arène circulaire.
 * Retourne la vitesse d'impact normale, ou 0 s'il n'a pas touché le bord.
 */
export function containInCircle(
  b: Body,
  cx: number,
  cy: number,
  radius: number,
  restitution: number,
): number {
  const dx = b.x - cx;
  const dy = b.y - cy;
  // `|| 1e-6` : garde arithmétique. Le cas dégénéré (corps exactement au
  // centre) sort de toute façon par le test suivant, puisque 1e-6 <= limit.
  const d = Math.hypot(dx, dy) || 1e-6;
  const limit = radius - b.r;
  if (d <= limit) return 0;

  const nx = dx / d;
  const ny = dy / d;

  // 1) Repositionner SUR la paroi. Sans ça le corps reste à l'extérieur et
  //    redéclenche la collision à chaque pas, sans jamais s'en dégager.
  b.x = cx + nx * limit;
  b.y = cy + ny * limit;

  // 2) Ne réfléchir que s'il s'éloigne effectivement du centre. Sans ce test
  //    il est réfléchi deux pas de suite et repart droit vers la paroi.
  //    Les deux étapes sont indissociables.
  const vn = b.vx * nx + b.vy * ny;
  if (vn <= 0) return 0;
  b.vx -= (1 + restitution) * vn * nx;
  b.vy -= (1 + restitution) * vn * ny;
  return vn;
}

/** Un disque qui tourne sur lui-même. */
export interface SpinBody extends Body {
  /** Vitesse angulaire, en rad/s. Positive = sens horaire à l'écran. */
  omega: number;
}

/**
 * Une paroi refermée, presque circulaire : rayon R·(1 + A·cos(k·θ + φ)).
 * `amplitude` nulle redonne exactement un cercle.
 *
 * Deux régimes d'usage, selon le rapport entre amplitude et nombre de lobes :
 *
 * - **ondulation visible** (A de quelques %, k petit) : la paroi a une forme
 *   propre, qu'il faut dessiner telle quelle ;
 * - **micro-rugosité** (A sous le pixel, k grand) : la paroi EST un cercle à la
 *   résolution de rendu, mais sa pente locale suffit à disperser les rebonds.
 *
 * L'inclinaison de la normale vaut atan(A·k) — elle dépend du produit — tandis
 * que l'écart visible vaut A·R et ne dépend que de l'amplitude. On peut donc
 * obtenir toute la dispersion voulue sans déformer le cercle d'un pixel.
 */
export interface LobedWall {
  cx: number;
  cy: number;
  radius: number;
  /** Nombre de lobes sur le tour. */
  lobes: number;
  /** Amplitude des lobes, en fraction du rayon. */
  amplitude: number;
  phase: number;
  restitution: number;
  /** Frottement de contact, pour le couplage avec la rotation. */
  friction: number;
}

/**
 * Confinement dans une paroi lobée, avec frottement et rotation.
 *
 * Le cercle parfait est un billard intégrable : l'angle d'incidence y est
 * conservé, la bille répète la même figure indéfiniment et aucun réglage de
 * frottement n'y change quoi que ce soit — le frottement se contente de faire
 * converger le mouvement vers un aller-retour radial ou vers un roulement le
 * long de la paroi. Il faut casser la symétrie de révolution, et il suffit pour
 * cela d'une rugosité sous le pixel dès lors que le nombre de lobes est élevé
 * (voir `LobedWall`).
 *
 * La normale n'est plus radiale. Pour une courbe polaire r(θ), elle vaut
 * (r·cosθ + r'·sinθ, r·sinθ − r'·cosθ), qui redonne bien la direction radiale
 * quand r' = 0.
 *
 * Retourne la vitesse normale d'impact, ou 0 s'il n'y a pas eu contact.
 */
export function containInLobedCircle(b: SpinBody, wall: LobedWall): number {
  const dx = b.x - wall.cx;
  const dy = b.y - wall.cy;
  const d = Math.hypot(dx, dy) || 1e-6;

  const theta = Math.atan2(dy, dx);
  const arg = wall.lobes * theta + wall.phase;
  const rw = wall.radius * (1 + wall.amplitude * Math.cos(arg));
  const drw = -wall.radius * wall.amplitude * wall.lobes * Math.sin(arg);

  const limit = rw - b.r;
  if (d <= limit) return 0;

  const ct = Math.cos(theta);
  const st = Math.sin(theta);
  let nx = rw * ct + drw * st;
  let ny = rw * st - drw * ct;
  const nlen = Math.hypot(nx, ny) || 1e-6;
  nx /= nlen;
  ny /= nlen;

  // Replacement radial : exact pour un cercle, et l'écart vaut au plus A·R.
  b.x = wall.cx + ct * limit;
  b.y = wall.cy + st * limit;

  const vn = b.vx * nx + b.vy * ny;
  if (vn <= 0) return 0;

  const jn = (1 + wall.restitution) * vn;
  b.vx -= jn * nx;
  b.vy -= jn * ny;

  const tx = -ny;
  const ty = nx;
  const u = b.vx * tx + b.vy * ty + b.omega * b.r;

  let jt = -u / 3;
  const maxJt = wall.friction * jn;
  if (jt > maxJt) jt = maxJt;
  else if (jt < -maxJt) jt = -maxJt;

  b.vx += jt * tx;
  b.vy += jt * ty;
  b.omega += (2 * jt) / (b.r || 1e-6);

  // La normale inclinée peut, sur un choc rasant, renvoyer la bille vers
  // l'extérieur. Elle resterait alors hors de la paroi et redéclencherait la
  // collision à chaque pas. On rabat sur une réflexion radiale, qui garantit
  // qu'elle repart vers l'intérieur.
  const vrad = b.vx * ct + b.vy * st;
  if (vrad > 0) {
    b.vx -= 2 * vrad * ct;
    b.vy -= 2 * vrad * st;
  }

  return vn;
}

/**
 * Renormalise la vitesse. C'est ce qui rend l'animation « satisfaisante » :
 * l'énergie ne se dissipe jamais et le rythme des impacts reste constant,
 * même après des centaines de collisions.
 */
export function normalizeSpeed(b: Body, speed: number): void {
  const m = Math.hypot(b.vx, b.vy) || 1e-6;
  if (m <= 1e-6) {
    // Corps à l'arrêt : `|| 1e-6` éviterait le NaN mais laisserait la vitesse
    // à zéro. On relance dans une direction fixe, donc reproductible.
    b.vx = speed;
    b.vy = 0;
    return;
  }
  const s = speed / m;
  b.vx *= s;
  b.vy *= s;
}
