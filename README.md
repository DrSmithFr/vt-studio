# VTuber Studio

Studio de VTubing dans le navigateur : la webcam est analysée en temps réel (corps, visage, mains, doigts) et anime un avatar **VRM** (0.x ou 1.0). Tout tourne en local dans le navigateur ; la détection peut aussi être déportée sur une autre machine.

- Détection MediaPipe **Holistic** ou **Composite** (corps / visage / mains séparés), chaque détecteur dans un Web Worker ou sur un serveur distant, avec son propre FPS.
- Reconstruction d'une **KeyPose** à partir de valeurs relatives (bassin, épaules, colonne, tête, bras, poignets, jambes, doigts), puis suivi par le modèle avec un **ressort amorti** par articulation.
- **Calibration** du corps, **repos naturel des doigts** appris en continu, poses de repos pour les parties non détectées.
- Interface de type logiciel : barre de menu, panneaux de réglages, menu des articulations, surimpressions de debug.

## Prérequis

- Node.js 20 ou plus récent.
- Un navigateur Chromium récent (Chrome, Edge) avec WebGL 2, et une webcam.
- Pour la détection distante uniquement : Python 3.9 à 3.12 (voir [`server/README.md`](server/README.md)).

## Installation et lancement

```bash
npm install
npm run dev
```

La webcam n'est accessible qu'en **HTTPS** ou sur `localhost`. Pour ouvrir l'application depuis une autre machine (réseau local, Tailscale…), générer un certificat auto-signé dans `.cert/` (non versionné) avant `npm run dev` ; le serveur passe alors en HTTPS automatiquement :

```bash
mkdir -p .cert
openssl req -x509 -newkey rsa:2048 -nodes -days 825 \
  -keyout .cert/key.pem -out .cert/cert.pem -subj "/CN=vt-studio" \
  -addext "subjectAltName=DNS:localhost,IP:127.0.0.1,IP:<ip-du-poste>"
```

Le serveur écoute sur toutes les interfaces (`https://<ip>:5173/`). Au premier accès, le navigateur signale le certificat auto-signé : « Paramètres avancés » → « Continuer ».

Build de production : `npm run build` (dossier `dist/`).

## Prise en main

1. Le modèle fourni (`public/models/avatar.vrm`) se charge au démarrage. Pour un autre modèle : **Fichier → Ouvrir un modèle VRM…** (Ctrl+O) ou glisser-déposer un `.vrm` sur la page.
2. Activer la détection : touche **D** (ou interrupteur « Détection active » du panneau gauche). Les statistiques de chaque détecteur (FPS effectif, temps d'inférence, GPU/CPU) s'affichent sous Détection → Statistiques.
3. **Calibrer le corps** (panneau gauche → Position par défaut) : se tenir droit, face caméra, pendant le compte à rebours de 3 s.
4. **Doigts** : en mode « Auto (60 s) » (par défaut), garder les mains détendues une quinzaine de secondes ; le repos naturel des doigts est appris en continu et correspond à la pose « Repos des mains » du modèle.
5. Ajuster au besoin : amplitudes du mouvement du bassin, retargeting, butées (panneau droit) ; offsets et ressort de chaque articulation (menu du bas).

L'avatar est en **miroir** par défaut : lever la main droite anime le bras de l'avatar situé du même côté de l'écran que dans un miroir (Settings → Avatar en miroir).

## Interface

### Barre de menu

| Menu | Contenu |
|---|---|
| **Fichier** | Ouvrir un modèle VRM, modèles fournis, importer / exporter les réglages (JSON) |
| **Views** | Couches : caméra, détections brutes, détection lissée, squelette KeyPose, modèle ; panneaux gauche / droit, menu des articulations |
| **Settings** | Détection active, cadrage (automatique / assis / debout), caméra en miroir, avatar en miroir, réinitialisation de tous les réglages |

### Panneau gauche — capture

- **Position par défaut** : pose de repos du corps (bras le long du corps, mains sur les cuisses, T-pose) et des mains (détendues, ouvertes, poing), utilisée pour les parties non détectées ; zéro des doigts (Auto 60 s / Manuel) ; calibration du corps et des mains (ouvertes, mode manuel) ; état de la calibration.
- **Détection** : activation, mode Composite ou Holistic, exécution (Worker / Distant) par détecteur, FPS par détecteur, modèle de corps (lite / full / heavy), adresse du serveur distant, statistiques.
- **Affichage** : caméra, détections brutes (traits blancs fins), détection lissée (couleurs, étiquettes G/D aux poignets).
- **Lissage** : constante de temps du lissage des landmarks, par détecteur.

### Panneau droit — animation

- **Valeurs relatives** (temps réel) : tronc, tête, bras, mains et poignets, jambes, doigts.
- **Retargeting** : inversion gauche/droite par groupe de membres ; inversion et amplification par axe, réglage unique pour chaque paire gauche/droite.
- **Mouvement** : amplitude du déplacement latéral et vertical du bassin (le vertical n'est actif qu'après calibration du corps).
- **Butées**, **Collision** (rayon du torse, pour que les mains ne le traversent pas), **Modèle** (position, rotation, échelle).

### Menu des articulations (en bas)

Pour chaque os (corps et doigts) : offsets X / Y / Z, raideur et amortissement du ressort qui ramène l'os vers la KeyPose, avec l'aperçu de la réponse (ζ, temps pour atteindre 90 %, rebond), et « Appliquer au groupe ».

### Raccourcis

| Touche | Action |
|---|---|
| **D** | Activer / désactiver la détection |
| **Ctrl+O** | Ouvrir un modèle VRM |
| **Échap** | Fermer un menu |
| Double-clic sur le libellé d'un curseur | Revenir à sa valeur initiale |

Les réglages sont enregistrés automatiquement dans le navigateur et peuvent être exportés / importés en JSON.

## Détection distante

Le dossier [`server/`](server/README.md) contient un serveur Python (MediaPipe + WebRTC) : le navigateur lui envoie la webcam et reçoit les résultats au même format que le Web Worker. En mode Composite, chaque détecteur peut tourner localement ou à distance.

## Tests

```bash
npm test                 # tests unitaires et fonctionnels (Node, sans navigateur)
npm run test:unit
npm run test:functional
npm run test:server      # serveur distant (Python, sans dépendance requise)
npm run test:e2e         # bout en bout dans Chromium (Playwright)
npm run test:all
```

| Niveau | Emplacement | Couvre |
|---|---|---|
| Unitaire | `test/unit/` | Mathématiques (swing, IK à deux os, collision), schéma des articulations, retargeting, butées, réglages (fusion, import, migration, persistance), normalisation des détections, ordonnanceur (péremption, attribution des mains aux poignets, backend distant), lissage des landmarks, ressort amorti, repos des doigts |
| Fonctionnel | `test/functional/` | Pipeline complet sur des détections synthétiques : bras / avant-bras / main / doigts / tête / genou dans le repère de l'avatar, en direct et en miroir, cadrage, calibration, déplacement du bassin, poses de repos, expressions, proportions du modèle |
| Serveur | `server/test_vt_server.py` | Normalisation au format commun, configuration des détecteurs, taille des messages |
| Bout en bout | `test/e2e/` | Interface, menus, persistance, import / export, chargement VRM 0.x, menu des articulations, calibration, erreur du mode distant, détection réelle sur webcam simulée |

Les tests e2e utilisent la webcam simulée de Chrome et le serveur de dev en HTTP sur `localhost`. La première fois : `npx playwright install chromium`. Le test de détection réelle télécharge les modèles MediaPipe (Internet requis) ; `E2E_OFFLINE=1 npm run test:e2e` le saute.

## Architecture

```
Webcam → détecteurs (Web Workers ou serveur distant, FPS par détecteur)
       → lissage des landmarks → valeurs relatives (+ calibration, repos des doigts)
       → KeyPose (squelette dupliqué du modèle) → retargeting, butées, offsets
       → ressort amorti par articulation → modèle VRM
```

Le détail (structure des dossiers, repères, conventions, choix techniques) est dans [`CLAUDE.md`](CLAUDE.md).

## Dépannage

| Symptôme | Cause et solution |
|---|---|
| « Webcam indisponible : la page doit être servie en HTTPS » | Page ouverte en HTTP depuis une adresse réseau : générer le certificat (voir plus haut) ou utiliser `localhost`. |
| Holistic plus lent que Composite | Holistic tourne toujours sur CPU (son graphe de visage n'est pas supporté en WebGL). Préférer Composite. |
| « serveur injoignable » en mode distant | Vérifier l'adresse (`https://…:8765`), que le serveur est lancé avec `--cert/--key`, et ouvrir son adresse une fois dans le navigateur pour accepter le certificat. |
| Doigts trop pliés ou crispés | Mode « Auto (60 s) » : garder les mains détendues quelques secondes pour que le repos naturel soit appris ; « Réinitialiser la calibration » pour repartir de zéro. |
| Un membre part dans le mauvais sens sur un modèle particulier | Retargeting → Par articulation : inversion ou amplification par axe. |
| L'avatar flotte ou s'enfonce | Déplacement vertical actif après calibration : recalibrer le corps dans la posture habituelle, ou mettre l'amplitude verticale à 0. |
