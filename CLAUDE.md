# CLAUDE.md

Ce fichier oriente Claude (ou toute reprise future du projet) sur l'architecture, les conventions et l'état d'avancement du studio de VTubing.

## Objectif du projet

Application web temps réel qui :

1. Capture le flux webcam.
2. Détecte le visage (yeux, sourcils, bouche), le squelette corporel et les mains, via MediaPipe Tasks Vision (`FaceLandmarker`, `PoseLandmarker`, `HandLandmarker`).
3. Fusionne ces trois détections en un squelette global unique, avec priorité aux mains sur les poignets du squelette corporel quand elles sont détectées.
4. Lisse chaque articulation indépendamment (délai réglable par articulation).
5. Applique des réglages de retargeting réglables dans un panneau de débogage : inversion de côté (bras/mains/jambes), inversion par axe (fusionnée pour les paires miroir), amplification par axe (fusionnée pour les paires miroir).
6. Anime un modèle VRM chargé dynamiquement à partir du squelette global retargeté.

## Pile technique

- Bundler : Vite (template `vanilla`, JavaScript pur, pas de framework UI).
- Rendu 3D : `three`.
- Modèle VTuber : `@pixiv/three-vrm`.
- Détection : `@mediapipe/tasks-vision` (WASM + délégation GPU).
- Panneau de débogage : `lil-gui`.

## Structure des dossiers

```
src/
  core/
    JointSchema.js       — liste des articulations/canaux, paires miroir, groupes de réglage fusionnés
    Smoother.js           — lissage exponentiel indépendant par articulation et par axe
    GlobalSkeleton.js      — fusion pose + visage + mains en une pose brute unique, avec substitution des mains
    TwoBoneIK.js            — IK analytique à deux os (loi des cosinus) pour bras et jambes
    CollisionAvoidance.js   — repousse une cible de main hors d'une capsule représentant le torse
    JointConstraints.js     — butées angulaires par articulation (rigidité), appliquées après le retargeting
    RetargetConfig.js       — inversion de côté, inversion par axe, amplification (état + application)
  tracking/
    TrackerManager.js    — initialisation webcam + 3 landmarkers MediaPipe, boucle de détection par frame
  vrm/
    VrmController.js     — chargement VRM, transform du modèle, application des rotations d'os et des expressions
  render/
    SceneManager.js       — scène three.js (caméra, lumières, renderer)
  utils/
    MathUtils.js          — dérivation d'une rotation Euler à partir d'une paire de landmarks 3D
  ui/                      — panneau de débogage (à implémenter, voir "Reste à faire")
  main.js                  — point d'entrée, boucle de rendu (encore le gabarit Vite par défaut)
  style.css
index.html
```

## Concepts clés

### Squelette global (`core/GlobalSkeleton.js`)

Convertit les landmarks bruts de chaque détecteur en un objet `{ [nom]: {x,y,z} }` :

- Les bras et les jambes sont résolus par **IK à deux os** (`core/TwoBoneIK.js`, voir section dédiée ci-dessous), pas par deux rotations de segment indépendantes.
- La clavicule (`leftShoulder`/`rightShoulder`) est laissée à zéro pour l'instant (voir "Reste à faire").
- Les mains utilisent d'abord une rotation de repli dérivée de la pose (poignet→index), puis sont **remplacées** par la rotation dérivée de `HandLandmarker` (poignet→base du majeur) si une main est détectée cette frame-là - c'est l'exigence de priorité aux mains.
- Les canaux de visage (`leftEyeBlink`, `mouthOpen`, etc.) viennent directement des blendshapes de `FaceLandmarker` (`outputFaceBlendshapes: true`), pas d'une rotation.

### IK à deux os (`core/TwoBoneIK.js`)

Corrige le problème initial de tremblement des bras : calculer la rotation de chaque segment indépendamment à partir de son propre landmark fait porter toute la fiabilité du bras sur la profondeur (z) du coude/genou, qui est le point le plus bruité de MediaPipe (articulation la plus repliée à l'écran).

À la place, `solveTwoBoneIK({ root, hint, target, upperLength, lowerLength })` :

1. Fixe la racine (épaule/hanche) et la cible (poignet/cheville, sources de vérité).
2. Calcule l'angle de flexion **analytiquement**, par la loi des cosinus, à partir des longueurs de segment - jamais à partir de la profondeur brute du hint.
3. N'utilise le landmark intermédiaire (`hint`, coude/genou) que pour définir le plan de flexion (de quel côté plier), via un produit vectoriel - pas pour la distance de flexion.

Les longueurs de segment (`upperLength`/`lowerLength`) sont calibrées progressivement par moyenne mobile lente (`GlobalSkeletonBuilder.#calibrateLength`, α = 0.05) plutôt que mesurées frame par frame, pour la même raison : une distance instantanée reste sensible au bruit, une longueur qui se stabilise sur quelques secondes ne l'est plus.

Appliqué aux bras (épaule → coude-indice → poignet-cible) et aux jambes (hanche → genou-indice → cheville-cible).

### Évitement de collision avec le torse (`core/CollisionAvoidance.js`)

Avant de résoudre l'IK d'un bras, `pushOutOfTorso(target, shoulderMid, hipMid, radius)` modélise le buste comme une capsule simple (segment épaules-milieu → hanches-milieu, rayon par défaut 0,14 m) et repousse radialement la cible (poignet) à la surface si elle tombe à l'intérieur. Évite qu'un mouvement bras croisés fasse traverser le buste au modèle VRM. Pas encore appliqué aux jambes (pas de cas d'usage identifié pour l'instant).

### Rigidité (`core/JointConstraints.js`)

`JointConstraints.apply(pose)` referme chaque canal dans une plage `[min, max]` par axe, réglable par articulation (`setLimit(nom, axe, min, max)`). Sert de filet de sécurité après le retargeting : même si l'IK stabilise déjà l'essentiel, ça évite qu'un coude ou un genou affiche une hyperextension visuellement choquante en cas de détection ponctuellement aberrante. Limites par défaut volontairement généreuses, pas une biomécanique exacte.

### Lissage (`core/Smoother.js`)

Une moyenne mobile exponentielle indépendante par axe et par articulation. Le délai (constante de temps en millisecondes) se règle canal par canal via `SkeletonSmoother.setDelay(nomCanal, delayMs)` - c'est ce réglage qui doit être exposé dans le panneau de débogage.

### Retargeting (`core/RetargetConfig.js`)

Trois couches de réglage, dans cet ordre d'application :

1. **Inversion de côté** (`sideInversion.arms/hands/legs`) : échange les valeurs gauche/droite pour tout un groupe de membres. Sert à corriger l'effet miroir de la webcam.
2. **Inversion par axe** (`axisInvert`) : inverse le signe d'un axe. Réglage unique par paire miroir (voir `JointSchema.mirrorGroupKey` - les deux articulations symétriques partagent le même réglage, comme demandé).
3. **Amplification** (`amplification`) : ratio multiplicatif par axe, également fusionné par paire miroir.

`applyRetargeting(pose, config)` applique les trois dans l'ordre et renvoie la pose de sortie, prête pour `VrmController.applyPose()`.

### VRM (`vrm/VrmController.js`)

Les noms d'articulation du squelette global sont choisis pour correspondre directement aux noms d'os humanoïdes VRM (`JOINT_TO_VRM_BONE` est donc une table identité). Les canaux de visage sont mappés vers les préréglages d'expression VRM standard quand ils existent (`blinkLeft`, `blinkRight`, `aa`, `ih`) ; `leftEyebrowRaise`/`rightEyebrowRaise` n'ont pas d'équivalent standard VRM 1.0 et ne sont pas encore appliqués au modèle (à connecter à une expression personnalisée si le modèle en définit une).

## Boucle par frame (à assembler dans `main.js`)

```
timestampMs   = performance.now()
detection     = trackerManager.detect(timestampMs)
rawPose       = globalSkeletonBuilder.build(detection)     // IK + collision déjà appliqués ici
smoothedPose  = skeletonSmoother.update(rawPose, dtMs)
retargeted    = applyRetargeting(smoothedPose, retargetConfig)
outputPose    = jointConstraints.apply(retargeted)          // rigidité, dernier filtre avant le modèle
vrmController.applyPose(outputPose)
vrmController.update(dtSeconds)
overlayRenderer.draw(detection, layerVisibility)   // couches de débogage
sceneManager.render()
```

## Reste à faire

- `src/main.js` : à écrire pour assembler la boucle ci-dessus, gérer le chargement du fichier `.vrm` par l'utilisateur (`<input type="file">`), et démarrer `TrackerManager`.
- `src/render/OverlayRenderer.js` : dessin 2D sur `#overlay-canvas` des landmarks bruts (squelette de pose, maillage du visage, squelette des mains) et, en superposition, du squelette global - chaque couche activable indépendamment.
- `src/ui/DebugPanel.js` : panneau `lil-gui` exposant :
  - visibilité de chaque couche (détection pose, détection visage, détection mains, squelette global) ;
  - les trois interrupteurs d'inversion de côté ;
  - pour chaque groupe de réglage fusionné (`RetargetConfig.axisInvert`/`amplification`), un contrôle par axe ;
  - le délai de lissage par articulation (`SkeletonSmoother.setDelay`) ;
  - les butées par articulation (`JointConstraints.setLimit`) ;
  - le rayon de la capsule torse (`CollisionAvoidance.pushOutOfTorso`) ;
  - la position/rotation/échelle du modèle VRM (`VrmController.setTransform`).
- Chargement du modèle VRM depuis un fichier local (actuellement `VrmController.loadFromUrl` attend une URL - à combiner avec `URL.createObjectURL` pour un `<input type="file">`).
- Extension possible, non demandée dans la V1 : rotation des doigts individuels (actuellement seule la rotation globale du poignet est retargetée), rotation de la clavicule (actuellement à zéro, voir "IK à deux os"), et pieds (actuellement rotation nulle faute de landmarks de pied dans le sous-ensemble utilisé).

## Conventions

- Tous les commentaires de code et cette documentation sont en français, comme le reste des échanges avec l'utilisateur.
- Rotations toujours en radians, ordre d'Euler `'XYZ'`.
- Un canal de visage est représenté comme une rotation à un seul axe rempli (`{x: valeur}`, `y`/`z` absents) pour pouvoir réutiliser telles quelles les mêmes structures `Smoother`/`RetargetConfig` que les articulations.
