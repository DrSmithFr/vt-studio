import { defineConfig, devices } from '@playwright/test';

// Tests e2e : l'application réelle dans Chromium, avec une webcam simulée
// (motif de test généré par Chrome) et le serveur de dev Vite en HTTP sur
// localhost (contexte sécurisé : la webcam est autorisée sans certificat).
//
// Les tests qui chargent les modèles MediaPipe ont besoin d'Internet
// (storage.googleapis.com) ; E2E_OFFLINE=1 les saute.

const PORT = 5174;

export default defineConfig({
  testDir: 'test/e2e',
  timeout: 90_000,
  expect: { timeout: 15_000 },
  fullyParallel: false,
  workers: 1,
  reporter: [['list']],
  use: {
    baseURL: `http://localhost:${PORT}`,
    trace: 'retain-on-failure',
    permissions: ['camera'],
    launchOptions: {
      args: [
        '--use-fake-ui-for-media-stream',
        '--use-fake-device-for-media-stream',
        // WebGL logiciel en mode headless (rendu three.js et délégation GPU
        // de MediaPipe).
        '--enable-unsafe-swiftshader',
        '--use-angle=swiftshader',
      ],
    },
  },
  projects: [{ name: 'chromium', use: { ...devices['Desktop Chrome'] } }],
  webServer: {
    command: `npx vite --port ${PORT} --strictPort`,
    url: `http://localhost:${PORT}`,
    env: { VT_HTTP: '1' },
    reuseExistingServer: !process.env.CI,
    timeout: 60_000,
  },
});
