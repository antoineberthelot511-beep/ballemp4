/**
 * Banque de sons partagée par la lecture temps réel et l'export.
 *
 * Deux provenances : une page servie par le serveur de développement va
 * chercher les fichiers par HTTP, une page publiée les trouve en base64 dans
 * `window.__SIM_SOUNDS__`, injecté au moment de la construction. Une page
 * publiée ne peut rien charger depuis un autre hôte, donc tout doit être
 * embarqué.
 */

declare global {
  interface Window {
    __SIM_SOUNDS__?: Record<string, string>;
  }
}

/**
 * Décode un tampon compressé, quelle que soit la forme de l'API.
 *
 * Safari n'a longtemps proposé que la forme à rappels, où `decodeAudioData`
 * renvoie `undefined` : un `await` dessus donne `undefined` au lieu d'un
 * AudioBuffer, et l'échantillon est perdu sans erreur. On accepte les deux.
 */
function decode(ctx: BaseAudioContext, data: ArrayBuffer): Promise<AudioBuffer> {
  return new Promise<AudioBuffer>((resolve, reject) => {
    let settled = false;
    const ok = (b: AudioBuffer) => {
      if (!settled) {
        settled = true;
        resolve(b);
      }
    };
    const ko = (e: unknown) => {
      if (!settled) {
        settled = true;
        reject(e instanceof Error ? e : new Error(String(e)));
      }
    };
    const maybe = ctx.decodeAudioData(data, ok, ko) as Promise<AudioBuffer> | undefined;
    if (maybe && typeof maybe.then === 'function') maybe.then(ok, ko);
  });
}

function base64ToBytes(b64: string): Uint8Array {
  const bin = atob(b64);
  const out = new Uint8Array(bin.length);
  for (let i = 0; i < bin.length; i++) out[i] = bin.charCodeAt(i);
  return out;
}

export class SoundBank {
  private readonly buffers = new Map<string, AudioBuffer>();
  /**
   * Octets encodés, tels qu'ils ont été lus.
   *
   * Un AudioBuffer appartient au contexte qui l'a décodé — c'est ce que dit
   * déjà la lecture temps réel, et l'export l'oubliait. Garder la source
   * permet à n'importe quel contexte, y compris l'OfflineAudioContext de
   * l'export, de se décoder ses propres tampons.
   */
  private readonly raw = new Map<string, Uint8Array>();
  private ctx: AudioContext | null = null;

  /** Noms qui n'ont pas pu être décodés au dernier essai. */
  readonly failed = new Set<string>();

  /**
   * L'unique AudioContext de la page, partagé avec la lecture temps réel.
   *
   * iOS plafonne le nombre de contextes et ne garantit rien sur un AudioBuffer
   * décodé par un contexte et joué par un autre : il n'en faut donc qu'un.
   */
  context(): AudioContext {
    if (!this.ctx) this.ctx = new AudioContext();
    return this.ctx;
  }

  get(name: string): AudioBuffer | undefined {
    return this.buffers.get(name);
  }

  /**
   * Décode ces sons pour le contexte donné, et pour lui seul.
   *
   * Récupère les octets si besoin — ce chemin-là ne réclame aucun geste de
   * l'utilisateur ni de contexte réveillé, contrairement au décodage.
   */
  async decodeFor(
    ctx: BaseAudioContext,
    names: readonly string[],
  ): Promise<Map<string, AudioBuffer>> {
    await this.fetchBytes(names);
    const out = new Map<string, AudioBuffer>();
    for (const name of names) {
      const bytes = this.raw.get(name);
      if (!bytes) continue;
      try {
        // decodeAudioData détache le tampon : on lui en donne un bien à lui.
        const buffer = await decode(ctx, bytes.slice().buffer as ArrayBuffer);
        if (buffer && buffer.length) out.set(name, buffer);
      } catch (err) {
        console.warn(`son "${name}" illisible pour ce contexte :`, err);
      }
    }
    return out;
  }

  /** Lit les octets manquants, sans rien décoder. */
  async fetchBytes(names: readonly string[]): Promise<void> {
    const embedded = window.__SIM_SOUNDS__;
    for (const name of names) {
      if (this.raw.has(name)) continue;
      if (embedded && embedded[name]) {
        this.raw.set(name, base64ToBytes(embedded[name]));
        continue;
      }
      for (const url of [`/assets/${name}`, `/${name}`]) {
        const res = await fetch(url).catch(() => null);
        if (res?.ok) {
          this.raw.set(name, new Uint8Array(await res.arrayBuffer()));
          break;
        }
      }
      if (!this.raw.has(name)) {
        this.failed.add(name);
        console.warn(`son "${name}" introuvable — impacts muets.`);
      }
    }
  }

  /**
   * Remplace un échantillon par un fichier choisi par l'utilisateur.
   *
   * Seuls les octets changent. La simulation continue d'émettre le même
   * événement à chaque rebond, avec la même hauteur et le même panoramique :
   * le nouveau son suit donc la montée de gamme exactement comme l'ancien.
   * L'export puise dans la même banque, si bien que le mp4 produit porte le
   * son choisi sans rien avoir à lui signaler.
   *
   * Un fichier que le navigateur refuse ne doit pas laisser la simulation
   * muette : l'ancien son est alors remis en place, et l'appelant averti.
   */
  async override(name: string, bytes: Uint8Array): Promise<boolean> {
    const previousRaw = this.raw.get(name);
    const previousBuffer = this.buffers.get(name);

    this.raw.set(name, bytes);
    this.buffers.delete(name);
    await this.load([name]);
    if (this.buffers.has(name)) return true;

    if (previousRaw) this.raw.set(name, previousRaw);
    else this.raw.delete(name);
    if (previousBuffer) this.buffers.set(name, previousBuffer);
    this.failed.delete(name);
    return false;
  }

  /** Vrai si tous ces sons sont décodés et prêts à être joués. */
  ready(names: readonly string[]): boolean {
    return names.every((n) => this.buffers.has(n));
  }

  /**
   * Décode les sons manquants. Idempotente et sûre à rappeler : c'est ce qui
   * permet de réessayer au premier geste de l'utilisateur.
   *
   * Safari sur iOS ne décode pas de façon fiable tant que le contexte dort,
   * et un contexte créé avant tout geste démarre suspendu. On le réveille
   * donc avant d'essayer.
   */
  async load(names: readonly string[]): Promise<void> {
    const ctx = this.context();
    if (ctx.state === 'suspended') await ctx.resume().catch(() => undefined);
    await this.fetchBytes(names);

    for (const name of names) {
      if (this.buffers.has(name)) continue;
      const bytes = this.raw.get(name);
      if (!bytes) continue;
      try {
        // decodeAudioData détache le tampon : on lui en donne un bien à lui.
        const buffer = await decode(ctx, bytes.slice().buffer as ArrayBuffer);
        if (!buffer || !buffer.length) throw new Error('tampon vide');
        this.buffers.set(name, buffer);
        this.failed.delete(name);
      } catch (err) {
        this.failed.add(name);
        console.warn(`son "${name}" illisible :`, err);
      }
    }
  }
}
