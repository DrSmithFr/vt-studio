import { FEATURE_GROUPS } from '../core/FeatureSchema.js';
import { JOINT_LABELS, mirrorGroupLabel } from '../core/JointSchema.js';
import { ControlPanel } from './controls.js';

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
    this.panel = new ControlPanel(container, { onChange: () => store.commit() });

    // --- Valeurs relatives, lecture seule, mises à jour par setFeatures().
    const featuresSection = this.panel.section('Valeurs relatives');
    this.featureReadouts = [];
    for (const group of FEATURE_GROUPS) {
      const section = featuresSection.section(group.title, { open: !group.title.startsWith('Doigts') });
      for (const { key, label, unit } of group.features) {
        this.featureReadouts.push({ readout: section.readout(label), key, unit });
      }
    }

    // --- Retargeting : inversion de côté, puis inversion / amplification
    // par axe pour chaque groupe (paires miroir fusionnées).
    const retarget = this.panel.section('Retargeting');
    const r = settings.retarget;
    const sides = retarget.section('Inversion de côté');
    sides.toggle(r.sideInversion, 'arms', { label: 'Bras' });
    sides.toggle(r.sideInversion, 'hands', { label: 'Mains' });
    sides.toggle(r.sideInversion, 'legs', { label: 'Jambes' });

    const groups = retarget.section('Par articulation', { open: false });
    const bodyGroups = groups.section('Corps et visage', { open: false });
    const fingerGroups = groups.section('Doigts', { open: false });
    for (const groupKey of Object.keys(r.axisInvert)) {
      const parent = /Thumb|Index|Middle|Ring|Little/.test(groupKey) ? fingerGroups : bodyGroups;
      const section = parent.section(mirrorGroupLabel(groupKey), { open: false });
      for (const axis of AXES) {
        section.toggle(r.axisInvert[groupKey], axis, { label: `Inverser ${axis.toUpperCase()}` });
      }
      for (const axis of AXES) {
        section.slider(r.amplification[groupKey], axis, {
          label: `Amplification ${axis.toUpperCase()}`,
          min: 0,
          max: 3,
          step: 0.05,
        });
      }
    }

    // --- Déplacement du bassin à partir de sa position à l'écran (latéral)
    // et de la hauteur des épaules (vertical, une fois le corps calibré).
    const motion = this.panel.section('Mouvement', { open: false });
    motion.slider(settings.motion, 'lateralRange', { label: 'Amplitude latérale', min: 0, max: 3, step: 0.05, unit: 'm' });
    motion.slider(settings.motion, 'verticalRange', { label: 'Amplitude verticale', min: 0, max: 3, step: 0.05, unit: 'm' });

    // --- Butées par articulation (JointConstraints), affichées en degrés.
    const limits = this.panel.section('Butées', { open: false });
    for (const [joint, axes] of Object.entries(settings.constraints)) {
      const section = limits.section(JOINT_LABELS[joint] ?? joint, { open: false });
      for (const [axis, range] of Object.entries(axes)) {
        section.angle(range, 0, { label: `${axis.toUpperCase()} min` });
        section.angle(range, 1, { label: `${axis.toUpperCase()} max` });
      }
    }

    // --- Collision avec le torse.
    const collision = this.panel.section('Collision', { open: false });
    collision.slider(settings.collision, 'torsoRadius', {
      label: 'Rayon du torse',
      min: 0.05,
      max: 0.3,
      step: 0.005,
      unit: 'm',
    });

    // --- Transform du modèle.
    const model = this.panel.section('Modèle', { open: false });
    for (const axis of AXES) {
      model.slider(settings.model.position, axis, {
        label: `Position ${axis.toUpperCase()}`,
        min: -2,
        max: 2,
        step: 0.01,
        unit: 'm',
      });
    }
    model.angle(settings.model, 'rotationY', { label: 'Rotation Y' });
    model.slider(settings.model, 'scale', { label: 'Échelle', min: 0.1, max: 3, step: 0.01 });
  }

  // `features` : { [clé]: valeur } (voir FeatureSchema). Seules les sections
  // ouvertes touchent le DOM, l'appel peut donc être fait à chaque frame.
  setFeatures(features) {
    for (const { readout, key, unit } of this.featureReadouts) {
      readout.set(formatFeature(features?.[key], unit));
    }
  }

  refresh() {
    this.panel.refresh();
  }
}
