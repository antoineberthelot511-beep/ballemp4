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

function base64ToBytes(b64: string): Uint8Array {
  const bin = atob(b64);
  const out = new Uint8Array(bin.length);
  for (let i = 0; i < bin.length; i++) out[i] = bin.charCodeAt(i);
  return out;
}

export class SoundBank {
  private readonly buffers = new Map<string, AudioBuffer>();
  private ctx: AudioContext | null = null;

  /**
   * Un AudioContext créé sans geste utilisateur démarre suspendu, ce qui
   * n'empêche pas `decodeAudioData` : on peut donc décoder dès le chargement.
   */
  private context(): AudioContext {
    if (!this.ctx) this.ctx = new AudioContext();
    return this.ctx;
  }

  get(name: string): AudioBuffer | undefined {
    return this.buffers.get(name);
  }

  async load(names: readonly string[]): Promise<void> {
    const embedded = window.__SIM_SOUNDS__;
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
          console.warn(`son "${name}" introuvable — impacts muets.`);
          continue;
        }
        // decodeAudioData détache le tampon : on lui en donne un bien à lui.
        const copy = bytes.slice().buffer;
        this.buffers.set(name, await this.context().decodeAudioData(copy));
      } catch (err) {
        console.warn(`son "${name}" illisible :`, err);
      }
    }
  }
}
