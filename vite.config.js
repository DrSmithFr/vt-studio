import { defineConfig } from 'vite';
import fs from 'node:fs';

// La webcam (getUserMedia) n'est accessible qu'en contexte sécurisé : HTTPS
// ou localhost. Pour tester depuis une autre machine du réseau (LAN,
// Tailscale), le serveur de dev passe en HTTPS avec un certificat auto-signé
// généré localement dans .cert/ (non versionné). Commande pour le recréer :
//
//   openssl req -x509 -newkey rsa:2048 -nodes -days 825 \
//     -keyout .cert/key.pem -out .cert/cert.pem -subj "/CN=vt-studio" \
//     -addext "subjectAltName=DNS:localhost,IP:127.0.0.1,IP:<ip-du-poste>"
const CERT_DIR = new URL('./.cert/', import.meta.url);
// VT_HTTP=1 force le HTTP (tests e2e sur localhost, contexte sécurisé
// même sans certificat).
const hasCert =
  !process.env.VT_HTTP &&
  fs.existsSync(new URL('cert.pem', CERT_DIR)) &&
  fs.existsSync(new URL('key.pem', CERT_DIR));

export default defineConfig({
  // Workers de détection en modules ES : MediaPipe y charge son runtime WASM
  // par import() dynamique (variante « module »), impossible dans un worker
  // classique où il tenterait importScripts sur un module ES.
  worker: {
    format: 'es',
  },
  server: {
    host: '0.0.0.0',
    https: hasCert
      ? { cert: fs.readFileSync(new URL('cert.pem', CERT_DIR)), key: fs.readFileSync(new URL('key.pem', CERT_DIR)) }
      : undefined,
  },
});
