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
  core/FeatureSchema.js    — liste des valeurs relatives affichées dans le panneau droit
  ui/
    SettingsStore.js      — réglages par défaut (schéma), persistance, import/export
    MenuBar.js             — barre de menu Fichier / Views / Settings
    LeftPanel.js           — position par défaut, détection, affichage, lissage
    RightPanel.js          — valeurs relatives, retargeting, butées, collision, modèle
    JointDock.js           — menu flottant bas : offsets + ressort par articulation
    guiHelpers.js          — lil-gui intégré, angles affichés en degrés, badge « à venir »
  main.js                  — point d'entrée : câblage store / interface / pipeline, boucle par frame
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

## Architecture cible (reconstruction après perte, 2026-10-02)

Le projet a été perdu (formatage sans backup) et est reconstruit. Les sections ci-dessus décrivent le noyau récupéré ; la version perdue allait plus loin. Cible décrite par l'utilisateur :

### Pipeline

```
Webcam
 → Backends de détection, au choix :
     Holistic  : HolisticLandmarker, en Web Worker OU en remote
     Composite : Pose / Face / Hand séparés, chacun en Web Worker OU en remote (mixte possible)
   Remote = serveur Python + MediaPipe officiel, vidéo envoyée par WebRTC,
            landmarks renvoyés par DataChannel (dossier server/)
 → Ordonnanceur : limite de FPS par détecteur (corps espacé, visage normal, mains fréquentes)
 → Lissage des landmarks (« détection lissée », affichable en surimpression)
 → Calibration (zéro de référence, séparée corps / mains)
 → Extraction de valeurs relatives (panneau droit) :
     position latérale du bassin (% largeur écran), hauteur des épaules (% hauteur écran),
     angle + rotation de la colonne, 2 angles épaule-bras, position des mains,
     doigts : 2 angles pour la 1re phalange + 1 angle pour le bout
 → Reconstruction de la KeyPose : squelette du modèle dupliqué, piloté par les valeurs
   relatives (IK à deux os, évitement du torse, interpolation du reste) ;
   pose de repos (corps / mains séparés) pour les parties non détectées
 → Retargeting (inversion de côté, inversion / amplification par axe fusionnées) + butées
 → Offsets par articulation (menu flottant du bas)
 → Suivi : chaque os du modèle visible suit la KeyPose par ressort amorti,
   raideur / amortissement réglables par articulation (menu flottant du bas)
 → Modèle VRM
```

### Interface (type logiciel)

1. **Barre de menu** : Fichier (ouvrir un VRM, import/export des réglages), Views (visibilité des couches : caméra, détections brutes, détection lissée, squelette KeyPose, modèle), Settings.
2. **Panneau gauche** : position par défaut (pose de repos + calibration, corps / mains séparés), paramètres de détection (Holistic / Composite, Worker / remote par détecteur, FPS par détecteur), affichage caméra / détections / détection lissée, paramètres de lissage.
3. **Panneau droit** : debug de l'animation (valeurs relatives extraites, temps réel), réglages de retargeting.
4. **Menu flottant en bas** : par articulation du modèle, offsets et paramètres du ressort de retour à la KeyPose.

Réglages persistés (localStorage) et exportables en JSON depuis le menu Fichier.

## Feuille de route de la reconstruction

1. ✅ Récupération + premier commit ; boucle minimale (`main.js`), chargement VRM 0.x/1.0 (liste, fichier, glisser-déposer), WASM MediaPipe servi localement, serveur de dev HTTPS sur 0.0.0.0 (certificat auto-signé dans `.cert/`, non versionné, voir `vite.config.js`).
2. ✅ Coquille d'interface : barre de menu (`ui/MenuBar.js`), panneaux gauche/droit (`ui/LeftPanel.js`, `ui/RightPanel.js`), menu flottant bas (`ui/JointDock.js`), couches Views, réglages centralisés et persistés (`ui/SettingsStore.js` : localStorage + import/export JSON ; les sous-systèmes partagent les objets du store, `mergeInto` préserve les références). Les sections pas encore branchées portent un badge « à venir » (`markPending`).
3. Détection : backend Web Worker (Holistic + Composite), ordonnanceur FPS par détecteur, lissage des landmarks, surimpression (caméra, brut, lissé).
4. Calibration + poses de repos + extraction des valeurs relatives (panneau droit).
5. KeyPose : squelette dupliqué reconstruit depuis les valeurs relatives (IK, collision, doigts), couche de debug. Corrige au passage les défauts du noyau récupéré : repère MediaPipe (Y vers le bas) vs three.js, rotations globales vs locales, NaN du lisseur sur les canaux de visage.
6. Suivi par ressort amorti + menu du bas (offsets, raideur/amortissement) + retargeting et butées dans le panneau droit.
7. Backend remote : serveur Python (MediaPipe + WebRTC/aiortc), DataChannel, mode Composite mixte.
8. Validation en conditions réelles, valeurs par défaut, documentation.

Extensions non prioritaires : clavicule, pieds (landmarks 29-32), twist du poignet.

## Conventions

- Tous les commentaires de code et cette documentation sont en français, comme le reste des échanges avec l'utilisateur.
- Rotations toujours en radians, ordre d'Euler `'XYZ'`.
- Un canal de visage est représenté comme une rotation à un seul axe rempli (`{x: valeur}`, `y`/`z` absents) pour pouvoir réutiliser telles quelles les mêmes structures `Smoother`/`RetargetConfig` que les articulations.
