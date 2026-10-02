import { BODY_JOINTS, FINGER_JOINTS, JOINT_LABELS, ROTATION_JOINTS } from '../core/JointSchema.js';
import { ControlPanel } from './controls.js';

// Caractéristiques d'un ressort (raideur k, amortissement c) pour
// l'affichage : taux d'amortissement ζ = c / (2√k), temps pour atteindre
// 90 % d'un échelon et dépassement, par simulation 1D (même intégration que
// SpringFollower).
function describeSpring(k, c) {
  if (k <= 0) return 'immédiat (pas de ressort)';
  const zeta = c / (2 * Math.sqrt(k));
  const h = 1 / 1000;
  let x = 0;
  let v = 0;
  let t90 = null;
  let peak = 0;
  for (let i = 1; i <= 3000; i++) {
    v = (v + k * (1 - x) * h) / (1 + c * h);
    x += v * h;
    peak = Math.max(peak, x);
    if (t90 === null && x >= 0.9) t90 = i;
  }
  const response = t90 === null ? '> 3 s' : `${t90} ms`;
  const overshoot = peak > 1.005 ? ` · rebond ${((peak - 1) * 100).toFixed(0)} %` : '';
  return `ζ ${zeta.toFixed(2)} · 90 % en ${response}${overshoot}`;
}

// Groupe d'une articulation pour « Appliquer au groupe » : doigts de la même
// main, ou corps.
function jointGroup(joint) {
  if (FINGER_JOINTS.includes(joint)) {
    const side = joint.startsWith('left') ? 'left' : 'right';
    return FINGER_JOINTS.filter((j) => j.startsWith(side));
  }
  return BODY_JOINTS;
}

// Menu flottant en bas de la vue : pour l'articulation choisie, offsets
// (ajoutés à la KeyPose) et paramètres du ressort qui ramène l'os du modèle
// vers la KeyPose.
export class JointDock {
  constructor(container, store) {
    this.store = store;
    this.selected = BODY_JOINTS[0];

    container.classList.add('joint-dock');

    const header = document.createElement('div');
    header.className = 'joint-dock-header';
    const title = document.createElement('span');
    title.textContent = 'Articulation';
    this.select = document.createElement('select');
    const groups = [
      ['Corps', BODY_JOINTS],
      ['Doigts G', FINGER_JOINTS.filter((j) => j.startsWith('left'))],
      ['Doigts D', FINGER_JOINTS.filter((j) => j.startsWith('right'))],
    ];
    for (const [label, joints] of groups) {
      const group = document.createElement('optgroup');
      group.label = label;
      for (const joint of joints) group.append(new Option(JOINT_LABELS[joint] ?? joint, joint));
      this.select.append(group);
    }
    this.select.addEventListener('change', () => this.selectJoint(this.select.value));
    const resetButton = document.createElement('button');
    resetButton.textContent = 'Réinitialiser';
    resetButton.title = 'Remet les offsets et le ressort de cette articulation à leurs valeurs par défaut';
    resetButton.addEventListener('click', () => this.#resetSelected());
    const collapseButton = document.createElement('button');
    collapseButton.className = 'joint-dock-collapse';
    collapseButton.title = 'Replier / déplier';
    collapseButton.addEventListener('click', () => container.classList.toggle('collapsed'));
    header.append(title, this.select, resetButton, collapseButton);

    this.body = document.createElement('div');
    this.body.className = 'joint-dock-body';
    container.append(header, this.body);

    this.#build();
  }

  // Sélectionne une articulation (liste déroulante, ou plus tard clic sur le
  // modèle).
  selectJoint(joint) {
    if (!ROTATION_JOINTS.includes(joint)) return;
    this.selected = joint;
    this.select.value = joint;
    this.#build();
  }

  #build() {
    this.body.replaceChildren();
    const joint = this.store.data.joints[this.selected];
    this.panel = new ControlPanel(this.body, {
      onChange: () => {
        this.#describe(joint);
        this.store.commit();
      },
    });

    // Deux colonnes : offsets à gauche, ressort à droite.
    const offsets = this.panel.section('Offsets');
    offsets.angle(joint.offset, 'x', { label: 'X' });
    offsets.angle(joint.offset, 'y', { label: 'Y' });
    offsets.angle(joint.offset, 'z', { label: 'Z' });

    const spring = this.panel.section('Retour à la KeyPose');
    spring.slider(joint, 'stiffness', { label: 'Raideur', min: 0, max: 1000, step: 5 });
    spring.slider(joint, 'damping', { label: 'Amortissement', min: 0, max: 100, step: 0.5 });
    this.springReadout = spring.readout('Réponse');
    const group = FINGER_JOINTS.includes(this.selected) ? 'doigts de cette main' : 'corps';
    spring
      .button(`Appliquer au groupe (${group})`, () => this.#applyToGroup(joint))
      .tooltip("Copie la raideur et l'amortissement sur toutes les articulations du groupe");
    this.#describe(joint);
  }

  #describe(joint) {
    this.springReadout.set(describeSpring(joint.stiffness, joint.damping));
  }

  #applyToGroup(joint) {
    for (const name of jointGroup(this.selected)) {
      // Le bassin garde son propre réglage (il règle aussi son déplacement).
      if (name === 'hips' && this.selected !== 'hips') continue;
      this.store.data.joints[name].stiffness = joint.stiffness;
      this.store.data.joints[name].damping = joint.damping;
    }
    this.store.commit();
  }

  #resetSelected() {
    const defaults = this.store.defaults.joints[this.selected];
    const joint = this.store.data.joints[this.selected];
    Object.assign(joint.offset, defaults.offset);
    joint.stiffness = defaults.stiffness;
    joint.damping = defaults.damping;
    this.refresh();
    this.store.commit();
  }

  refresh() {
    this.panel.refresh();
    this.#describe(this.store.data.joints[this.selected]);
  }
}
