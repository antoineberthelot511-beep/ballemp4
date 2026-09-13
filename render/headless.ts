import { createHash } from 'node:crypto';
import { mkdir, rm, writeFile } from 'node:fs/promises';
import { dirname, join, resolve } from 'node:path';
import type { AnySim, SimConfig } from '../engine/types.ts';
import { World } from '../engine/world.ts';
import { createNodeSurface, installNodeSurfaces } from './node-surface.ts';
import { muxAudio, startEncoder } from './ffmpeg.ts';
import { renderWav } from './wav.ts';
import { assetRoots, decodeReferencedSamples } from './audio-assets.ts';

/** Racine du projet : `render/` est un sous-dossier direct. */
const PROJECT_ROOT = resolve(import.meta.dirname, '..');

export interface RenderOptions {
  sim: AnySim;
  overrides?: Partial<SimConfig>;
  out: string;
  /** 'png' respecte la chaîne PNG -> ffmpeg ; 'rgba' est ~2x plus rapide. */
  input?: 'png' | 'rgba';
  crf?: number;
  preset?: string;
  audio?: boolean;
  /** Écrit aussi les PNG bruts dans ce dossier (débogage). */
  framesDir?: string | null;
  ffmpegPath?: string;
  verbose?: boolean;
  onProgress?: (frame: number, total: number) => void;
}

export interface RenderResult {
  out: string;
  frames: number;
  width: number;
  height: number;
  fps: number;
  duration: number;
  seed: string;
  audioEvents: number;
  /** Empreinte de toutes les images encodées : deux rendus du même seed la partagent. */
  digest: string;
  elapsedMs: number;
}

/**
 * Rendu image par image. La boucle est un simple `for` : aucune horloge murale,
 * aucun requestAnimationFrame, aucune image sautée. L'image n est produite
 * après exactement n appels à `World.advanceFrame()`.
 */
export async function renderToFile(opts: RenderOptions): Promise<RenderResult> {
  const started = Date.now();
  installNodeSurfaces();

  const world = new World(opts.sim, opts.overrides ?? {});
  const { width, height, fps, seed } = world.config;
  const total = world.totalFrames;
  const useAudio = opts.audio !== false;
  const inputFormat = opts.input ?? 'png';

  const outPath = resolve(opts.out);
  await mkdir(dirname(outPath), { recursive: true });
  if (opts.framesDir) await mkdir(resolve(opts.framesDir), { recursive: true });

  // Sans audio on encode directement vers la destination ; sinon on passe par
  // un fichier vidéo temporaire, remuxé à la fin.
  const videoPath = useAudio ? `${outPath}.video.mp4` : outPath;

  const surface = createNodeSurface(width, height);
  const canvas = surface.canvas;
  const hash = createHash('sha256');

  const encoder = startEncoder({
    out: videoPath,
    width,
    height,
    fps,
    input: inputFormat,
    crf: opts.crf,
    preset: opts.preset,
    ffmpegPath: opts.ffmpegPath,
    verbose: opts.verbose,
  });

  try {
    for (let f = 0; f < total; f++) {
      world.advanceFrame();
      world.render(surface.ctx);

      // L'empreinte porte toujours sur les pixels bruts, jamais sur les octets
      // transmis : elle reste donc comparable entre --raw et le mode PNG.
      const pixels = canvas.data();
      hash.update(pixels);

      const frameBuf: Buffer = inputFormat === 'png' ? canvas.encodeSync('png') : pixels;
      await encoder.writeFrame(frameBuf);

      if (opts.framesDir && inputFormat === 'png') {
        await writeFile(join(resolve(opts.framesDir), `${String(f).padStart(6, '0')}.png`), frameBuf);
      }

      opts.onProgress?.(f + 1, total);
    }
    await encoder.finish();
  } catch (err) {
    await rm(videoPath, { force: true }).catch(() => {});
    throw err;
  }

  if (useAudio) {
    const wavPath = `${outPath}.audio.wav`;
    const sampleRate = 48000;
    const names = [...new Set(world.audio.events.map((e) => e.sample).filter((s): s is string => !!s))];
    const samples = await decodeReferencedSamples(
      names,
      sampleRate,
      assetRoots(PROJECT_ROOT),
      opts.ffmpegPath,
    );
    const wav = renderWav(world.audio.events, {
      duration: total / fps,
      sampleRate,
      seed: `${seed}/wav`,
      samples,
    });
    await writeFile(wavPath, wav);
    try {
      await muxAudio(videoPath, wavPath, outPath, {
        ffmpegPath: opts.ffmpegPath,
        verbose: opts.verbose,
      });
    } finally {
      await rm(videoPath, { force: true }).catch(() => {});
      await rm(wavPath, { force: true }).catch(() => {});
    }
  }

  return {
    out: outPath,
    frames: total,
    width,
    height,
    fps,
    duration: total / fps,
    seed,
    audioEvents: world.audio.events.length,
    digest: hash.digest('hex'),
    elapsedMs: Date.now() - started,
  };
}

/**
 * Rendu « à blanc » : avance la simulation et dessine, mais n'encode rien.
 * Sert à vérifier le déterminisme sans payer le coût de ffmpeg.
 */
export function dryRun(sim: AnySim, overrides: Partial<SimConfig> = {}, frames?: number): {
  digest: string;
  frames: number;
  audioEvents: number;
} {
  installNodeSurfaces();
  const world = new World(sim, overrides);
  const surface = createNodeSurface(world.config.width, world.config.height);
  const n = Math.min(frames ?? world.totalFrames, world.totalFrames);
  const hash = createHash('sha256');
  for (let f = 0; f < n; f++) {
    world.advanceFrame();
    world.render(surface.ctx);
    hash.update(surface.canvas.data());
  }
  return { digest: hash.digest('hex'), frames: n, audioEvents: world.audio.events.length };
}
