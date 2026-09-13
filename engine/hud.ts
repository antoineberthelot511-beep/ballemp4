import type { Ctx2D } from './types.ts';
import type { Palette } from './palette.ts';
import { fonts } from './fonts.ts';
import { clamp, smoothstep } from './math.ts';

/**
 * Zones sûres du format vertical 1080x1920 : l'interface de TikTok/Reels
 * recouvre le bas et la colonne de droite. Tout le HUD reste en dehors.
 */
export const SAFE = {
  top: 190,
  bottom: 380,
  left: 60,
  right: 190,
};

export interface HudOptions {
  /** Surtitre. Omis, rien n'est dessiné au-dessus du compteur. */
  title?: string;
  /** Valeur du compteur, affichée en gros. */
  value: number;
  /** Libellé sous le compteur, ex. « BOUNCE ». */
  label?: string;
  palette: Palette;
  /** Avancement 0..1 : dessine un fin liseré en haut de l'écran. */
  progress?: number;
  /** Fondu d'entrée sur les premières images. */
  fade?: number;
  /** Impulsion 0..1 déclenchée quand le compteur change, pour le « pop ». */
  pulse?: number;
  /** Couleur du chiffre. Par défaut l'encre de la palette. */
  valueColor?: string;
  /** Corps du chiffre, en pixels. */
  valueSize?: number;
}

/** Point d'ancrage du compteur, pour aligner dessus des éléments annexes. */
export function counterAnchor(width: number): { x: number; y: number } {
  return { x: width / 2, y: SAFE.top + 40 };
}

function formatCount(n: number): string {
  return n.toLocaleString('en-US');
}

export function drawHud(ctx: Ctx2D, width: number, height: number, o: HudOptions): void {
  const p = o.palette;
  const fade = clamp(o.fade ?? 1, 0, 1);
  if (fade <= 0) return;

  ctx.save();
  ctx.globalAlpha = fade;
  ctx.textAlign = 'center';

  // Liseré de progression, tout en haut.
  if (o.progress !== undefined) {
    const w = width * clamp(o.progress, 0, 1);
    ctx.fillStyle = p.dim;
    ctx.fillRect(0, 0, width, 6);
    ctx.fillStyle = p.ink;
    ctx.fillRect(0, 0, w, 6);
  }

  const anchor = counterAnchor(width);

  if (o.title) {
    ctx.font = `600 46px ${fonts.display}`;
    ctx.textBaseline = 'alphabetic';
    ctx.fillStyle = p.dim;
    ctx.fillText(o.title.toUpperCase(), anchor.x, SAFE.top - 60);
  }

  // Compteur. Le « pop » est franc mais court : c'est lui qui donne la
  // récompense visuelle à chaque impact, donc il doit se voir sans fatiguer.
  const pulse = clamp(o.pulse ?? 0, 0, 1);
  const eased = smoothstep(0, 1, pulse);
  const size = o.valueSize ?? 210;

  ctx.save();
  ctx.translate(anchor.x, anchor.y);
  ctx.scale(1 + 0.16 * eased, 1 + 0.16 * eased);
  ctx.font = `800 ${size}px ${fonts.display}`;
  ctx.textBaseline = 'middle';

  const text = formatCount(o.value);
  // Halo derrière le chiffre : garantit la lisibilité si la scène passe
  // derrière lui.
  ctx.shadowColor = 'rgba(0,0,0,0.6)';
  ctx.shadowBlur = 40;
  ctx.fillStyle = o.valueColor ?? p.ink;
  ctx.fillText(text, 0, 0);
  ctx.shadowBlur = 0;
  ctx.restore();

  if (o.label) {
    ctx.font = `700 42px ${fonts.display}`;
    ctx.textBaseline = 'alphabetic';
    ctx.fillStyle = p.dim;
    ctx.fillText(o.label.toUpperCase(), anchor.x, anchor.y + size * 0.62);
  }

  ctx.restore();
}

/** Vignette sombre : concentre le regard au centre. */
export function drawVignette(ctx: Ctx2D, width: number, height: number, strength = 0.55): void {
  const cx = width / 2;
  const cy = height / 2;
  const inner = Math.min(width, height) * 0.42;
  const outer = Math.hypot(width, height) * 0.62;
  const g = ctx.createRadialGradient(cx, cy, inner, cx, cy, outer);
  g.addColorStop(0, 'rgba(0,0,0,0)');
  g.addColorStop(1, `rgba(0,0,0,${strength})`);
  ctx.fillStyle = g;
  ctx.fillRect(0, 0, width, height);
}
