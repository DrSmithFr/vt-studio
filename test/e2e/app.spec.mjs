import { test, expect } from '@playwright/test';
import { readFile } from 'node:fs/promises';

// --- Utilitaires ---------------------------------------------------------------

async function openApp(page) {
  await page.goto('/');
  // Le modèle VRM par défaut est chargé au démarrage.
  await expect(page.locator('#status-bar')).toContainText('(VRM 1.0)', { timeout: 60_000 });
}

async function menu(page, title, ...path) {
  await page.locator('.menubar-item', { hasText: title }).click();
  for (const label of path) {
    const entry = page.locator('.menu-dropdown .menu-entry', { has: page.locator('.menu-label', { hasText: label }) }).last();
    // Sous-menu : survol pour l'ouvrir, sinon clic.
    if (await entry.evaluate((el) => el.classList.contains('has-submenu'))) await entry.hover();
    else await entry.click();
  }
}

const row = (page, label) =>
  page.locator('.ctl-row', { has: page.locator('.ctl-label', { hasText: new RegExp(`^${label}$`) }) }).first();

const readout = (page, label) => row(page, label).locator('.ctl-value');

// --- Interface ---------------------------------------------------------------

test('interface : menus, panneaux, menu des articulations, barre de statut', async ({ page }) => {
  await openApp(page);
  await expect(page.locator('.menubar-item')).toHaveText(['Fichier', 'Views', 'Settings']);
  for (const section of ['Position par défaut', 'Détection', 'Affichage', 'Lissage']) {
    await expect(page.locator('#left-panel .ctl-section-header', { hasText: section })).toBeVisible();
  }
  for (const section of ['Valeurs relatives', 'Retargeting', 'Mouvement', 'Butées', 'Collision', 'Modèle']) {
    await expect(page.locator('#right-panel .ctl-section-header', { hasText: section })).toBeVisible();
  }
  await expect(page.locator('#joint-dock')).toBeVisible();
  await expect(page.locator('#status-bar')).toContainText('détection désactivée');
});

test('menu Views : masquer puis réafficher un panneau', async ({ page }) => {
  await openApp(page);
  await menu(page, 'Views', 'Panneau gauche');
  await expect(page.locator('#left-panel')).toBeHidden();
  await menu(page, 'Views', 'Panneau gauche');
  await expect(page.locator('#left-panel')).toBeVisible();
});

test('réglages conservés après rechargement', async ({ page }) => {
  await openApp(page);
  await page.locator('#left-panel .ctl-segment', { hasText: 'Holistic' }).click();
  await expect(row(page, 'Exécution')).toBeVisible();
  await page.waitForTimeout(500); // sauvegarde différée
  await page.reload();
  await expect(page.locator('#left-panel .ctl-segment.active', { hasText: 'Holistic' })).toBeVisible();
  await expect(row(page, 'FPS corps')).toBeHidden();
});

test('export puis import des réglages', async ({ page }) => {
  await openApp(page);
  const download = page.waitForEvent('download');
  await menu(page, 'Fichier', 'Exporter les réglages');
  const exported = JSON.parse(await readFile(await (await download).path(), 'utf8'));
  expect(exported.version).toBe(2);
  expect(exported.settings.detection.mode).toBe('composite');

  exported.settings.general.framing = 'seated';
  await page.locator('#settings-file').setInputFiles({
    name: 'reglages.json',
    mimeType: 'application/json',
    buffer: Buffer.from(JSON.stringify(exported)),
  });
  await menu(page, 'Settings', 'Cadrage');
  await expect(
    page.locator('.menu-entry', { has: page.locator('.menu-label', { hasText: 'Assis (buste)' }) }).locator('.menu-check'),
  ).toHaveText('✓');
});

test('chargement du modèle VRM 0.x fourni', async ({ page }) => {
  await openApp(page);
  await menu(page, 'Fichier', 'Modèles fournis', 'Avatar (VRM 0.x)');
  await expect(page.locator('#status-bar')).toContainText('(VRM 0.x)', { timeout: 60_000 });
});

test('menu des articulations : doigts disponibles, réponse du ressort affichée', async ({ page }) => {
  await openApp(page);
  await page.locator('.joint-dock-header select').selectOption('leftIndexProximal');
  await expect(page.locator('#joint-dock')).toContainText('Index 1 G');
  await expect(readout(page, 'Réponse')).toContainText('ζ');
  await expect(page.locator('#joint-dock .ctl-badge')).toHaveCount(0);
});

test('calibration impossible sans détection : message explicite', async ({ page }) => {
  await openApp(page);
  const dialog = page.waitForEvent('dialog');
  await page.locator('.ctl-button', { hasText: 'Calibrer le corps' }).click();
  const message = await dialog;
  expect(message.message()).toContain('Activez la détection');
  await message.dismiss();
});

test('détection distante sans adresse : erreur dans les statistiques', async ({ page }) => {
  await openApp(page);
  await page.locator('#left-panel .ctl-segment', { hasText: 'Holistic' }).click();
  await row(page, 'Exécution').locator('.ctl-segment', { hasText: 'Distant' }).click();
  await page.keyboard.press('d');
  await expect(page.locator('#status-bar')).toContainText('détection active');
  await expect(readout(page, 'Holistic')).toContainText('adresse du serveur distant');
  await page.keyboard.press('d');
  await expect(page.locator('#status-bar')).toContainText('détection désactivée');
});

// --- Détection réelle (modèles MediaPipe téléchargés : Internet requis) -------

test('détection Composite sur la webcam simulée', async ({ page }) => {
  test.skip(!!process.env.E2E_OFFLINE, 'modèles MediaPipe téléchargés depuis Internet');
  await openApp(page);
  await page.keyboard.press('d');
  await expect(page.locator('#status-bar')).toContainText('détection active');
  for (const detector of ['Corps', 'Visage', 'Mains']) {
    await expect(readout(page, detector)).toContainText('fps', { timeout: 60_000 });
    await expect(readout(page, detector)).not.toContainText('erreur');
  }
});
