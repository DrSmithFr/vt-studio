import * as THREE from 'three';
import { GLTFLoader } from 'three/examples/jsm/loaders/GLTFLoader.js';
import { VRMLoaderPlugin, VRMUtils } from '@pixiv/three-vrm';

// Les noms d'articulation du squelette global (JointSchema.js) sont choisis
// pour correspondre directement aux noms d'os humanoïdes VRM : le mapping
// est donc l'identité pour la quasi-totalité des articulations.
const JOINT_TO_VRM_BONE = {
  hips: 'hips',
  spine: 'spine',
  chest: 'chest',
  neck: 'neck',
  head: 'head',
  leftShoulder: 'leftShoulder',
  rightShoulder: 'rightShoulder',
  leftUpperArm: 'leftUpperArm',
  rightUpperArm: 'rightUpperArm',
  leftLowerArm: 'leftLowerArm',
  rightLowerArm: 'rightLowerArm',
  leftHand: 'leftHand',
  rightHand: 'rightHand',
  leftUpperLeg: 'leftUpperLeg',
  rightUpperLeg: 'rightUpperLeg',
  leftLowerLeg: 'leftLowerLeg',
  rightLowerLeg: 'rightLowerLeg',
  leftFoot: 'leftFoot',
  rightFoot: 'rightFoot',
};

// Canaux de visage sans expression VRM standard équivalente (browRaise n'a
// pas de préréglage VRM 1.0). Extension possible via une expression
// personnalisée définie dans le modèle.
const FACE_CHANNEL_TO_EXPRESSION = {
  leftEyeBlink: 'blinkLeft',
  rightEyeBlink: 'blinkRight',
  mouthOpen: 'aa',
  mouthWide: 'ih',
};

export class VrmController {
  constructor(scene) {
    this.scene = scene;
    this.vrm = null;
    // Lacet de base imposé par le format : les modèles VRM 0.x regardent
    // vers -Z et sont retournés de π par VRMUtils.rotateVRM0. La rotation
    // réglée dans le panneau s'ajoute à cette base au lieu de l'écraser.
    this.baseYaw = 0;
    this.loader = new GLTFLoader();
    this.loader.register((parser) => new VRMLoaderPlugin(parser));
  }

  async loadFromUrl(url) {
    this.unload();

    const gltf = await this.loader.loadAsync(url);
    const vrm = gltf.userData.vrm;
    VRMUtils.removeUnnecessaryVertices(gltf.scene);
    VRMUtils.combineSkeletons(gltf.scene);
    VRMUtils.rotateVRM0(vrm);

    this.vrm = vrm;
    this.baseYaw = vrm.scene.rotation.y;
    this.scene.add(vrm.scene);
    return vrm;
  }

  // Charge un fichier .vrm choisi par l'utilisateur (<input type="file"> ou
  // glisser-déposer). L'URL objet n'est utile que le temps du chargement.
  async loadFromFile(file) {
    const url = URL.createObjectURL(file);
    try {
      return await this.loadFromUrl(url);
    } finally {
      URL.revokeObjectURL(url);
    }
  }

  unload() {
    if (!this.vrm) return;
    this.scene.remove(this.vrm.scene);
    VRMUtils.deepDispose(this.vrm.scene);
    this.vrm = null;
  }

  // Version du format du modèle chargé ('0' ou '1'), pour l'affichage.
  get metaVersion() {
    return this.vrm?.meta?.metaVersion ?? null;
  }

  // Position/rotation/échelle du modèle dans la scène (réglable dans le
  // panneau de débogage : le modèle n'est pas forcément centré à l'origine).
  setTransform({ position, rotationY, scale }) {
    if (!this.vrm) return;
    const root = this.vrm.scene;
    if (position) root.position.set(position.x, position.y, position.z);
    if (rotationY !== undefined) root.rotation.y = this.baseYaw + rotationY;
    if (scale !== undefined) root.scale.setScalar(scale);
  }

  // Applique le squelette global (déjà lissé et retargeté) au modèle VRM :
  // rotations d'os humanoïdes puis expressions faciales.
  applyPose(outputPose) {
    if (!this.vrm?.humanoid) return;

    for (const [jointName, boneName] of Object.entries(JOINT_TO_VRM_BONE)) {
      const rotation = outputPose[jointName];
      if (!rotation) continue;
      const node = this.vrm.humanoid.getNormalizedBoneNode(boneName);
      if (!node) continue;
      node.rotation.set(rotation.x, rotation.y, rotation.z);
    }

    const expressionManager = this.vrm.expressionManager;
    if (!expressionManager) return;
    for (const [channelName, expressionName] of Object.entries(FACE_CHANNEL_TO_EXPRESSION)) {
      const channel = outputPose[channelName];
      if (!channel || channel.x === undefined) continue;
      expressionManager.setValue(expressionName, channel.x);
    }
  }

  update(deltaSeconds) {
    this.vrm?.update(deltaSeconds);
  }
}
