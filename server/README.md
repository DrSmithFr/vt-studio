# Serveur de détection distant

Exécute les détecteurs MediaPipe sur une autre machine (plus puissante, ou pour décharger le poste de stream). Le navigateur lui envoie la webcam par WebRTC et reçoit les landmarks par DataChannel, au même format que le Web Worker.

## Installation

Python 3.9 à 3.12 (versions prises en charge par `mediapipe`). Si le Python du système est plus récent (ex. 3.14), créer l'environnement avec une version compatible, par exemple avec [uv](https://docs.astral.sh/uv/) : `uv venv --python 3.12 .venv`.

```bash
cd server
python3 -m venv .venv
source .venv/bin/activate        # Windows : .venv\Scripts\activate
pip install -r requirements.txt
```

Les modèles MediaPipe (`.task`) sont téléchargés au premier usage dans `server/models/`.

## Certificat (obligatoire)

La page de VTuber Studio est servie en HTTPS : le navigateur refuse d'appeler un serveur en HTTP depuis une page HTTPS (contenu mixte). Le serveur doit donc avoir un certificat, auto-signé suffit :

```bash
mkdir -p .cert
openssl req -x509 -newkey rsa:2048 -nodes -days 825 \
  -keyout .cert/key.pem -out .cert/cert.pem -subj "/CN=vt-server" \
  -addext "subjectAltName=DNS:localhost,IP:127.0.0.1,IP:<ip-du-serveur>"
```

Si le serveur tourne sur la même machine que le serveur de dev, le certificat `../.cert/` du projet peut être réutilisé.

## Lancement

```bash
python vt_server.py --cert .cert/cert.pem --key .cert/key.pem
# options : --port 8765  --gpu  --verbose
```

Puis, **une fois**, ouvrir `https://<ip-du-serveur>:8765/` dans le navigateur qui affiche VTuber Studio et accepter le certificat (sinon la connexion échoue sans message clair).

Dans VTuber Studio : panneau gauche → Détection → « Serveur distant » = `https://<ip-du-serveur>:8765`, puis choisir « Distant » pour Holistic ou pour un ou plusieurs détecteurs en mode Composite.

## Notes

- `--gpu` : délégation GPU de MediaPipe. Selon la plateforme et la version de `mediapipe`, elle n'est pas toujours disponible en Python ; sans l'option, tout tourne sur CPU.
- Un seul flux vidéo par navigateur, partagé par tous les détecteurs distants. Chaque détecteur tourne dans son propre thread, à son FPS, toujours sur la frame la plus récente.
- Les résultats passent par un DataChannel non fiable et non ordonné : un résultat en retard est perdu plutôt que de retarder les suivants.
- Réseau : WebRTC sans serveur STUN/TURN, prévu pour un réseau local ou un VPN (Tailscale…).
