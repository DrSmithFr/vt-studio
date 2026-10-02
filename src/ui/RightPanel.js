import { FEATURE_GROUPS } from '../core/FeatureSchema.js';
import { JOINT_LABELS, mirrorGroupLabel } from '../core/JointSchema.js';
import { addAngle, createEmbeddedGui, markPending, refreshGui } from './guiHelpers.js';

const RAD_TO_DEG = 180 / Math.PI;
const AXES = ['x', 'y', 'z'];

function formatFeature(value, unit) {
  if (value === undefined || value === null || Number.isNaN(value)) return '—';
  if (unit === 'pct') return `${(value * 100).toFixed(1)} %`;
  if (unit === 'deg') return `${(value * RAD_TO_DEG).toFixed(1)}°`;
  return value.toFixed(2);
}

// Panneau droit : debug de l'animation (valeurs relatives extraites) et
// réglages de retargeting.
export class RightPanel {
  constructor(container, store) {
    const settings = store.data;
    this.gui = createEmbeddedGui(container, 'Animation', () => store.commit());

    // --- Valeurs relatives, lecture seule, mises à jour par setFeatures().
    const featuresFolder = this.gui.addFolder('Valeurs relatives');
    this.featureDisplay = {};
    this.featureControllers = [];
    for (const group of FEATURE_GROUPS) {
      const folder = featuresFolder.addFolder(group.title);
      if (group.title.startsWith('Doigts')) folder.close();
      for (const { key, label, unit } of group.features) {
        this.featureDisplay[key] = '—';
        const controller = folder.add(this.featureDisplay, key).name(label).disable();
        this.featureControllers.push({ controller, folder, key, unit });
      }
    }
    markPending(featuresFolder, 4);

    // --- Retargeting : inversion de côté, puis inversion / amplification
    // par axe pour chaque groupe (paires miroir fusionnées).
    const retarget = this.gui.addFolder('Retargeting');
    const r = settings.retarget;
    const sides = retarget.addFolder('Inversion de côté');
    sides.add(r.sideInversion, 'arms').name('Bras');
    sides.add(r.sideInversion, 'hands').name('Mains');
    sides.add(r.sideInversion, 'legs').name('Jambes');

    const groups = retarget.addFolder('Par articulation');
    for (const groupKey of Object.keys(r.axisInvert)) {
      const folder = groups.addFolder(mirrorGroupLabel(groupKey)).close();
      for (const axis of AXES) {
        folder.add(r.axisInvert[groupKey], axis).name(`Inverser ${axis.toUpperCase()}`);
      }
      for (const axis of AXES) {
        folder.add(r.amplification[groupKey], axis, 0, 3, 0.05).name(`Ampli. ${axis.toUpperCase()}`);
      }
    }
    groups.close();

    // --- Butées par articulation (JointConstraints), affichées en degrés.
    const limits = this.gui.addFolder('Butées').close();
    for (const [joint, axes] of Object.entries(settings.constraints)) {
      const folder = limits.addFolder(JOINT_LABELS[joint] ?? joint).close();
      for (const [axis, range] of Object.entries(axes)) {
        addAngle(folder, range, 0, `${axis.toUpperCase()} min`);
        addAngle(folder, range, 1, `${axis.toUpperCase()} max`);
      }
    }

    // --- Collision avec le torse.
    const collision = this.gui.addFolder('Collision').close();
    collision.add(settings.collision, 'torsoRadius', 0.05, 0.3, 0.005).name('Rayon du torse (m)');

    // --- Transform du modèle.
    const model = this.gui.addFolder('Modèle').close();
    model.add(settings.model.position, 'x', -2, 2, 0.01).name('Position X');
    model.add(settings.model.position, 'y', -2, 2, 0.01).name('Position Y');
    model.add(settings.model.position, 'z', -2, 2, 0.01).name('Position Z');
    addAngle(model, settings.model, 'rotationY', 'Rotation Y');
    model.add(settings.model, 'scale', 0.1, 3, 0.01).name('Échelle');
  }

  // `features` : { [clé]: valeur } (voir FeatureSchema). Seuls les dossiers
  // ouverts sont redessinés, l'appel peut donc être fait à chaque frame.
  setFeatures(features) {
    for (const { controller, folder, key, unit } of this.featureControllers) {
      this.featureDisplay[key] = formatFeature(features?.[key], unit);
      if (!folder._closed && !folder.parent._closed) controller.updateDisplay();
    }
  }

  refresh() {
    refreshGui(this.gui);
  }
}
