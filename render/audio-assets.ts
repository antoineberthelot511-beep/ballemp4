import { spawn } from 'node:child_process';
import { once } from 'node:events';
import { existsSync } from 'node:fs';
import { isAbsolute, join, resolve } from 'node:path';

/**
 * Décodage des fichiers son nommés par les `AudioEvent`.
 *
 * On passe par ffmpeg plutôt que par une bibliothèque de décodage : il est déjà
 * indispensable au pipeline, il lit tous les formats, et il fait le
 * rééchantillonnage vers la fréquence du mixage.
 */

export interface DecodedSample {
  left: Float32Array;
  right: Float32Array;
  sampleRate: number;
}

/** Dossiers fouillés, dans l'ordre, pour retrouver un fichier son. */
export function assetRoots(projectRoot: string): string[] {
  return [join(projectRoot, 'assets'), projectRoot];
}

export function resolveAsset(name: string, roots: readonly string[]): string | null {
  if (isAbsolute(name)) return existsSync(name) ? name : null;
  for (const root of roots) {
    const candidate = resolve(root, name);
    if (existsSync(candidate)) return candidate;
  }
  return null;
}

/**
 * Décode un fichier en PCM flottant stéréo à `sampleRate`, puis normalise à
 * pleine échelle. La normalisation rend le `gain` des événements prévisible :
 * un son enregistré bas et un son enregistré fort se comportent pareil.
 */
export async function decodeAudio(
  path: string,
  sampleRate: number,
  ffmpegPath = 'ffmpeg',
): Promise<DecodedSample> {
  const args = [
    '-v', 'error',
    '-i', path,
    '-f', 'f32le',
    '-acodec', 'pcm_f32le',
    '-ac', '2',
    '-ar', String(sampleRate),
    'pipe:1',
  ];
  const child = spawn(ffmpegPath, args, { stdio: ['ignore', 'pipe', 'inherit'] });

  const chunks: Buffer[] = [];
  child.stdout.on('data', (c: Buffer) => chunks.push(c));
  const [code] = (await once(child, 'close')) as [number | null];
  if (code !== 0) throw new Error(`ffmpeg n'a pas pu décoder "${path}" (code ${code})`);

  const raw = Buffer.concat(chunks);
  // Les échantillons sont entrelacés L,R,L,R… ; on tronque un éventuel demi-cadre.
  const frames = Math.floor(raw.length / 8);
  const left = new Float32Array(frames);
  const right = new Float32Array(frames);

  let peak = 0;
  for (let i = 0; i < frames; i++) {
    const l = raw.readFloatLE(i * 8);
    const r = raw.readFloatLE(i * 8 + 4);
    left[i] = l;
    right[i] = r;
    const m = Math.max(Math.abs(l), Math.abs(r));
    if (m > peak) peak = m;
  }
  if (peak > 1e-6 && Math.abs(peak - 1) > 1e-3) {
    const k = 1 / peak;
    for (let i = 0; i < frames; i++) {
      left[i] *= k;
      right[i] *= k;
    }
  }

  return { left, right, sampleRate };
}

/**
 * Décode tous les sons référencés par une liste d'événements. Un fichier
 * introuvable est signalé et ignoré : mieux vaut une vidéo sans ce bruitage
 * qu'un rendu qui échoue après plusieurs minutes d'encodage.
 */
export async function decodeReferencedSamples(
  names: readonly string[],
  sampleRate: number,
  roots: readonly string[],
  ffmpegPath = 'ffmpeg',
): Promise<Map<string, DecodedSample>> {
  const out = new Map<string, DecodedSample>();
  for (const name of names) {
    const path = resolveAsset(name, roots);
    if (!path) {
      console.warn(
        `    son "${name}" introuvable (cherché dans ${roots.join(', ')}) — impacts muets.`,
      );
      continue;
    }
    out.set(name, await decodeAudio(path, sampleRate, ffmpegPath));
  }
  return out;
}
