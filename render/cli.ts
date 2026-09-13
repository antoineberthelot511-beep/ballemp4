import { resolve } from 'node:path';
import type { SimConfig } from '../engine/types.ts';
import { resolveSimConfig } from '../engine/world.ts';
import { getSim, SIMS } from '../sims/registry.ts';
import { dryRun, renderToFile } from './headless.ts';
import { ffmpegVersion } from './ffmpeg.ts';

interface Args {
  sim: string;
  seed?: string;
  duration?: number;
  fps?: number;
  width?: number;
  height?: number;
  substeps?: number;
  title?: string;
  out?: string;
  crf?: number;
  preset?: string;
  input: 'png' | 'rgba';
  audio: boolean;
  framesDir: string | null;
  verbose: boolean;
  check: number | null;
  params: Record<string, number>;
}

function parseArgs(argv: readonly string[]): Args {
  const a: Args = {
    sim: 'bounce',
    input: 'png',
    audio: true,
    framesDir: null,
    verbose: false,
    check: null,
    params: {},
  };
  for (let i = 0; i < argv.length; i++) {
    const arg = argv[i];
    const next = () => {
      const v = argv[++i];
      if (v === undefined) throw new Error(`Option ${arg} : valeur manquante`);
      return v;
    };
    switch (arg) {
      case '--sim': a.sim = next(); break;
      case '--seed': a.seed = next(); break;
      case '--duration': a.duration = Number(next()); break;
      case '--fps': a.fps = Number(next()); break;
      case '--width': a.width = Number(next()); break;
      case '--height': a.height = Number(next()); break;
      case '--substeps': a.substeps = Number(next()); break;
      case '--title': a.title = next(); break;
      case '--burst': a.params.burstAfter = Number(next()); break;
      case '--param': {
        const raw = next();
        const eq = raw.indexOf('=');
        if (eq < 0) throw new Error(`--param attend "clé=valeur", reçu "${raw}"`);
        const key = raw.slice(0, eq);
        const value = Number(raw.slice(eq + 1));
        if (!Number.isFinite(value)) throw new Error(`--param ${key} : valeur non numérique`);
        a.params[key] = value;
        break;
      }
      case '--out': a.out = next(); break;
      case '--crf': a.crf = Number(next()); break;
      case '--preset': a.preset = next(); break;
      case '--raw': a.input = 'rgba'; break;
      case '--no-audio': a.audio = false; break;
      case '--frames-dir': a.framesDir = next(); break;
      case '--verbose': a.verbose = true; break;
      // Rendu à blanc de N images, deux fois, pour prouver le déterminisme.
      case '--check': a.check = Number(argv[i + 1] && !argv[i + 1].startsWith('--') ? next() : '90'); break;
      case '--help':
      case '-h':
        printHelp();
        process.exit(0);
      default:
        throw new Error(`Option inconnue : ${arg}`);
    }
  }
  return a;
}

function printHelp(): void {
  console.log(`
Générateur de simulations physiques verticales.

  node render/cli.ts [options]

  --sim <id>          sim à rendre (${Object.keys(SIMS).join(', ')})   [bounce]
  --seed <str>        graine ; une graine = une vidéo identique
  --duration <s>      durée en secondes
  --fps <n>           images par seconde                                [60]
  --width/--height    résolution                                        [1080x1920]
  --substeps <n>      sous-pas d'intégration par image
  --title <str>       titre affiché dans le HUD
  --burst <s>         pour "bounce" : secondes avant que la bille fasse éclater
                      le cercle, de 10 à 120
  --param <clé=val>   réglage libre de la sim (répétable)

  Pour "bounce", --duration et --burst sont indépendants : donne l'un et l'autre
  se déduit (durée = éclatement + 2,2 s), ou donne les deux pour tout contrôler.
  --out <path>        fichier mp4                          [out/<sim>-<seed>.mp4]
  --crf <n>           qualité x264, plus bas = mieux                     [18]
  --preset <name>     preset x264                                       [slow]
  --raw               envoie du RGBA brut à ffmpeg au lieu de PNG (plus rapide)
  --no-audio          n'ajoute pas de piste audio
  --frames-dir <dir>  écrit aussi les PNG un par un
  --check [n]         vérifie le déterminisme sur n images, sans encoder  [90]
  --verbose           laisse ffmpeg s'exprimer
`);
}

async function main(): Promise<void> {
  const args = parseArgs(process.argv.slice(2));
  const sim = getSim(args.sim);

  const overrides: Partial<SimConfig> = {};
  if (args.seed !== undefined) overrides.seed = args.seed;
  if (args.duration !== undefined) overrides.duration = args.duration;
  if (args.fps !== undefined) overrides.fps = args.fps;
  if (args.width !== undefined) overrides.width = args.width;
  if (args.height !== undefined) overrides.height = args.height;
  if (args.substeps !== undefined) overrides.substeps = args.substeps;
  if (args.title !== undefined) overrides.title = args.title;
  if (Object.keys(args.params).length > 0) overrides.params = args.params;

  if (args.check !== null) {
    const n = args.check;
    console.log(`Vérification du déterminisme : ${n} images, deux exécutions…`);
    const a = dryRun(sim, overrides, n);
    const b = dryRun(sim, overrides, n);
    console.log(`  run A : ${a.digest.slice(0, 32)}…  (${a.audioEvents} événements audio)`);
    console.log(`  run B : ${b.digest.slice(0, 32)}…  (${b.audioEvents} événements audio)`);
    if (a.digest !== b.digest || a.audioEvents !== b.audioEvents) {
      console.error('ÉCHEC : les deux exécutions divergent.');
      process.exitCode = 1;
      return;
    }
    console.log('OK : rendu identique.');
    return;
  }

  const version = await ffmpegVersion();
  if (!version) {
    throw new Error("ffmpeg est introuvable dans le PATH. Installe-le, ou passe --check pour tester sans encoder.");
  }

  const seed = overrides.seed ?? sim.config.seed;
  const out = args.out ?? `out/${sim.config.id}-${seed}.mp4`;

  const resolved = resolveSimConfig(sim, overrides);
  const total = Math.round(resolved.duration * resolved.fps);
  console.log(
    `${resolved.id} · seed "${seed}" · ${resolved.duration.toFixed(2)} s · ${total} images · ` +
      `${args.input.toUpperCase()} -> ffmpeg`,
  );
  // Toute valeur que la sim n'a pas retenue telle quelle est signalée, plutôt
  // que corrigée en silence.
  if (args.duration !== undefined && Math.abs(args.duration - resolved.duration) > 1e-6) {
    console.log(
      `    note : durée ${args.duration} s trop courte pour montrer la fin, ` +
        `portée à ${resolved.duration.toFixed(2)} s.`,
    );
  }
  for (const [key, asked] of Object.entries(args.params)) {
    const kept = resolved.params[key];
    if (kept !== undefined && Math.abs(kept - asked) > 1e-6) {
      console.log(`    note : ${key} ${asked} hors bornes, ramené à ${kept}.`);
    }
  }

  const burstAfter = resolved.params.burstAfter;
  if (burstAfter !== undefined) {
    console.log(`    éclatement à ${burstAfter.toFixed(1)} s`);
    const after = resolved.duration - burstAfter;
    const tail = resolved.params.tail ?? 0;
    if (after > tail + 1) {
      console.log(
        `    note : ${after.toFixed(1)} s après l'éclatement, dont ~${(after - tail).toFixed(1)} s ` +
          `où la bille aura quitté le cadre.`,
      );
    }
  }

  let lastPct = -1;
  const startedAt = Date.now();
  const result = await renderToFile({
    sim,
    overrides,
    out,
    input: args.input,
    crf: args.crf,
    preset: args.preset,
    audio: args.audio,
    framesDir: args.framesDir,
    verbose: args.verbose,
    onProgress: (frame, all) => {
      const pct = Math.floor((frame / all) * 100);
      if (pct === lastPct) return;
      lastPct = pct;
      const elapsed = (Date.now() - startedAt) / 1000;
      const eta = frame > 0 ? (elapsed / frame) * (all - frame) : 0;
      process.stdout.write(
        `\r  ${String(pct).padStart(3)}%  ${frame}/${all}  ${(frame / elapsed).toFixed(1)} img/s  ETA ${eta.toFixed(0)}s   `,
      );
    },
  });
  process.stdout.write('\n');

  console.log(`OK  ${resolve(result.out)}`);
  console.log(
    `    ${result.width}x${result.height} · ${result.fps} fps · ${result.duration.toFixed(2)} s · ` +
      `${result.audioEvents} événements audio · ${(result.elapsedMs / 1000).toFixed(1)} s de rendu`,
  );
  console.log(`    empreinte images : ${result.digest.slice(0, 32)}…`);
}

main().catch((err) => {
  console.error(`\nErreur : ${err instanceof Error ? err.message : String(err)}`);
  process.exitCode = 1;
});
