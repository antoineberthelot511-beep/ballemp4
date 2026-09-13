# Simulations physiques verticales

Générateur de vidéos de simulations physiques pour TikTok / Reels.
Sortie : **mp4 1080x1920, 60 fps**, durée libre (cible 15–45 s), avec piste audio
générée à partir des impacts.

TypeScript + canvas 2D, aucun framework. Node 24 exécute les `.ts` directement,
il n'y a donc pas d'étape de build pour le rendu.

---

## Installation

```sh
npm install
```

Prérequis : **Node ≥ 22.6** (exécution native de TypeScript) et **ffmpeg** dans le `PATH`.

---

## Rendu

```sh
node render/cli.ts --sim bounce --seed demo --duration 20 --out out/demo.mp4
```

| Option | Effet | Défaut |
| --- | --- | --- |
| `--sim <id>` | sim à rendre | `bounce` |
| `--seed <str>` | graine ; **une graine = une vidéo identique** | celle de la sim |
| `--duration <s>` | durée en secondes | celle de la sim |
| `--fps <n>` | images par seconde | `60` |
| `--width` / `--height` | résolution | `1080` × `1920` |
| `--substeps <n>` | sous-pas d'intégration par image | celui de la sim |
| `--title <str>` | titre affiché dans le HUD | celui de la sim |
| `--burst <s>` | pour `bounce` : secondes avant l'éclatement, **10 à 120** | `21.8` |
| `--param <clé=val>` | réglage libre de la sim, répétable | — |
| `--crf <n>` | qualité x264, plus bas = mieux | `18` |
| `--preset <name>` | preset x264 | `slow` |
| `--raw` | envoie du RGBA brut à ffmpeg au lieu de PNG | — |
| `--no-audio` | pas de piste audio | — |
| `--frames-dir <dir>` | écrit aussi les PNG un par un | — |
| `--check [n]` | vérifie le déterminisme sur n images, sans encoder | `90` |

`--raw` est environ deux fois plus rapide (l'encodage PNG est le poste dominant)
et produit exactement la même vidéo. Le mode PNG reste le défaut parce qu'il
tolère les pipes lents et se débogue à l'œil avec `--frames-dir`.

Ordre de grandeur mesuré sur cette machine, en 1080x1920 : **~6 img/s** en PNG
au preset par défaut, **~28 img/s** en `--raw --preset veryfast`. Compter environ
5 min pour 30 s de vidéo en qualité de production, une vingtaine pour 120 s.

Le flou de mouvement est désactivé automatiquement quand la bille est grosse : il
n'est perceptible que si le déplacement par image est comparable au rayon, et
douze disques de 400 px pleins par image coûtaient la moitié du temps de rendu
pour un effet invisible.

### Durée et instant d'explosion

Deux réglages indépendants, reliés par une queue de 2,2 s — le temps que la
bille libérée sorte du cadre. Donne l'un, l'autre se déduit ; donne les deux
pour tout contrôler.

```sh
node render/cli.ts --duration 30                  # 30 s, éclatement à 27,8 s
node render/cli.ts --burst 45                     # éclatement à 45 s, 47,2 s au total
node render/cli.ts --duration 60 --burst 20       # les deux respectés
```

| options | durée | éclatement | queue |
| --- | --- | --- | --- |
| *(défaut)* | 24,00 s | 21,80 s | 2,20 s |
| `--duration 30` | 30,00 s | 27,80 s | 2,20 s |
| `--burst 40` | 42,20 s | 40,00 s | 2,20 s |
| `--duration 60 --burst 20` | 60,00 s | 20,00 s | 40,00 s |
| `--duration 8` | 10,50 s | 10,00 s | 0,50 s |
| `--duration 130` | 130,00 s | 120,00 s | 10,00 s |

`--burst` va de **10 à 120 secondes**.

### Croissance homogène

La bille gagne **exactement le même rayon à chaque rebond**, quelle que soit la
durée choisie — jamais un cran plus gros, jamais un cran plus petit pour
rattraper l'échéance.

Cette exigence en contredit une autre : atteindre la taille de rupture pile au
moment voulu. Les deux ne se concilient que si l'on connaît le nombre de rebonds
à l'avance, or ce nombre dépend de la taille de la bille, qui dépend du cran, qui
dépend du nombre de rebonds. `solveGrowthStep` le résout par **pré-simulation** :
la physique tourne sans rendu ni audio, on mesure l'instant du n-ième rebond, et
on corrige `n` proportionnellement jusqu'à tomber sur l'échéance.

Deux pièges rencontrés, tous deux dus au caractère chaotique de la trajectoire :

- viser le *nombre* de rebonds avant l'échéance donne une fonction en marches, et
  l'éclatement tombait jusqu'à 11 s trop tôt. Il faut viser l'*instant* du
  n-ième rebond ;
- une dichotomie est invalide : changer le cran change toute la trajectoire, donc
  cet instant est bruité et non monotone en `n`. D'où la correction
  proportionnelle, qui retient la meilleure candidate rencontrée, suivie d'un
  balayage serré autour d'elle.

Résultat mesuré, graine `demo` :

| durée | éclatement | écart à la cible | rebonds | cran |
| --- | --- | --- | --- | --- |
| 12 s | 10,07 s | −0,07 s | 21 | 19,201 px |
| 24 s | 21,73 s | +0,07 s | 46 | 8,348 px |
| 45 s | 42,72 s | +0,08 s | 96 | 4,042 px |
| 90 s | 87,22 s | +0,58 s | 179 | 2,145 px |
| 122 s | 119,68 s | +0,12 s | 213 | 1,811 px |

Le cran est strictement constant du premier au dernier rebond (min = max à la
précision flottante). La pré-simulation coûte de 3 à 212 ms et son résultat est
mémorisé, pour que le bouclage de la preview ne la repaie pas.

Rien n'est corrigé en silence : une durée trop courte pour montrer la fin est
allongée avec un avertissement, une valeur hors bornes est ramenée dans la plage
avec un avertissement, et une queue anormalement longue est signalée. La longueur
de la queue se règle par `--param tail=4`.

En preview, les mêmes réglages passent par la query string : `?duration=30`,
`?burst=45`. Tout paramètre d'URL non reconnu est transmis à la sim (`?p.tail=4`).

Ce mécanisme est générique : `SimConfig.params` porte les réglages numériques
propres à chaque sim, et le hook facultatif `Sim.resolveConfig` lui laisse le
dernier mot sur sa configuration une fois les surcharges fusionnées — c'est lui
qui recalcule ici `duration` à partir de `burstAfter`.

## Preview navigateur

```sh
node preview/serve.ts          # ou --watch pour recompiler à chaque édition
# http://localhost:5173/preview/index.html?sim=bounce&seed=demo
```

Le panneau de droite règle **durée totale**, **instant d'éclatement** et
**graine** sans toucher au code ni à la ligne de commande. Modifier l'un des deux
temps recalcule l'autre, exactement comme en CLI. L'URL suit l'état — elle reste
donc partageable et rechargeable telle quelle — et le panneau affiche la
commande `render/cli.ts` correspondant au réglage affiché, avec un bouton pour
la copier : on cale la scène à l'œil, puis on lance le rendu.

Raccourcis : `espace` lecture/pause · `→` image par image · `r` redémarrer ·
`s` nouvelle graine · `l` boucler · `m` couper le son. Ils sont désactivés
pendant la saisie dans un champ, sinon taper une graine déclencherait `r` et `s`.
Un clic dans le canvas arme l'audio (politique d'autoplay des navigateurs).

---

## Page en ligne

```sh
node web/build.ts          # -> web/dist/index.html
```

Construit une page **autonome** : le moteur, la sim et les sons tiennent dans un
seul fichier de 36 Ko, sans aucune ressource externe. C'est une contrainte de
l'hébergement — une page publiée ne peut rien charger depuis un autre hôte —
donc le script est empaqueté d'un bloc par esbuild et les fichiers audio sont
encodés en base64.

La page rejoue la même simulation que la ligne de commande et sait **exporter un
mp4 sans serveur**, directement dans le navigateur :

- `web/mp4.ts` — muxeur MP4 minimal, une piste AVC et une piste AAC. Écrit à la
  main : aucune bibliothèque ne peut être chargée depuis la page publiée. Le
  fichier est assemblé en `ftyp` + `mdat` + `moov`, le `moov` en fin pour
  n'avoir pas à connaître sa taille avant de calculer les décalages.
- `web/export.ts` — encodage WebCodecs (H.264 High + AAC). **Ce n'est pas une
  capture d'écran** : la simulation est rejouée depuis sa graine et chaque image
  est encodée telle qu'elle est calculée, donc le fichier ne dépend ni de la
  fréquence de l'écran ni de la charge du navigateur.
- `web/app.ts` — l'interface : durée, instant d'éclatement, graine, export.

L'export a besoin de WebCodecs (Chrome, Edge, Safari 17+). La page le vérifie au
chargement et le dit, plutôt que d'échouer après deux minutes d'encodage.

Vérifié de bout en bout : un export de 12 s produit un mp4 H.264 High
1080×1920 à 60 i/s, 720 images, AAC-LC 48 kHz stéréo, que ffmpeg décode sans une
seule erreur.

## Sons

Poser un fichier audio dans `assets/` suffit ; une sim le déclenche en le
nommant. `sims/bounce.ts` joue `dry-fart.mp3` à **chaque** contact avec la paroi.

```ts
const BOUNCE_SOUND = 'dry-fart.mp3';

playSample(ctx.audio, ctx.t, {
  sample: BOUNCE_SOUND,
  gain: clamp(0.78 + impact / 6000, 0, 1),
  xNorm: b.x / ctx.config.width,
});
```

Le moteur ne charge rien : il se contente de nommer le fichier dans
l'`AudioEvent`, à charge de l'hôte de le décoder. En headless, `render/audio-assets.ts`
passe par **ffmpeg** — déjà indispensable au pipeline, il lit tous les formats et
rééchantillonne — puis normalise le son à pleine échelle pour que `gain` se
comporte pareil quel que soit le niveau d'enregistrement. En preview, WebAudio
décode le même fichier.

Les fichiers sont cherchés dans `assets/` puis à la racine du projet, donc les
deux emplacements marchent. Un fichier introuvable est signalé et l'impact reste
muet : mieux vaut une vidéo sans bruitage qu'un rendu qui échoue après plusieurs
minutes d'encodage.

Une sim déclare ses sons via `assets: [...]` pour qu'ils soient préchargés :
découverts au premier événement, les premiers impacts seraient muets le temps du
téléchargement.

Vérifié : le nombre de sons émis égale exactement le nombre de rebonds, de 24
impacts sur 14 s à 213 sur 122 s.

## Déterminisme

C'est la contrainte structurante du projet. Concrètement :

- **Aucun `requestAnimationFrame` dans le pipeline de rendu.** rAF n'existe que
  dans `preview/main.ts`, et il ne fait que décider *quand* appeler
  `World.advanceFrame()` — jamais *de combien* le temps avance.
- **Aucun `Math.random`.** Tout l'aléatoire passe par `engine/rng.ts` (sfc32
  seedé par hachage xmur3 de la graine). `rng.fork(label)` dérive des flux
  indépendants sans casser la reproductibilité.
- **Aucune horloge murale dans la simulation.** `World.frame` est la seule
  notion de temps ; `dt` vaut exactement `1 / (fps × substeps)`.
- **Ordre d'itération fixe.** La grille spatiale range les corps par tri par
  comptage stable et parcourt les cellules dans l'ordre des index, donc la
  séquence de paires en collision est reproductible.

Vérification :

```sh
node render/cli.ts --check 300        # deux exécutions, empreintes comparées
```

Chaque rendu affiche aussi une empreinte SHA-256 des pixels de toutes les
images. Elle porte sur les pixels bruts et non sur les octets transmis à
ffmpeg : elle est donc comparable entre `--raw` et le mode PNG.

Vérifié en pratique : deux rendus de la même graine produisent un **mp4
identique octet pour octet** (x264 est déterministe à réglages égaux), pas
seulement une suite d'images identiques.

## Santé d'une simulation

```sh
node render/verify.ts --sim bounce --target 25
```

Fait tourner la sim jusqu'à ce que son compteur atteigne la cible, puis vérifie
qu'il n'a pas calé, qu'aucune vitesse n'est devenue NaN, et qu'il n'a pas
progressé par paquets. Un saut de 2 est toléré — un contact rasant peut toucher
la paroi deux fois dans la même image, c'est de la physique légitime ; ce qu'on
traque est l'emballement, un corps coincé dans la paroi comptant un impact à
chaque sous-pas. Le seuil est donc calé sur le nombre de sous-pas, avec en plus
une limite de fréquence. Si la sim déclare une `expectedSpeed`, la dérive de cette vitesse est
rapportée à part : c'est un problème d'énergie numérique, distinct d'un blocage
de boucle, et les deux se soignent différemment. Une sim sous gravité n'en
déclare pas — sa vitesse varie par construction.

Une sim participe en exportant `probe(state)` (facultatif) qui renvoie
`{ bodies, count, expectedSpeed? }`.

Le parcours est borné par la durée de la sim. Pour une sim qui se conclut — ici
l'éclatement du cercle libère la bille, qui ne rebondit plus — le compteur
s'arrête légitimement, et le « plus long écart » ne compte que les intervalles
entre deux progressions, pas cette traîne finale.

Référence pour `bounce` : les 16 combinaisons de 4 graines × 4 durées (12, 30,
75 et 122 s) passent.

## Pourquoi la paroi n'est pas parfaitement lisse

Le billard circulaire est **intégrable** : dans un cercle, toutes les cordes
d'une même trajectoire sous-tendent le même angle, donc l'angle d'incidence avec
la paroi est une quantité conservée. La bille trace indéfiniment la même rosace
et tous les rebonds se ressemblent — mesuré sur la première version : l'incidence
restait à 1–19° pendant les 40 rebonds d'un rendu.

Le frottement de contact seul ne suffit pas : il fait converger le mouvement soit
vers un aller-retour radial (la rotation s'amortit à zéro), soit vers un
roulement le long de la paroi. Il faut casser la symétrie de révolution.

La paroi porte donc une micro-rugosité : rayon `R·(1 + A·cos(k·θ + φ))`. Le
réglage exploite une dissymétrie utile — l'inclinaison de la normale, donc le
pouvoir de dispersion, vaut `atan(A·k)` et dépend du **produit** amplitude ×
lobes, tandis que l'écart visible vaut `A·R` et ne dépend que de l'amplitude. En
montant `k` très haut on obtient donc toute la dispersion voulue avec une
amplitude invisible : `A = 0,1 %`, `k = 220`, soit **0,47 px de relief** — sous
le demi-pixel, et sous un trait de 5 à 12 px — pour ±12° de normale.

La paroi *est* un cercle à la résolution de rendu, et c'est bien un cercle
(`ctx.arc`) qui est dessiné. Résultat mesuré : l'incidence varie de 12 à 16° en
moyenne d'un rebond au suivant, contre ~0 auparavant.

Réglage intermédiaire écarté : `A = 1,8 %`, `k = 11` donnait la même dispersion,
mais 8 px de relief — l'arène se lisait alors comme un polygone arrondi.

`containInLobedCircle` avec `amplitude: 0` redonne un cercle parfaitement lisse,
donc la monotonie.

## Robustesse de la boucle de preview

Trois invariants, chacun pour un mode de panne distinct :

1. `requestAnimationFrame(frameLoop)` est la **première** instruction de la
   boucle. En dernière instruction, la première exception romprait la chaîne
   définitivement et tout se figerait sans le moindre message.
2. `dt` est plafonné à **0,25 s** avant d'entrer dans l'accumulateur, et la
   boucle de rattrapage est bornée à 6 pas. Après un onglet en arrière-plan,
   `now - lastWall` peut valoir plusieurs minutes ; non plafonné, le `while`
   ne se terminerait plus.
3. Toute division par une norme est gardée par `Math.hypot(…) || 1e-6`. Là où
   une norme nulle a un sens physique (corps à l'arrêt, centres confondus), le
   garde-fou est doublé d'un repli explicite : `|| 1e-6` évite le NaN mais
   donnerait un vecteur nul, ce qui laisserait le corps collé sur place.

Le pas de simulation et le rendu sont enveloppés dans un `try/catch` qui met la
preview en pause et l'affiche, plutôt que de répéter la même exception à chaque
image. Côté audio, le curseur d'événements avance avant la programmation
WebAudio et chaque note est isolée : une note refusée est abandonnée, jamais
rejouée en boucle.

**Limite connue :** la preview et le rendu headless partagent une physique
bit-à-bit identique, mais rastérisent avec deux moteurs différents (Skia de
Chrome contre Skia de `@napi-rs/canvas`). L'anticrénelage et le rendu de texte
diffèrent de quelques niveaux de gris. La preview sert à juger le mouvement,
le rythme et le cadrage ; le mp4 reste la référence pixel.

---

## Structure

```
engine/     physique et rendu, sans dépendance à la plateforme
  types.ts      interfaces partagées (Ctx2D, Sim, Rng, AudioEvent…)
  rng.ts        générateur seedé xmur3 + sfc32
  math.ts       clamp, lerp, smoothstep, helpers vectoriels
  surface.ts    fabrique de canvas offscreen, injectée par l'hôte
  grid.ts       grille spatiale uniforme (broad phase)
  collide.ts    collisions disque/disque, confinement circulaire, renormalisation
  palette.ts    palettes cycliques déterministes
  glow.ts       sprites de lueur pré-rendus et mis en cache
  hud.ts        titre, compteur, barre de progression, vignette, zones sûres
  audio.ts      bus d'événements sonores + mapping sur une gamme
  fonts.ts      alias de polices, résolus par l'hôte
  world.ts      boucle à pas fixe + substeps

sims/       une variante par fichier : { config, init, step, draw }
  bounce.ts     une bille grossit d'un cran fixe à chaque rebond jusqu'à faire
                éclater le cercle
  registry.ts   id -> sim

render/     rendu headless
  node-surface.ts  canvas @napi-rs + enregistrement des polices
  headless.ts      boucle image par image, empreinte, orchestration
  ffmpeg.ts        encodeur x264 alimenté par pipe + mux audio
  wav.ts           synthèse hors-ligne des événements sonores
  cli.ts           interface en ligne de commande

preview/    mode navigateur temps réel
out/        mp4 générés
```

### Écrire une sim

Un fichier de `/sims` exporte `config`, `init`, `step` et `draw`.
`step` avance la physique d'exactement `ctx.h` seconde et ne dessine rien ;
`draw` dessine et ne modifie pas l'état. Cette séparation est ce qui permet
d'avoir plusieurs sous-pas par image sans rendre le rendu dépendant du nombre
de sous-pas.

```ts
export const config: SimConfig = { id: 'ma-sim', title: '…', width: 1080,
  height: 1920, fps: 60, duration: 25, substeps: 8, seed: 'x', params: {} };

function init(ctx: InitCtx): State { /* ne consomme d'aléa que via ctx.rng */ }
function step(s: State, ctx: StepCtx): void { /* un sous-pas de ctx.h seconde */ }
function draw(s: State, d: DrawCtx): void { /* lecture seule sur s */ }

const sim: Sim<State> = { config, init, step, draw };
export default sim;
```

Puis une ligne dans `sims/registry.ts`.
