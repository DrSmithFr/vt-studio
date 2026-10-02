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
- Interface : composants maison sans dépendance (`ui/controls.js` : sections repliables, curseurs, interrupteurs, choix segmentés, valeurs en lecture seule), pas de lil-gui ni de framework UI.

## Structure des dossiers

```
src/
  core/
    JointSchema.js       — liste des articulations/canaux, paires miroir, groupes de réglage fusionnés
    SpringFollower.js     — suivi de la KeyPose par le modèle : ressort amorti par articulation (quaternions), déplacement du bassin
    HandRestTracker.js    — repos naturel des doigts appris en continu (moyenne glissante 60 s, mains au repos)
    FeatureExtractor.js    — détection lissée → valeurs relatives (tronc, tête, bras, mains, poignets, jambes, doigts) + expressions ; toute la géométrie des landmarks
    KeyPoseBuilder.js      — valeurs relatives → KeyPose (rotations locales + déplacement du bassin), poses de repos corps / mains
    TwoBoneIK.js            — IK analytique à deux os (loi des cosinus) pour bras et jambes
    CollisionAvoidance.js   — repousse une cible de main hors d'une capsule représentant le torse
    JointConstraints.js     — butées angulaires par articulation (rigidité), appliquées après le retargeting
    RetargetConfig.js       — inversion de côté, inversion par axe, amplification (état + application)
  tracking/
    TrackerManager.js    — webcam + ordonnanceur : détecteurs Holistic ou Composite, FPS par détecteur, dernière détection par partie, statistiques
    detectors.js          — création des tâches MediaPipe et normalisation des résultats au format commun (côtés anatomiques)
    detection.worker.js   — Web Worker (module ES) exécutant un détecteur, GPU avec repli CPU
    backends.js           — WorkerBackend (frames envoyées par l'ordonnanceur) ; RemoteBackend (flux continu, cadencé côté serveur)
    RemoteSession.js      — connexion WebRTC au serveur distant, partagée par les détecteurs distants d'une même adresse
server/
  vt_server.py            — serveur de détection distant (Python, aiortc + MediaPipe), voir server/README.md
  core/DetectionSmoother.js — lissage exponentiel des landmarks et blendshapes, par détecteur, une fois par nouveau résultat
  vrm/
    VrmController.js     — chargement VRM, transform du modèle, application des rotations d'os et des expressions
  render/
    SceneManager.js       — scène three.js (caméra, lumières, renderer)
    OverlayRenderer.js    — surimpression 2D des détections brutes / lissées, alignée sur la vidéo affichée, étiquettes G/D
  utils/
    MathUtils.js          — dérivation d'une rotation Euler à partir d'une paire de landmarks 3D
  core/FeatureSchema.js    — liste des valeurs relatives affichées dans le panneau droit
  ui/
    SettingsStore.js      — réglages par défaut (schéma), persistance, import/export
    MenuBar.js             — barre de menu Fichier / Views / Settings
    LeftPanel.js           — position par défaut, détection, affichage, lissage
    RightPanel.js          — valeurs relatives, retargeting, butées, collision, modèle
    JointDock.js           — menu flottant bas : offsets + ressort par articulation
    controls.js            — bibliothèque de contrôles maison (remplace lil-gui), angles affichés en degrés, badge « à venir »
  main.js                  — point d'entrée : câblage store / interface / pipeline, boucle par frame
  style.css
index.html
```

## Concepts clés

### Valeurs relatives (`core/FeatureExtractor.js`, `core/FeatureSchema.js`)

Toute la géométrie liée aux landmarks est dans `FeatureExtractor.extract(detection, { mirror, aspect, framing, calibration })`, qui renvoie `{ raw, values, has, expressions }` :

- **Repère de l'avatar** : `toAvatar` convertit MediaPipe (y bas, z s'éloignant) en (x, -y, -z) ; en miroir, x est inversé et les côtés échangés (la main gauche de la personne pilote le côté droit de l'avatar). Toutes les clés `left*/right*` des valeurs sont des côtés **de l'avatar**.
- **Tronc** : `pelvisX` (position du bassin à l'écran, centrée), `shouldersY` (hauteur des épaules), `pelvisYaw`, `spineAngle` (inclinaison latérale), `spineLean` (avant/arrière), `spineTwist` (rotation des épaules par rapport au bassin). `torsoQuaternions(values)` reconstruit hips/spine/chest (inclinaisons réparties à moitié entre spine et chest) et sert aux deux côtés (extraction et reconstruction) pour que les bras soient mesurés et reconstruits dans le même repère.
- **Tête** : orientation tirée du maillage du visage (coins des yeux, front, menton), relative à la poitrine.
- **Bras** : IK à deux os (voir plus bas), puis élévation / azimut du bras dans le repère **réel** de la poitrine (non calibré) et position de la main en longueurs de bras.
- **Repère de la paume** (`palmFrame`) : f vers les doigts, s vers le pouce, n côté paume = f × s pour une main **gauche** anatomique, -(f × s) pour une droite (paume face caméra doigts levés : le pouce est côté médial). Une erreur de ce signe tourne les mains de 180° autour de l'avant-bras.
- **Poignet** : orientation complète (twist compris) à partir du repère de la paume (HandLandmarker si la main est détectée, sinon poignet / index / auriculaire de la pose), relative à l'avant-bras reconstruit.
- **Doigts** : dans le repère de la paume, flexion et écart de la 1re phalange, flexion cumulée du bout.
- **Repos naturel des doigts** (`core/HandRestTracker.js`, mode « Auto (60 s) », par défaut) : moyenne glissante circulaire sur ~60 s des valeurs brutes des doigts, mise à jour seulement main au repos (vitesse moyenne < 0,5 rad/s et, après 10 s d'apprentissage, écart moyen au repos appris < 0,6 rad, pour qu'un geste tenu ne dérive pas vers le neutre). Elle sert de zéro aux doigts, et ce zéro correspond à la pose « Repos des mains » du modèle (`handsRelativeToRest` dans `KeyPoseBuilder`). Sauvegardée toutes les 10 s (`settings.calibration.handsAuto`). Le mode « Manuel » utilise la capture main ouverte.
- **Calibration** : les clés marquées `calibration: 'body' | 'hands'` dans `FeatureSchema` sont exprimées relativement à une référence (`settings.calibration`), capturée par les boutons du panneau gauche (compte à rebours de 3 s, moyenne circulaire sur 0,6 s).

### KeyPose (`core/KeyPoseBuilder.js`, `render/KeyPoseSkeleton.js`)

`KeyPoseBuilder.build(extraction, { restPose, motion, bodyCalibrated })` reconstruit la pose **uniquement** à partir des valeurs relatives : tronc, tête (40 % cou / 60 % tête), bras (direction du bras + avant-bras vers la position de la main, proportion bras/avant-bras du modèle), poignet, jambes, doigts (axes de flexion / écart déduits de la direction de repos de chaque phalange dans le modèle, `VrmController.getRestInfo()`), et déplacement du bassin (`motion.lateralRange` ; vertical seulement après calibration du corps). Parties non détectées → poses de repos (`BODY_REST_POSES`, `HAND_REST_POSES`).

`KeyPoseSkeleton` duplique la hiérarchie des os normalisés du modèle et affiche la cible (couche « Squelette KeyPose ») ; le modèle visible la suit (lissage par articulation en attendant le ressort de la phase 6).

Rotations calculées dans le repère VRM 1.0 ; `VrmController.toModelQuaternion` les convertit pour un modèle VRM 0.x (x et z inversés, repère local tourné de π).

### IK à deux os (`core/TwoBoneIK.js`)

Corrige le problème initial de tremblement des bras : calculer la rotation de chaque segment indépendamment à partir de son propre landmark fait porter toute la fiabilité du bras sur la profondeur (z) du coude/genou, qui est le point le plus bruité de MediaPipe (articulation la plus repliée à l'écran).

À la place, `solveTwoBoneIK({ root, hint, target, upperLength, lowerLength })` :

1. Fixe la racine (épaule/hanche) et la cible (poignet/cheville, sources de vérité).
2. Calcule l'angle de flexion **analytiquement**, par la loi des cosinus, à partir des longueurs de segment - jamais à partir de la profondeur brute du hint.
3. N'utilise le landmark intermédiaire (`hint`, coude/genou) que pour définir le plan de flexion (de quel côté plier), via un produit vectoriel - pas pour la distance de flexion.

Les longueurs de segment (`upperLength`/`lowerLength`) sont calibrées progressivement par moyenne mobile lente (`FeatureExtractor.#calibrateLength`, α = 0.05) plutôt que mesurées frame par frame, pour la même raison : une distance instantanée reste sensible au bruit, une longueur qui se stabilise sur quelques secondes ne l'est plus.

Appliqué aux bras (épaule → coude-indice → poignet-cible) et aux jambes (hanche → genou-indice → cheville-cible).

### Évitement de collision avec le torse (`core/CollisionAvoidance.js`)

Avant de résoudre l'IK d'un bras, `pushOutOfTorso(target, shoulderMid, hipMid, radius)` modélise le buste comme une capsule simple (segment épaules-milieu → hanches-milieu, rayon par défaut 0,14 m) et repousse radialement la cible (poignet) à la surface si elle tombe à l'intérieur. Évite qu'un mouvement bras croisés fasse traverser le buste au modèle VRM. Pas encore appliqué aux jambes (pas de cas d'usage identifié pour l'instant).

### Rigidité (`core/JointConstraints.js`)

`JointConstraints.apply(pose)` referme chaque canal dans une plage `[min, max]` par axe, réglable par articulation (`setLimit(nom, axe, min, max)`). Sert de filet de sécurité après le retargeting : même si l'IK stabilise déjà l'essentiel, ça évite qu'un coude ou un genou affiche une hyperextension visuellement choquante en cas de détection ponctuellement aberrante. Limites par défaut volontairement généreuses, pas une biomécanique exacte.

### Suivi par ressort (`core/SpringFollower.js`)

Chaque os du modèle suit la cible (KeyPose après retargeting, butées et offsets) par un ressort amorti : l'écart de rotation (vecteur axe × angle, plus court chemin) donne une accélération `k · écart − c · vitesse`, intégrée en Euler semi-implicite par sous-pas ≤ 1/240 s (stable même à forte raideur). Taux d'amortissement ζ = c / (2√k). Réglages par articulation dans `settings.joints` (menu du bas, avec affichage de ζ, du temps de réponse à 90 % et du dépassement) ; par défaut ζ ≈ 0,95 : corps 400 / 38 (~180 ms), doigts 600 / 46, bassin 150 / 24 (règle aussi le ressort vectoriel du déplacement du bassin). Raideur 0 = cible appliquée directement. Le lissage en amont se fait sur les landmarks (`DetectionSmoother`), plus sur les angles.

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
2. ✅ Coquille d'interface : barre de menu (`ui/MenuBar.js`), panneaux gauche/droit (`ui/LeftPanel.js`, `ui/RightPanel.js`), menu flottant bas (`ui/JointDock.js`), couches Views, réglages centralisés et persistés (`ui/SettingsStore.js` : localStorage + import/export JSON ; les sous-systèmes partagent les objets du store, `mergeInto` préserve les références). Les sections pas encore branchées portent un badge « à venir » (`pendingBadge`).
3. ✅ Détection : un Web Worker par détecteur (Holistic ou Composite), ordonnanceur FPS par détecteur, modèle de pose lite/full/heavy, statistiques (FPS effectif, inférence, GPU/CPU), lissage des landmarks (`DetectionSmoother`), surimpression brute / lissée. Points d'attention : les workers sont des modules ES (`worker.format: 'es'` dans `vite.config.js`) et utilisent la variante « module » du WASM MediaPipe ; les étiquettes de latéralité des détecteurs de mains (HandLandmarker, Holistic) se sont révélées peu fiables : chaque main est rattachée au poignet du squelette de pose le plus proche à l'écran (`assignHandsToWrists` dans `TrackerManager.js`), les étiquettes ne servant que sans squelette. Holistic tourne toujours sur CPU (`CPU_ONLY` dans `detection.worker.js`) : son FaceBlendshapesGraph n'est pas supporté en WebGL et l'échec n'est que journalisé par le runtime WASM, sans exception détectable.
4. ✅ Calibration (corps / mains, compte à rebours) + poses de repos + extraction des valeurs relatives (panneau droit).
5. ✅ KeyPose : reconstruite depuis les seules valeurs relatives (tronc, tête, bras, poignets avec twist, jambes, doigts, déplacement du bassin), squelette dupliqué affiché (couche KeyPose), conversion VRM 0.x. Aller-retour extraction → reconstruction vérifié numériquement (bras, coude, genou, index, orientation de la tête, direct et miroir).
   Déjà corrigé en avance (défauts du noyau récupéré) : conversion du repère MediaPipe (y bas, z s'éloignant) vers celui de l'avatar (`toAvatarSpace` : (x, -y, -z), x inversé en miroir) ; directions de repos de la T-pose VRM normalisée (bras ±X, colonne +Y, jambes -Y) ; rotations **locales** calculées os par os dans le repère du parent (`swingRotation` dans `utils/MathUtils.js`) ; miroir de l'avatar au niveau des landmarks (côtés échangés + x inversé, réglage `general.mirrorAvatar`) ; jambes figées selon le cadrage ; angles déroulés dans `Smoother` (plus de saut à ±π) ; NaN des canaux de visage. Vérifié numériquement (T-pose, bras le long du corps, bras vers la caméra, coude plié, direct et miroir).
6. ✅ Suivi par ressort amorti (`SpringFollower`, remplace le lissage exponentiel des angles), menu du bas actif (raideur / amortissement, ζ et temps de réponse affichés, « Appliquer au groupe »). Migration des réglages v1 → v2 (anciennes valeurs provisoires du ressort abandonnées).
7. ✅ Backend distant : `server/vt_server.py` (aiohttp pour la signalisation `POST /offer`, aiortc pour WebRTC, MediaPipe Tasks Python), une connexion WebRTC par adresse partagée par les détecteurs distants (`RemoteSession`), DataChannel `control` fiable (configuration : détecteurs, FPS, modèle) et `detections` non fiable / non ordonné (résultats au format commun) ; dernière frame seulement, un thread par détecteur à son FPS. Composite mixte Worker / distant. Le serveur doit être en HTTPS (page en HTTPS → contenu mixte bloqué sinon) et son certificat accepté une fois dans le navigateur. Non testé de bout en bout ici (dépendances Python absentes, Python 3.14 trop récent pour mediapipe) ; normalisation vérifiée avec des modules bouchons.
8. Validation en conditions réelles, valeurs par défaut, documentation.

Extensions non prioritaires : clavicule, pieds (landmarks 29-32), twist du poignet.

## Conventions

- Tous les commentaires de code et cette documentation sont en français, comme le reste des échanges avec l'utilisateur.
- Rotations toujours en radians, ordre d'Euler `'XYZ'`.
- Un canal de visage est représenté comme une rotation à un seul axe rempli (`{x: valeur}`, `y`/`z` absents) pour pouvoir réutiliser telles quelles les mêmes structures `Smoother`/`RetargetConfig` que les articulations.
