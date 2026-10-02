import { BODY_JOINTS, JOINT_LABELS } from '../core/JointSchema.js';
import { ControlPanel, pendingBadge } from './controls.js';

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
    for (const joint of BODY_JOINTS) {
      this.select.add(new Option(JOINT_LABELS[joint] ?? joint, joint));
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
    if (!BODY_JOINTS.includes(joint)) return;
    this.selected = joint;
    this.select.value = joint;
    this.#build();
  }

  #build() {
    this.body.replaceChildren();
    const joint = this.store.data.joints[this.selected];
    this.panel = new ControlPanel(this.body, { onChange: () => this.store.commit() });

    // Deux colonnes : offsets à gauche, ressort à droite.
    const offsets = this.panel.section('Offsets');
    offsets.angle(joint.offset, 'x', { label: 'X' });
    offsets.angle(joint.offset, 'y', { label: 'Y' });
    offsets.angle(joint.offset, 'z', { label: 'Z' });

    const spring = this.panel.section('Retour à la KeyPose', { badge: pendingBadge(6) });
    spring.slider(joint, 'stiffness', { label: 'Raideur', min: 0, max: 500, step: 1 });
    spring.slider(joint, 'damping', { label: 'Amortissement', min: 0, max: 60, step: 0.5 });
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
  }
}
