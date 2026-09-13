import { build } from 'esbuild';
import { mkdir, readFile, writeFile } from 'node:fs/promises';
import { join, resolve } from 'node:path';
import { assetRoots, resolveAsset } from '../render/audio-assets.ts';
import { SIMS } from '../sims/registry.ts';

/**
 * Construit une page autonome, prête à être publiée en ligne.
 *
 * Une page publiée ne peut rien charger depuis un autre hôte : tout — script et
 * sons — doit vivre dans le fichier. Le script est donc empaqueté en un seul
 * bloc et les fichiers audio sont encodés en base64.
 *
 * Le résultat est un document HTML complet, avec son charset et son viewport :
 * c'est ce qu'attend un hébergeur statique comme Vercel, qui sert le fichier
 * tel quel. Seul un hôte qui enveloppe lui-même le contenu — l'hôte d'artefact
 * Claude — veut l'inverse : `--fragment` ne garde alors que l'intérieur du
 * `<head>` et du `<body>`.
 */

const ROOT = resolve(import.meta.dirname, '..');

/**
 * Réduit le document à son contenu utile. Les `<meta>` du `<head>` sont
 * écartés : c'est l'hôte enveloppant qui pose les siens.
 */
function toFragment(html: string): string {
  const head = /<head>([\s\S]*?)<\/head>/.exec(html)?.[1] ?? '';
  const body = /<body>([\s\S]*?)<\/body>/.exec(html)?.[1] ?? '';
  const kept = head.replace(/^[ \t]*<meta\b[^>]*>[ \t]*\r?\n/gm, '').trim();
  return `${kept}\n\n${body.trim()}\n`;
}

async function main(): Promise<void> {
  const bundle = await build({
    entryPoints: [join(ROOT, 'web', 'app.ts')],
    bundle: true,
    format: 'iife',
    target: 'es2022',
    minify: true,
    write: false,
    legalComments: 'none',
  });
  const js = bundle.outputFiles[0].text;

  // La page sert plusieurs sims via `?sim=` : on embarque les sons de toutes,
  // sinon celle qui n'est pas la sim par défaut serait muette.
  const names = new Set<string>();
  for (const s of Object.values(SIMS)) for (const a of s.assets ?? []) names.add(a);

  const roots = assetRoots(ROOT);
  const sounds: Record<string, string> = {};
  for (const name of names) {
    const path = resolveAsset(name, roots);
    if (!path) throw new Error(`Son "${name}" introuvable dans ${roots.join(', ')}`);
    sounds[name] = (await readFile(path)).toString('base64');
  }

  const template = await readFile(join(ROOT, 'web', 'page.html'), 'utf8');
  const page = template
    .replace('<!--SOUNDS-->', `<script>window.__SIM_SOUNDS__=${JSON.stringify(sounds)};</script>`)
    .replace('<!--BUNDLE-->', `<script>${js}</script>`);

  const fragment = process.argv.includes('--fragment');
  const html = fragment ? toFragment(page) : page;

  const outDir = join(ROOT, 'web', 'dist');
  await mkdir(outDir, { recursive: true });
  const outFile = join(outDir, 'index.html');
  await writeFile(outFile, html, 'utf8');

  const soundKo = Object.values(sounds).reduce((a, s) => a + s.length, 0) / 1024;
  console.log(`page autonome : ${outFile}${fragment ? ' (fragment)' : ''}`);
  console.log(
    `  script ${(js.length / 1024).toFixed(1)} Ko · sons ${soundKo.toFixed(1)} Ko · total ${(html.length / 1024).toFixed(1)} Ko`,
  );
}

await main();
