import { spawn } from 'node:child_process';
import { once } from 'node:events';
import { createServer } from 'node:http';
import { readFile, stat } from 'node:fs/promises';
import { extname, join, normalize, resolve } from 'node:path';

/**
 * Serveur de développement minimal : compile /preview + /engine + /sims en JS,
 * puis sert le tout. Pas de bundler — le navigateur charge les modules ES tels
 * que `tsc` les émet.
 */

const ROOT = resolve(import.meta.dirname, '..');
const PORT = Number(process.env.PORT ?? 5173);

const MIME: Record<string, string> = {
  '.html': 'text/html; charset=utf-8',
  '.js': 'text/javascript; charset=utf-8',
  '.map': 'application/json; charset=utf-8',
  '.css': 'text/css; charset=utf-8',
  '.json': 'application/json; charset=utf-8',
  '.png': 'image/png',
  '.mp3': 'audio/mpeg',
  '.wav': 'audio/wav',
  '.ogg': 'audio/ogg',
  '.m4a': 'audio/mp4',
  '.svg': 'image/svg+xml',
};

async function build(watch: boolean): Promise<void> {
  // On lance le point d'entrée JS de tsc avec le Node courant, plutôt que
  // `npx`. Passer par npx obligerait soit à `shell: true` (avertissement de
  // dépréciation Node dès qu'on lui passe des arguments), soit à viser
  // `npx.cmd`, que Node 24 refuse de spawner sans shell sous Windows (EINVAL).
  const tsc = join(ROOT, 'node_modules', 'typescript', 'bin', 'tsc');
  const args = [tsc, '-p', 'tsconfig.preview.json'];
  if (watch) args.push('--watch', '--preserveWatchOutput');
  const child = spawn(process.execPath, args, { cwd: ROOT, stdio: 'inherit' });
  if (watch) return;
  const [code] = (await once(child, 'close')) as [number | null];
  if (code !== 0) throw new Error(`La compilation TypeScript a échoué (code ${code})`);
}

async function serve(): Promise<void> {
  const server = createServer(async (req, res) => {
    try {
      const url = new URL(req.url ?? '/', 'http://localhost');
      let rel = decodeURIComponent(url.pathname);
      if (rel === '/' || rel === '') rel = '/preview/index.html';

      // Empêche de sortir de la racine du projet via `..`.
      const target = join(ROOT, normalize(rel).replace(/^([/\\])+/, ''));
      if (!target.startsWith(ROOT)) {
        res.writeHead(403).end('Interdit');
        return;
      }

      const info = await stat(target).catch(() => null);
      if (!info || !info.isFile()) {
        res.writeHead(404).end('Introuvable');
        return;
      }

      const body = await readFile(target);
      res.writeHead(200, {
        'content-type': MIME[extname(target)] ?? 'application/octet-stream',
        'cache-control': 'no-store',
      });
      res.end(body);
    } catch (err) {
      res.writeHead(500).end(err instanceof Error ? err.message : 'Erreur');
    }
  });

  await new Promise<void>((r) => server.listen(PORT, r));
  console.log(`\nPreview : http://localhost:${PORT}/preview/index.html`);
  console.log(`          ?sim=bounce&seed=abc&duration=20\n`);
}

const watch = process.argv.includes('--watch');
await build(watch);
await serve();
