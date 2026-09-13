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
function decode(ctx: AudioContext, data: ArrayBuffer): Promise<AudioBuffer> {
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
    const embedded = window.__SIM_SOUNDS__;
    const ctx = this.context();
    if (ctx.state === 'suspended') await ctx.resume().catch(() => undefined);

    for (const name of names) {
      if (this.buffers.has(name)) continue;
      try {
        let bytes: Uint8Array | null = null;
        if (embedded && embedded[name]) {
          bytes = base64ToBytes(embedded[name]);
        } else {
          for (const url of [`/assets/${name}`, `/${name}`]) {
            const res = await fetch(url).catch(() => null);
            if (res?.ok) {
              bytes = new Uint8Array(await res.arrayBuffer());
              break;
            }
          }
        }
        if (!bytes) {
          this.failed.add(name);
          console.warn(`son "${name}" introuvable — impacts muets.`);
          continue;
        }
        // decodeAudioData détache le tampon : on lui en donne un bien à lui.
        const copy = bytes.slice().buffer as ArrayBuffer;
        const buffer = await decode(ctx, copy);
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
