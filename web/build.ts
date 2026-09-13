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
 * La page n'écrit ni `<!doctype>`, ni `<html>`, ni `<body>` : l'hôte de
 * publication enveloppe le contenu lui-même.
 */

const ROOT = resolve(import.meta.dirname, '..');

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
  const html = template
    .replace('<!--SOUNDS-->', `<script>window.__SIM_SOUNDS__=${JSON.stringify(sounds)};</script>`)
    .replace('<!--BUNDLE-->', `<script>${js}</script>`);

  const outDir = join(ROOT, 'web', 'dist');
  await mkdir(outDir, { recursive: true });
  const outFile = join(outDir, 'index.html');
  await writeFile(outFile, html, 'utf8');

  const soundKo = Object.values(sounds).reduce((a, s) => a + s.length, 0) / 1024;
  console.log(`page autonome : ${outFile}`);
  console.log(
    `  script ${(js.length / 1024).toFixed(1)} Ko · sons ${soundKo.toFixed(1)} Ko · total ${(html.length / 1024).toFixed(1)} Ko`,
  );
}

await main();
