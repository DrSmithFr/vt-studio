import { BODY_JOINTS, JOINT_LABELS } from '../core/JointSchema.js';
import { addAngle, createEmbeddedGui, markPending, refreshGui } from './guiHelpers.js';

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
    this.select.addEventListener('change', () => {
      this.selected = this.select.value;
      this.#build();
    });
    const resetButton = document.createElement('button');
    resetButton.textContent = 'Réinitialiser';
    resetButton.title = "Remet les offsets et le ressort de cette articulation à leurs valeurs par défaut";
    resetButton.addEventListener('click', () => this.#resetSelected());
    header.append(title, this.select, resetButton);

    this.body = document.createElement('div');
    this.body.className = 'joint-dock-body';
    container.append(header, this.body);

    this.#build();
  }

  // Sélectionne une articulation depuis l'extérieur (ex. clic sur le modèle).
  selectJoint(joint) {
    if (!BODY_JOINTS.includes(joint)) return;
    this.selected = joint;
    this.select.value = joint;
    this.#build();
  }

  #build() {
    this.gui?.destroy();
    const joint = this.store.data.joints[this.selected];
    this.gui = createEmbeddedGui(this.body, JOINT_LABELS[this.selected], () => this.store.commit());

    const offsets = this.gui.addFolder('Offsets');
    addAngle(offsets, joint.offset, 'x', 'X');
    addAngle(offsets, joint.offset, 'y', 'Y');
    addAngle(offsets, joint.offset, 'z', 'Z');

    const spring = this.gui.addFolder('Retour à la KeyPose');
    spring.add(joint, 'stiffness', 0, 500, 1).name('Raideur');
    spring.add(joint, 'damping', 0, 60, 0.5).name('Amortissement');
    markPending(spring, 6);
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
    refreshGui(this.gui);
  }
}
