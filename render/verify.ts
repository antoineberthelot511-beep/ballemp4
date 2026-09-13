import type { AnySim, SimConfig } from '../engine/types.ts';
import { World } from '../engine/world.ts';
import { getSim, SIMS } from '../sims/registry.ts';
import { installNodeSurfaces } from './node-surface.ts';

/**
 * Vérification de santé d'une simulation, sans encodage vidéo.
 *
 * Le critère : le compteur doit atteindre sa cible sans jamais sauter par
 * paquets ni s'arrêter, et la norme de vitesse doit rester constante sur toute
 * la durée. Une dérive de vitesse est un problème d'énergie numérique, distinct
 * d'un blocage de boucle — c'est pourquoi les deux sont rapportés séparément.
 *
 *   node render/verify.ts --sim bounce --target 25
 */

interface Report {
  ok: boolean;
  frames: number;
  count: number;
  target: number;
  reachedAtFrame: number;
  jumps: Array<{ frame: number; from: number; to: number }>;
  stalls: number;
  minSpeed: number;
  maxSpeed: number;
  expectedSpeed: number | null;
  driftPct: number;
  nonFiniteAtFrame: number;
  problems: string[];
}

export function verify(
  sim: AnySim,
  overrides: Partial<SimConfig>,
  target: number,
  maxFrames: number,
): Report {
  installNodeSurfaces();
  if (!sim.probe) {
    throw new Error(`La sim "${sim.config.id}" n'expose pas de probe() ; rien à vérifier.`);
  }

  const world = new World(sim, overrides);
  const probe = sim.probe.bind(sim);
  const first = probe(world.state);
  const expectedSpeed = first.expectedSpeed ?? null;

  const r: Report = {
    ok: false,
    frames: 0,
    count: 0,
    target,
    reachedAtFrame: -1,
    jumps: [],
    stalls: 0,
    minSpeed: Infinity,
    maxSpeed: -Infinity,
    expectedSpeed,
    driftPct: 0,
    nonFiniteAtFrame: -1,
    problems: [],
  };

  let previous = first.count;
  // Images auxquelles le compteur a progressé, pour mesurer les écarts.
  const ticks: number[] = [];

  // Bornée par la durée de la sim : au-delà, on mesurerait l'après-fin. Pour une
  // sim qui se conclut (ici l'éclatement du cercle), le compteur s'arrête
  // légitimement, et compter cet arrêt comme un blocage n'aurait aucun sens.
  const horizon = Math.min(maxFrames, world.totalFrames);
  for (let f = 0; f < horizon; f++) {
    world.advanceFrame();
    r.frames = f + 1;

    const p = probe(world.state);
    r.count = p.count;

    for (const b of p.bodies) {
      const sp = Math.hypot(b.vx, b.vy);
      if (!Number.isFinite(sp) || !Number.isFinite(b.x) || !Number.isFinite(b.y)) {
        r.nonFiniteAtFrame = f;
        break;
      }
      if (sp < r.minSpeed) r.minSpeed = sp;
      if (sp > r.maxSpeed) r.maxSpeed = sp;
    }
    if (r.nonFiniteAtFrame >= 0) break;

    const delta = p.count - previous;
    if (delta > 1) r.jumps.push({ frame: f, from: previous, to: p.count });
    if (delta !== 0) ticks.push(f);
    previous = p.count;

    if (p.count >= target) {
      r.reachedAtFrame = f;
      break;
    }
  }

  // Écart maximal ENTRE deux progressions : la traîne finale, où le compteur ne
  // bouge plus par construction, n'est pas comptée.
  for (let i = 1; i < ticks.length; i++) {
    const gap = ticks[i] - ticks[i - 1];
    if (gap > r.stalls) r.stalls = gap;
  }
  if (r.expectedSpeed !== null && Number.isFinite(r.minSpeed)) {
    r.driftPct = ((r.maxSpeed - r.minSpeed) / r.expectedSpeed) * 100;
  }

  if (r.nonFiniteAtFrame >= 0) r.problems.push(`NaN ou Infinity à l'image ${r.nonFiniteAtFrame}`);
  if (r.reachedAtFrame < 0) r.problems.push(`compteur bloqué à ${r.count} après ${r.frames} images`);

  // Un saut de 2 est physiquement normal : un contact rasant peut faire toucher
  // la paroi deux fois dans la même image. Ce qu'on cherche à détecter, c'est
  // l'emballement — un corps coincé dans la paroi qui compte un impact à chaque
  // sous-pas. On ne s'alarme donc que sur un saut comparable au nombre de
  // sous-pas, ou sur des sauts trop fréquents pour être des frôlements.
  const worstJump = r.jumps.reduce((m, j) => Math.max(m, j.to - j.from), 0);
  const runawayJump = Math.max(3, Math.ceil((overrides.substeps ?? sim.config.substeps) / 2));
  if (worstJump >= runawayJump) {
    r.problems.push(`saut de compteur de ${worstJump} en une image (emballement probable)`);
  }
  const jumpBudget = Math.max(2, Math.ceil(r.count * 0.1));
  if (r.jumps.length > jumpBudget) {
    r.problems.push(`${r.jumps.length} sauts de compteur pour ${r.count} impacts`);
  }
  // 1e-6 % laisse passer le bruit flottant, mais pas une vraie dérive d'énergie.
  if (r.expectedSpeed !== null && r.driftPct > 1e-6) {
    r.problems.push(`dérive de vitesse ${r.driftPct.toExponential(3)} % (énergie numérique)`);
  }
  r.ok = r.problems.length === 0;
  return r;
}

function main(): void {
  const argv = process.argv.slice(2);
  let simId = 'bounce';
  let target = 25;
  let maxFrames = 200_000;
  // Pas de durée par défaut : on garde celle de la sim. Certaines ont un arc
  // scénarisé (montée puis dénouement) qu'un allongement arbitraire fausserait.
  const overrides: Partial<SimConfig> = {};

  for (let i = 0; i < argv.length; i++) {
    const v = argv[i + 1];
    switch (argv[i]) {
      case '--sim': simId = v; i++; break;
      case '--target': target = Number(v); i++; break;
      case '--max-frames': maxFrames = Number(v); i++; break;
      case '--duration': overrides.duration = Number(v); i++; break;
      case '--seed': overrides.seed = v; i++; break;
      case '--substeps': overrides.substeps = Number(v); i++; break;
      case '--burst':
        overrides.params = { ...overrides.params, burstAfter: Number(v) };
        i++;
        break;
      case '--param': {
        const eq = v.indexOf('=');
        if (eq < 0) throw new Error(`--param attend "clé=valeur", reçu "${v}"`);
        const value = Number(v.slice(eq + 1));
        if (!Number.isFinite(value)) throw new Error(`--param ${v.slice(0, eq)} : valeur non numérique`);
        overrides.params = { ...overrides.params, [v.slice(0, eq)]: value };
        i++;
        break;
      }
      case '--help':
      case '-h':
        console.log(
          `node render/verify.ts [--sim ${Object.keys(SIMS).join('|')}] [--target 25] [--seed x]` +
            ` [--burst s] [--param clé=val] [--duration s] [--substeps n]`,
        );
        return;
      default:
        throw new Error(`Option inconnue : ${argv[i]}`);
    }
  }

  const sim = getSim(simId);
  const r = verify(sim, overrides, target, maxFrames);

  console.log(`sim "${sim.config.id}" · graine "${overrides.seed ?? sim.config.seed}" · cible ${target}`);
  console.log(`  compteur           : ${r.count}${r.reachedAtFrame >= 0 ? ` atteint à l'image ${r.reachedAtFrame} (${(r.reachedAtFrame / sim.config.fps).toFixed(1)} s)` : ''}`);
  console.log(`  images simulées    : ${r.frames}`);
  console.log(
    `  doubles contacts   : ${r.jumps.length}` +
      `${r.jumps.length ? ` — ${JSON.stringify(r.jumps.slice(0, 3))}` : ''}`,
  );
  console.log(`  plus long écart    : ${r.stalls} images entre deux progressions`);
  if (r.expectedSpeed !== null) {
    console.log(`  vitesse attendue   : ${r.expectedSpeed}`);
    console.log(`  vitesse min / max  : ${r.minSpeed.toFixed(9)} / ${r.maxSpeed.toFixed(9)}`);
    console.log(`  dérive relative    : ${r.driftPct.toExponential(3)} %`);
  }
  console.log(`  NaN                : ${r.nonFiniteAtFrame < 0 ? 'aucun' : `image ${r.nonFiniteAtFrame}`}`);

  if (r.ok) {
    console.log('\nOK');
  } else {
    console.error(`\nÉCHEC : ${r.problems.join(' ; ')}`);
    process.exitCode = 1;
  }
}

main();
