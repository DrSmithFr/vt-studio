import * as THREE from 'three';
import { GLTFLoader } from 'three/examples/jsm/loaders/GLTFLoader.js';
import { VRMLoaderPlugin, VRMUtils } from '@pixiv/three-vrm';
import { FINGERS, ROTATION_JOINTS, fingerBone } from '../core/JointSchema.js';

// Les noms d'articulation (JointSchema.js) sont ceux des os humanoïdes VRM
// 1.0 (corps et doigts) : le mapping est l'identité.
const JOINT_TO_VRM_BONE = Object.fromEntries(ROTATION_JOINTS.map((name) => [name, name]));

const _quaternion = new THREE.Quaternion();
const _euler = new THREE.Euler();

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
    // Les rotations sont calculées dans le repère VRM 1.0 (avatar tourné
    // vers +Z). Un modèle VRM 0.x a son repère local tourné de π autour de
    // Y : ses rotations et déplacements sont convertis (x et z inversés).
    this.isVrm0 = vrm.meta?.metaVersion === '0';
    this.hipsRestPosition = vrm.humanoid?.getNormalizedBoneNode('hips')?.position.clone() ?? null;
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

  setVisible(visible) {
    if (this.vrm) this.vrm.scene.visible = visible;
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

  // Données de repos du modèle utiles à la reconstruction (KeyPoseBuilder),
  // dans le repère VRM 1.0 : direction de chaque phalange et proportion
  // bras / (bras + avant-bras). Le squelette normalisé est en T-pose avec des
  // rotations nulles : la position d'un os enfant est directement la
  // direction de son parent.
  getRestInfo() {
    const humanoid = this.vrm?.humanoid;
    if (!humanoid) return null;
    const node = (name) => humanoid.getNormalizedBoneNode(name);
    const toVrm1 = (v) => (this.isVrm0 ? new THREE.Vector3(-v.x, v.y, -v.z) : v.clone());

    const fingerDirections = {};
    for (const side of ['left', 'right']) {
      for (const finger of FINGERS) {
        let previous = null;
        for (let i = 0; i < 3; i++) {
          const child = i < 2 ? node(fingerBone(side, finger, i + 1)) : null;
          // Dernière phalange (pas d'os enfant) : même direction que la
          // précédente.
          const direction = child && child.position.lengthSq() > 0 ? toVrm1(child.position).normalize() : previous;
          if (direction) fingerDirections[fingerBone(side, finger, i)] = direction;
          previous = direction;
        }
      }
    }

    const upperArmRatio = {};
    for (const side of ['left', 'right']) {
      const upper = node(`${side}LowerArm`)?.position.length();
      const lower = node(`${side}Hand`)?.position.length();
      if (upper && lower) upperArmRatio[side] = upper / (upper + lower);
    }
    return { fingerDirections, upperArmRatio };
  }

  // Applique la pose de sortie (lissée, retargetée) au modèle VRM : rotations
  // d'os humanoïdes, déplacement du bassin, puis expressions faciales.
  applyPose(outputPose, hipsOffset = null) {
    if (!this.vrm?.humanoid) return;

    for (const [jointName, boneName] of Object.entries(JOINT_TO_VRM_BONE)) {
      const rotation = outputPose[jointName];
      if (!rotation) continue;
      const node = this.vrm.humanoid.getNormalizedBoneNode(boneName);
      if (!node) continue;
      node.quaternion.copy(this.toModelQuaternion(rotation));
    }

    const hips = this.vrm.humanoid.getNormalizedBoneNode('hips');
    if (hips && this.hipsRestPosition && hipsOffset) {
      const sign = this.isVrm0 ? -1 : 1;
      hips.position.set(
        this.hipsRestPosition.x + sign * hipsOffset.x,
        this.hipsRestPosition.y + hipsOffset.y,
        this.hipsRestPosition.z + sign * hipsOffset.z,
      );
    }

    const expressionManager = this.vrm.expressionManager;
    if (!expressionManager) return;
    for (const [channelName, expressionName] of Object.entries(FACE_CHANNEL_TO_EXPRESSION)) {
      const channel = outputPose[channelName];
      if (!channel || channel.x === undefined) continue;
      expressionManager.setValue(expressionName, channel.x);
    }
  }

  // Rotation Euler XYZ (repère VRM 1.0) → quaternion dans le repère local du
  // modèle chargé (conjugaison par une rotation de π autour de Y pour un
  // VRM 0.x : x et z inversés).
  toModelQuaternion(rotation) {
    _quaternion.setFromEuler(_euler.set(rotation.x, rotation.y, rotation.z, 'XYZ'));
    if (this.isVrm0) {
      _quaternion.x = -_quaternion.x;
      _quaternion.z = -_quaternion.z;
    }
    return _quaternion;
  }

  // Remet tous les os en pose de repos (T-pose normalisée) et les
  // expressions à zéro, ex. quand la détection est désactivée.
  resetPose() {
    if (!this.vrm) return;
    this.vrm.humanoid?.resetNormalizedPose();
    this.vrm.expressionManager?.resetValues();
  }

  update(deltaSeconds) {
    this.vrm?.update(deltaSeconds);
  }
}
