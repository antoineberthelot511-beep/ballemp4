import { spawn } from 'node:child_process';
import { once } from 'node:events';

export interface EncoderOptions {
  out: string;
  width: number;
  height: number;
  fps: number;
  /** Format des images envoyées sur stdin. */
  input: 'png' | 'rgba';
  crf?: number;
  preset?: string;
  ffmpegPath?: string;
  /** Affiche la ligne de commande et laisse ffmpeg parler. */
  verbose?: boolean;
}

export interface Encoder {
  /** Écrit une image. Respecte la contre-pression du pipe. */
  writeFrame(buf: Buffer | Uint8Array): Promise<void>;
  /** Ferme stdin et attend la fin de l'encodage. */
  finish(): Promise<void>;
  readonly args: readonly string[];
}

function buildArgs(o: EncoderOptions): string[] {
  const fps = String(o.fps);
  const args: string[] = ['-y', '-hide_banner'];
  if (!o.verbose) args.push('-loglevel', 'error');

  if (o.input === 'png') {
    args.push('-f', 'image2pipe', '-framerate', fps, '-c:v', 'png', '-i', 'pipe:0');
  } else {
    args.push(
      '-f', 'rawvideo',
      '-pix_fmt', 'rgba',
      '-s', `${o.width}x${o.height}`,
      '-framerate', fps,
      '-i', 'pipe:0',
    );
  }

  args.push(
    '-c:v', 'libx264',
    '-preset', o.preset ?? 'slow',
    '-crf', String(o.crf ?? 18),
    '-pix_fmt', 'yuv420p',
    '-profile:v', 'high',
    // 1080x1920 @ 60 fps tient tout juste dans le niveau 4.2.
    '-level', '4.2',
    '-r', fps,
    // Un keyframe toutes les 2 s : indispensable pour que le scrubbing et le
    // réencodage côté plateforme restent propres.
    '-g', String(o.fps * 2),
    '-keyint_min', fps,
    '-sc_threshold', '0',
  );

  args.push('-an', '-movflags', '+faststart', o.out);
  return args;
}

/**
 * Colle la piste audio sur la vidéo déjà encodée, sans réencoder l'image.
 *
 * Deux passes plutôt qu'une : le WAV n'existe qu'une fois la simulation
 * terminée (les impacts ne sont connus qu'au fil du temps), et ffmpeg veut son
 * entrée audio au lancement. Le remux est en copie de flux, donc quasi gratuit.
 */
export async function muxAudio(
  videoPath: string,
  wavPath: string,
  outPath: string,
  opts: { ffmpegPath?: string; verbose?: boolean } = {},
): Promise<void> {
  const args = ['-y', '-hide_banner'];
  if (!opts.verbose) args.push('-loglevel', 'error');
  args.push(
    '-i', videoPath,
    '-i', wavPath,
    '-map', '0:v:0',
    '-map', '1:a:0',
    '-c:v', 'copy',
    '-c:a', 'aac',
    '-b:a', '192k',
    '-ar', '48000',
    '-ac', '2',
    '-shortest',
    '-movflags', '+faststart',
    outPath,
  );
  const child = spawn(opts.ffmpegPath ?? 'ffmpeg', args, { stdio: ['ignore', 'inherit', 'inherit'] });
  const [code] = (await once(child, 'close')) as [number | null];
  if (code !== 0) throw new Error(`Le mux audio a échoué (code ${code})`);
}

export function startEncoder(o: EncoderOptions): Encoder {
  const args = buildArgs(o);
  const bin = o.ffmpegPath ?? 'ffmpeg';
  const child = spawn(bin, args, { stdio: ['pipe', 'inherit', 'inherit'] });
  const stdin = child.stdin;

  let failure: Error | null = null;
  child.on('error', (err) => {
    failure = new Error(`Impossible de lancer "${bin}" : ${err.message}`);
  });
  // Un pipe fermé par ffmpeg avant la fin ne doit pas tuer le process Node ;
  // l'erreur réelle remonte via le code de sortie.
  stdin.on('error', () => {});

  const exited = once(child, 'close') as Promise<[number | null, NodeJS.Signals | null]>;

  return {
    args,
    async writeFrame(buf) {
      if (failure) throw failure;
      if (!stdin.write(buf)) {
        await once(stdin, 'drain');
      }
    },
    async finish() {
      if (failure) throw failure;
      await new Promise<void>((resolve) => stdin.end(resolve));
      const [code] = await exited;
      if (failure) throw failure;
      if (code !== 0) throw new Error(`ffmpeg a terminé avec le code ${code}`);
    },
  };
}

export async function ffmpegVersion(bin = 'ffmpeg'): Promise<string | null> {
  const child = spawn(bin, ['-version'], { stdio: ['ignore', 'pipe', 'ignore'] });
  let out = '';
  child.stdout.on('data', (c) => {
    out += String(c);
  });
  const [code] = (await once(child, 'close')) as [number | null];
  if (code !== 0) return null;
  return out.split('\n')[0] ?? null;
}
