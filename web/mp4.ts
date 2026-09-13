/**
 * Muxeur MP4 minimal : une piste vidéo AVC, une piste audio AAC facultative.
 *
 * Écrit pour être embarqué dans une page autonome : aucune dépendance, et la
 * politique de sécurité d'une page publiée interdit de toute façon de charger
 * une bibliothèque externe.
 *
 * Le fichier est assemblé en `ftyp` + `moov` + `mdat`. Mettre le `moov` devant
 * oblige à connaître sa taille avant de calculer les décalages des
 * échantillons, d'où les deux passes de `finalize`, mais c'est la disposition
 * que produisent tous les muxeurs réels et la seule qui permette de lire un
 * fichier sans en connaître la fin.
 *
 * Les choix de structure suivent ceux de ffmpeg plutôt que le strict minimum
 * autorisé par la spécification : échantillons entrelacés dans le `mdat`,
 * `edts/elst` sur chaque piste, ordre conventionnel des tables, descripteurs
 * MPEG-4 en forme longue. Un fichier seulement « légal » peut être refusé par
 * un lecteur strict — c'est ce qui privait la piste audio de son sur iOS.
 */

/**
 * Vue octets adossée à un ArrayBuffer classique. Le `Uint8Array` nu se type en
 * `ArrayBufferLike`, qui admet aussi `SharedArrayBuffer` et que ni `Blob` ni
 * les API WebCodecs n'acceptent.
 */
type Bytes = Uint8Array<ArrayBuffer>;

// ---------------------------------------------------------------- primitives

function u8(...bytes: number[]): Bytes {
  return new Uint8Array(bytes);
}

function u16(v: number): Bytes {
  return u8((v >> 8) & 255, v & 255);
}

function u32(v: number): Bytes {
  return u8((v >>> 24) & 255, (v >>> 16) & 255, (v >>> 8) & 255, v & 255);
}

function ascii(s: string): Bytes {
  const out = new Uint8Array(s.length);
  for (let i = 0; i < s.length; i++) out[i] = s.charCodeAt(i) & 255;
  return out;
}

function concat(parts: readonly Bytes[]): Bytes {
  let total = 0;
  for (const p of parts) total += p.length;
  const out = new Uint8Array(total);
  let at = 0;
  for (const p of parts) {
    out.set(p, at);
    at += p.length;
  }
  return out;
}

/**
 * Copie une source d'octets quelconque, quelle que soit sa forme. Les
 * descripteurs fournis par WebCodecs peuvent arriver en tampon ou en vue ; on
 * en garde une copie indépendante, puisqu'ils doivent survivre à l'encodeur.
 */
function toBytes(src: AllowSharedBufferSource): Bytes {
  const out = new Uint8Array(src.byteLength);
  if (ArrayBuffer.isView(src)) {
    out.set(new Uint8Array(src.buffer as ArrayBuffer, src.byteOffset, src.byteLength));
  } else {
    out.set(new Uint8Array(src as ArrayBuffer));
  }
  return out;
}

/** Boîte ISO BMFF : taille (32 bits) + type + contenu. */
function box(type: string, ...payload: Bytes[]): Bytes {
  const body = concat(payload);
  return concat([u32(body.length + 8), ascii(type), body]);
}

/** Boîte avec octet de version et 24 bits de drapeaux. */
function fullBox(type: string, version: number, flags: number, ...payload: Bytes[]): Bytes {
  return box(type, u8(version, (flags >> 16) & 255, (flags >> 8) & 255, flags & 255), ...payload);
}

/**
 * Descripteur MPEG-4, longueur en forme longue sur quatre octets.
 *
 * La forme courte serait valide pour ces tailles, mais tous les écrivains de
 * référence — ffmpeg comme les outils Apple — émettent la forme longue, et
 * c'est celle que les analyseurs stricts s'attendent à lire.
 */
function descriptor(tag: number, ...payload: Bytes[]): Bytes {
  const body = concat(payload);
  const n = body.length;
  // Quantité de longueur variable sur quatre octets : sept bits utiles chacun,
  // bit de poids fort à 1 tant qu'un octet suit. Écrire `0x80 0x80 0x80 n`
  // n'encoderait correctement que les tailles inférieures à 128.
  return concat([
    u8(
      tag,
      0x80 | ((n >> 21) & 0x7f),
      0x80 | ((n >> 14) & 0x7f),
      0x80 | ((n >> 7) & 0x7f),
      n & 0x7f,
    ),
    body,
  ]);
}

/** Fréquences tabulées de l'AudioSpecificConfig, dans l'ordre des index. */
const AAC_SAMPLE_RATES = [
  96000, 88200, 64000, 48000, 44100, 32000, 24000, 22050, 16000, 12000, 11025, 8000, 7350,
];

/**
 * Reconstruit l'AudioSpecificConfig d'un flux AAC-LC.
 *
 * WebCodecs est censé livrer ce descripteur dans `decoderConfig.description`,
 * mais tous les navigateurs ne le font pas : Safari le laisse absent. Le
 * muxeur abandonnait alors la piste audio sans rien dire, et la vidéo exportée
 * depuis un iPhone sortait muette. Ces deux octets ne dépendent que du profil,
 * de la fréquence et du nombre de canaux : on les écrit plutôt que d'attendre
 * qu'on nous les donne.
 */
function buildAudioSpecificConfig(sampleRate: number, channels: number): Bytes {
  const freqIndex = AAC_SAMPLE_RATES.indexOf(sampleRate);
  if (freqIndex < 0) throw new Error(`Fréquence AAC non tabulée : ${sampleRate} Hz`);
  // 5 bits de type d'objet (2 = AAC-LC), 4 d'index de fréquence, 4 de
  // configuration de canaux, puis les 3 bits nuls du GASpecificConfig.
  const bits = (2 << 11) | (freqIndex << 7) | (channels << 3);
  return u8((bits >> 8) & 255, bits & 255);
}

/** Matrice unité, exigée par `tkhd` et `mvhd`. */
const UNITY_MATRIX = concat([
  u32(0x00010000), u32(0), u32(0),
  u32(0), u32(0x00010000), u32(0),
  u32(0), u32(0), u32(0x40000000),
]);

// ------------------------------------------------------------------- données

interface Sample {
  data: Bytes;
  /** Décalage dans le `mdat`, attribué à l'assemblage. */
  offset: number;
  /** Durée, dans l'échelle de temps de la piste. */
  duration: number;
  /** Début de présentation, en secondes — sert à entrelacer les pistes. */
  start: number;
  keyframe: boolean;
}

export interface Mp4MuxerOptions {
  width: number;
  height: number;
  fps: number;
}

export class Mp4Muxer {
  private readonly opts: Mp4MuxerOptions;

  private videoDescription: Bytes | null = null;
  private audioDescription: Bytes | null = null;
  private audioSampleRate = 48000;
  private audioChannels = 2;
  private audioBitrate = 0;

  private readonly video: Sample[] = [];
  private readonly audio: Sample[] = [];
  private lastVideoTs: number | null = null;
  private lastAudioTs: number | null = null;
  /** Vrai si les horodatages reculent, ce qui trahirait des images B. */
  outOfOrder = false;

  constructor(opts: Mp4MuxerOptions) {
    this.opts = opts;
  }

  addVideoChunk(chunk: EncodedVideoChunk, description?: AllowSharedBufferSource): void {
    if (description && !this.videoDescription) this.videoDescription = toBytes(description);

    const data = new Uint8Array(chunk.byteLength);
    chunk.copyTo(data);

    // Les durées se déduisent des horodatages successifs : le muxeur n'a pas à
    // supposer une cadence, il transcrit celle que l'encodeur a produite.
    if (this.lastVideoTs !== null) {
      const delta = chunk.timestamp - this.lastVideoTs;
      if (delta <= 0) this.outOfOrder = true;
      this.video[this.video.length - 1].duration = Math.max(1, Math.round(delta));
    }
    this.lastVideoTs = chunk.timestamp;

    this.video.push({
      data,
      offset: 0,
      duration: Math.round(1_000_000 / this.opts.fps),
      start: chunk.timestamp / 1_000_000,
      keyframe: chunk.type === 'key',
    });
  }

  addAudioChunk(chunk: EncodedAudioChunk, config?: AudioDecoderConfig): void {
    if (config) {
      if (config.sampleRate) this.audioSampleRate = config.sampleRate;
      if (config.numberOfChannels) this.audioChannels = config.numberOfChannels;
      if (config.description && !this.audioDescription) {
        this.audioDescription = toBytes(config.description);
      }
    }

    const data = new Uint8Array(chunk.byteLength);
    chunk.copyTo(data);

    if (this.lastAudioTs !== null) {
      const deltaUs = chunk.timestamp - this.lastAudioTs;
      const inSamples = Math.max(1, Math.round((deltaUs * this.audioSampleRate) / 1_000_000));
      this.audio[this.audio.length - 1].duration = inSamples;
    }
    this.lastAudioTs = chunk.timestamp;

    this.audio.push({
      data,
      offset: 0,
      // 1024 échantillons par trame AAC-LC ; corrigé au chunk suivant.
      duration: 1024,
      start: chunk.timestamp / 1_000_000,
      keyframe: true,
    });
  }

  /**
   * Vrai si l'AudioSpecificConfig a dû être reconstruit faute d'avoir été
   * fourni par l'encodeur. Purement informatif.
   */
  synthesizedAudioConfig = false;

  get hasAudio(): boolean {
    return this.audio.length > 0;
  }

  /**
   * Ce que la piste sonore contient réellement, à appeler après `finalize`.
   *
   * Sert à trancher entre les causes possibles d'un fichier muet sans avoir à
   * récupérer le fichier : l'ASC et sa provenance disent si l'encodeur a fait
   * son travail, le nombre de trames si le muxage a eu lieu.
   */
  audioSummary(): string {
    if (!this.hasAudio) return 'aucune piste';
    const asc = this.audioDescription
      ? [...this.audioDescription].map((b) => b.toString(16).padStart(2, '0')).join('')
      : '—';
    const origin = this.synthesizedAudioConfig ? 'reconstruit' : 'encodeur';
    const khz = (this.audioSampleRate / 1000).toFixed(0);
    return `aac ${khz}k/${this.audioChannels} · ${this.audio.length} trames · ASC ${asc} (${origin})`;
  }

  finalize(): Blob {
    if (!this.videoDescription) throw new Error("L'encodeur n'a fourni aucun descripteur AVC.");

    const withAudio = this.hasAudio;
    // Une piste sonore sans descripteur est une piste muette : on le comble
    // ici plutôt que de la jeter.
    if (withAudio && !this.audioDescription) {
      this.audioDescription = buildAudioSpecificConfig(this.audioSampleRate, this.audioChannels);
      this.synthesizedAudioConfig = true;
    }

    const audioSeconds = this.audio.reduce((a, s) => a + s.duration, 0) / this.audioSampleRate;
    if (withAudio && audioSeconds > 0) {
      const bits = this.audio.reduce((a, s) => a + s.data.length * 8, 0);
      this.audioBitrate = Math.round(bits / audioSeconds);
    }

    const ftyp = box(
      'ftyp',
      ascii('isom'), u32(512),
      ascii('isom'), ascii('iso2'), ascii('avc1'), ascii('mp41'),
    );
    // Provisoire : recalculé une fois la taille du `moov` connue.
    let mdatStart = ftyp.length + 8;

    // Deux passes. Les décalages des échantillons dépendent de la taille du
    // `moov` qui les précède, et le `moov` contient ces décalages. La taille
    // des tables ne dépend pas des valeurs — `stco` fait quatre octets par
    // entrée quoi qu'il arrive — donc une seule itération suffit, et on le
    // vérifie plutôt que de le supposer.
    let payload = this.layout(mdatStart, withAudio);
    const first = this.moov(withAudio, audioSeconds);

    mdatStart = ftyp.length + first.length + 8;
    payload = this.layout(mdatStart, withAudio);
    const moov = this.moov(withAudio, audioSeconds);

    if (moov.length !== first.length) {
      throw new Error('La taille du moov a changé entre les deux passes.');
    }

    return new Blob([ftyp, moov, u32(payload.size + 8), ascii('mdat'), ...payload.parts], {
      type: 'video/mp4',
    });
  }

  private moov(withAudio: boolean, audioSeconds: number): Bytes {
    const videoSeconds = this.video.reduce((a, s) => a + s.duration, 0) / 1_000_000;
    const movieTimescale = 1000;
    const movieDuration = Math.round(
      Math.max(videoSeconds, withAudio ? audioSeconds : 0) * movieTimescale,
    );

    return box(
      'moov',
      this.mvhd(movieTimescale, movieDuration, withAudio ? 3 : 2),
      this.trak(
        'video', 1, 1_000_000, this.video,
        movieTimescale, Math.round(videoSeconds * movieTimescale),
      ),
      ...(withAudio
        ? [
            this.trak(
              'audio', 2, this.audioSampleRate, this.audio,
              movieTimescale, Math.round(audioSeconds * movieTimescale),
            ),
          ]
        : []),
    );
  }

  /**
   * Attribue les décalages en entrelaçant les pistes par ordre de présentation.
   *
   * Écrire toute la vidéo puis tout l'audio reste légal, mais aucun muxeur réel
   * ne le fait : un lecteur qui lit le fichier en avançant doit alors sauter à
   * l'autre bout pour chaque trame sonore. Entrelacer coûte un tri et rapproche
   * le fichier de ce que les lecteurs attendent.
   */
  private layout(mdatStart: number, withAudio: boolean): { parts: Bytes[]; size: number } {
    let ordered: Sample[] = this.video;
    if (withAudio) {
      // Tri stable, la vidéo passant devant l'audio à instant égal : c'est
      // l'ordre dont un lecteur a besoin pour afficher sans attendre le son.
      const tagged = [
        ...this.video.map((s, i) => ({ s, rank: 0, i })),
        ...this.audio.map((s, i) => ({ s, rank: 1, i })),
      ];
      tagged.sort((a, b) => a.s.start - b.s.start || a.rank - b.rank || a.i - b.i);
      ordered = tagged.map((t) => t.s);
    }

    const parts: Bytes[] = [];
    let at = 0;
    for (const s of ordered) {
      s.offset = mdatStart + at;
      at += s.data.length;
      parts.push(s.data);
    }
    return { parts, size: at };
  }

  // ------------------------------------------------------------------ boîtes

  private mvhd(timescale: number, duration: number, nextTrackId: number): Bytes {
    return fullBox(
      'mvhd', 0, 0,
      u32(0), u32(0), u32(timescale), u32(duration),
      u32(0x00010000), u16(0x0100), u16(0), u32(0), u32(0),
      UNITY_MATRIX,
      u32(0), u32(0), u32(0), u32(0), u32(0), u32(0),
      u32(nextTrackId),
    );
  }

  private trak(
    kind: 'video' | 'audio',
    trackId: number,
    timescale: number,
    samples: Sample[],
    movieTimescale: number,
    movieDuration: number,
  ): Bytes {
    const isVideo = kind === 'video';
    const trackDuration = samples.reduce((a, s) => a + s.duration, 0);

    const tkhd = fullBox(
      'tkhd', 0, 3, // activée + utilisée dans la présentation
      u32(0), u32(0), u32(trackId), u32(0), u32(movieDuration),
      u32(0), u32(0),
      u16(0), u16(isVideo ? 0 : 1),
      u16(isVideo ? 0 : 0x0100), u16(0),
      UNITY_MATRIX,
      u32(isVideo ? this.opts.width << 16 : 0),
      u32(isVideo ? this.opts.height << 16 : 0),
    );

    // Liste d'édition identité : elle dit explicitement que la piste démarre à
    // zéro et dure ce qu'elle dure. Facultative sur le papier, présente chez
    // tous les muxeurs de référence.
    const edts = box(
      'edts',
      fullBox('elst', 0, 0, u32(1), u32(movieDuration), u32(0), u16(1), u16(0)),
    );

    const mdhd = fullBox(
      'mdhd', 0, 0,
      u32(0), u32(0), u32(timescale), u32(trackDuration),
      // « und » empaqueté sur 15 bits, comme l'exige la spécification.
      u16(0x55c4), u16(0),
    );

    const hdlr = fullBox(
      'hdlr', 0, 0,
      u32(0),
      ascii(isVideo ? 'vide' : 'soun'),
      u32(0), u32(0), u32(0),
      ascii(isVideo ? 'VideoHandler\0' : 'SoundHandler\0'),
    );

    const dinf = box('dinf', fullBox('dref', 0, 0, u32(1), fullBox('url ', 0, 1)));
    const stsd = fullBox('stsd', 0, 0, u32(1), isVideo ? this.avc1() : this.mp4a());

    // Ordre conventionnel des tables : stsd, stts, stss, stsc, stsz, stco.
    const stbl = box(
      'stbl',
      stsd,
      this.stts(samples),
      ...(isVideo ? [this.stss(samples)] : []),
      this.stsc(),
      this.stsz(samples),
      this.stco(samples),
    );

    const minf = box(
      'minf',
      isVideo ? box('vmhd', u8(0, 0, 0, 1), u16(0), u16(0), u16(0), u16(0)) : fullBox('smhd', 0, 0, u16(0), u16(0)),
      dinf,
      stbl,
    );

    return box('trak', tkhd, edts, box('mdia', mdhd, hdlr, minf));
  }

  private avc1(): Bytes {
    return box(
      'avc1',
      u8(0, 0, 0, 0, 0, 0), u16(1), // réservé + index de description
      u16(0), u16(0), u32(0), u32(0), u32(0),
      u16(this.opts.width), u16(this.opts.height),
      u32(0x00480000), u32(0x00480000), // 72 ppp
      u32(0), u16(1),
      // Nom du compresseur : 32 octets préfixés par leur longueur.
      concat([u8(0), new Uint8Array(31)]),
      u16(0x0018), u16(0xffff),
      box('avcC', this.videoDescription as Bytes),
    );
  }

  private mp4a(): Bytes {
    return box(
      'mp4a',
      u8(0, 0, 0, 0, 0, 0), u16(1),
      u32(0), u32(0),
      u16(this.audioChannels), u16(16),
      u16(0), u16(0),
      u32(this.audioSampleRate << 16),
      this.esds(),
      // Débits déclarés, comme le fait ffmpeg : certains lecteurs s'en servent
      // pour dimensionner leur tampon avant de décoder. `btrt` n'est pas une
      // « full box » : ni version ni drapeaux.
      box('btrt', u32(0), u32(this.audioBitrate), u32(this.audioBitrate)),
    );
  }

  /** Descripteur MPEG-4 encapsulant l'AudioSpecificConfig de l'encodeur. */
  private esds(): Bytes {
    const asc = this.audioDescription as Bytes;
    const decoderConfig = descriptor(
      0x04,
      u8(0x40, 0x15), // AAC, flux audio
      u8(0, 0, 0), // taille du tampon
      u32(this.audioBitrate), u32(this.audioBitrate),
      descriptor(0x05, asc),
    );
    // ES_ID aligné sur l'identifiant de la piste, comme le fait ffmpeg : un
    // analyseur strict s'attend à pouvoir les rapprocher.
    const es = descriptor(0x03, u16(2), u8(0), decoderConfig, descriptor(0x06, u8(0x02)));
    return fullBox('esds', 0, 0, es);
  }

  /** Table durée → nombre d'échantillons, compressée par répétitions. */
  private stts(samples: Sample[]): Bytes {
    const runs: Array<[number, number]> = [];
    for (const s of samples) {
      const last = runs[runs.length - 1];
      if (last && last[1] === s.duration) last[0]++;
      else runs.push([1, s.duration]);
    }
    return fullBox('stts', 0, 0, u32(runs.length), ...runs.map(([count, delta]) => concat([u32(count), u32(delta)])));
  }

  /** Un échantillon par « chunk » : la table est triviale et toujours valide. */
  private stsc(): Bytes {
    return fullBox('stsc', 0, 0, u32(1), u32(1), u32(1), u32(1));
  }

  private stsz(samples: Sample[]): Bytes {
    return fullBox('stsz', 0, 0, u32(0), u32(samples.length), ...samples.map((s) => u32(s.data.length)));
  }

  private stco(samples: Sample[]): Bytes {
    return fullBox('stco', 0, 0, u32(samples.length), ...samples.map((s) => u32(s.offset)));
  }

  private stss(samples: Sample[]): Bytes {
    const keys: number[] = [];
    samples.forEach((s, i) => {
      if (s.keyframe) keys.push(i + 1);
    });
    return fullBox('stss', 0, 0, u32(keys.length), ...keys.map((k) => u32(k)));
  }
}
