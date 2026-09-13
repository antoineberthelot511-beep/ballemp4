import type { AudioEvent } from '../engine/types.ts';

/**
 * Joue les événements produits par l'AudioBus au fur et à mesure que la
 * simulation avance.
 *
 * Les événements de synthèse sont une approximation WebAudio du synthé
 * hors-ligne de `render/wav.ts` ; les événements d'échantillon jouent le même
 * fichier que le rendu. La preview sert à juger le rythme, la référence sonore
 * reste le WAV rendu.
 */
export class PreviewAudio {
  private ctx: AudioContext | null = null;
  private master: GainNode | null = null;
  private consumed = 0;
  private startedAt = 0;
  private warned = false;
  muted = false;

  /** Fichiers téléchargés mais pas encore décodés (il faut un AudioContext). */
  private encoded = new Map<string, ArrayBuffer>();
  private decoded = new Map<string, AudioBuffer>();

  /**
   * Télécharge les sons. Le décodage attend l'AudioContext, donc le premier
   * geste de l'utilisateur ; le téléchargement, lui, peut commencer tout de
   * suite. Cherche dans `assets/` puis à la racine, comme le rendu headless.
   */
  async preload(names: readonly string[]): Promise<void> {
    for (const name of names) {
      if (this.encoded.has(name) || this.decoded.has(name)) continue;
      const buffer = await fetchFirst([`/assets/${name}`, `/${name}`]);
      if (buffer) this.encoded.set(name, buffer);
      else console.warn(`[preview] son "${name}" introuvable — impacts muets.`);
    }
    await this.decodePending();
  }

  private async decodePending(): Promise<void> {
    const ctx = this.ctx;
    if (!ctx) return;
    for (const [name, raw] of [...this.encoded]) {
      try {
        // decodeAudioData détache le tampon : on lui passe une copie, sinon un
        // second décodage (après un changement de sim) échouerait.
        this.decoded.set(name, await ctx.decodeAudioData(raw.slice(0)));
        this.encoded.delete(name);
      } catch (err) {
        this.encoded.delete(name);
        console.warn(`[preview] "${name}" illisible :`, err);
      }
    }
  }

  /** Doit être appelé depuis un geste utilisateur (politique d'autoplay). */
  resume(simTime: number): void {
    if (!this.ctx) {
      const Ctor =
        window.AudioContext ??
        (window as unknown as { webkitAudioContext: typeof AudioContext }).webkitAudioContext;
      this.ctx = new Ctor();
      this.master = this.ctx.createGain();
      this.master.gain.value = 0.5;
      this.master.connect(this.ctx.destination);
      void this.decodePending();
    }
    void this.ctx.resume();
    this.startedAt = this.ctx.currentTime - simTime;
  }

  /** Recale l'horloge audio, par ex. après un redémarrage de la sim. */
  reset(simTime: number): void {
    this.consumed = 0;
    if (this.ctx) this.startedAt = this.ctx.currentTime - simTime;
  }

  /**
   * Programme tous les événements apparus depuis le dernier appel.
   *
   * Le curseur avance AVANT la programmation, et chaque note est isolée : un
   * événement que WebAudio refuse est abandonné, jamais rejoué en boucle. Sans
   * ça, une seule note fautive bloquerait le curseur et ferait remonter une
   * exception dans l'appelant à chaque image.
   */
  drain(events: readonly AudioEvent[]): void {
    const ctx = this.ctx;
    const master = this.master;
    if (!ctx || !master) {
      this.consumed = events.length;
      return;
    }
    while (this.consumed < events.length) {
      const ev = events[this.consumed];
      this.consumed++;
      if (this.muted) continue;
      try {
        // Une note déjà en retard est jouée immédiatement plutôt que sautée.
        this.schedule(ctx, master, ev, Math.max(ctx.currentTime, this.startedAt + ev.t));
      } catch (err) {
        if (!this.warned) {
          this.warned = true;
          console.warn('[preview] note ignorée, audio dégradé :', err);
        }
      }
    }
  }

  private schedule(ctx: AudioContext, master: GainNode, ev: AudioEvent, when: number): void {
    const pan = ctx.createStereoPanner();
    pan.pan.setValueAtTime(ev.pan, when);
    pan.connect(master);

    if (ev.sample) {
      const buffer = this.decoded.get(ev.sample);
      if (!buffer) return;
      const src = ctx.createBufferSource();
      src.buffer = buffer;
      src.playbackRate.value = Math.max(0.05, ev.rate ?? 1);
      const gain = ctx.createGain();
      gain.gain.setValueAtTime(ev.gain, when);
      src.connect(gain).connect(pan);
      src.start(when);
      return;
    }

    const osc = ctx.createOscillator();
    osc.type = ev.voice === 'thud' ? 'sine' : 'triangle';
    osc.frequency.setValueAtTime(ev.freq, when);
    if (ev.voice === 'thud') {
      osc.frequency.exponentialRampToValueAtTime(Math.max(20, ev.freq * 0.5), when + 0.06);
    }

    const gain = ctx.createGain();
    gain.gain.setValueAtTime(0, when);
    gain.gain.linearRampToValueAtTime(ev.gain * 0.6, when + 0.0025);
    gain.gain.exponentialRampToValueAtTime(0.0001, when + ev.decay * 4);

    osc.connect(gain).connect(pan);
    osc.start(when);
    osc.stop(when + ev.decay * 4 + 0.05);
  }
}

async function fetchFirst(urls: readonly string[]): Promise<ArrayBuffer | null> {
  for (const url of urls) {
    try {
      const res = await fetch(url);
      if (res.ok) return await res.arrayBuffer();
    } catch {
      // URL suivante.
    }
  }
  return null;
}
