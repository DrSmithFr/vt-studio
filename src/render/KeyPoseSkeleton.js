import * as THREE from 'three';

const COLOR = 0x8f8fff;

// Squelette dupliqué du modèle, piloté par la KeyPose (cible), affiché en
// surimpression (couche « Squelette KeyPose »). Le modèle visible, lui, suit
// cette cible avec son propre lissage (ressort amorti en phase 6) : l'écart
// entre les deux montre ce que le suivi ajoute.
//
// La copie reprend la hiérarchie et les positions de repos des os normalisés
// du modèle, sous le même parent (vrm.scene) : transform du modèle et
// conversion VRM 0.x s'appliquent de la même façon qu'au modèle.
export class KeyPoseSkeleton {
  constructor(scene) {
    this.scene = scene;
    this.root = null;
    this.bones = new Map(); // nom → Object3D copie
    this.links = []; // [enfant, parent] pour le tracé

    const geometry = new THREE.BufferGeometry();
    this.lines = new THREE.LineSegments(
      geometry,
      new THREE.LineBasicMaterial({ color: COLOR, depthTest: false, transparent: true, opacity: 0.9 }),
    );
    this.points = new THREE.Points(
      geometry,
      new THREE.PointsMaterial({ color: COLOR, size: 5, sizeAttenuation: false, depthTest: false }),
    );
    // Toujours au premier plan, par-dessus le modèle.
    this.lines.renderOrder = 999;
    this.points.renderOrder = 1000;
    this.lines.frustumCulled = false;
    this.points.frustumCulled = false;
    this.lines.visible = false;
    this.points.visible = false;
    scene.add(this.lines, this.points);
  }

  // À appeler après chaque chargement de modèle.
  attach(vrmController) {
    this.detach();
    const vrm = vrmController.vrm;
    const humanoid = vrm?.humanoid;
    if (!humanoid) return;
    this.vrmController = vrmController;

    // Correspondance nœud normalisé → nom d'os, pour retrouver les parents.
    const names = new Map();
    for (const name of Object.keys(humanoid.humanBones)) {
      const node = humanoid.getNormalizedBoneNode(name);
      if (node) names.set(node, name);
    }

    this.root = new THREE.Group();
    vrm.scene.add(this.root);
    vrm.scene.updateMatrixWorld(true);

    // Création dans l'ordre de la hiérarchie (parents d'abord).
    const hipsNode = humanoid.getNormalizedBoneNode('hips');
    hipsNode.traverse((node) => {
      const name = names.get(node);
      if (!name) return;
      let ancestor = node.parent;
      while (ancestor && !names.has(ancestor)) ancestor = ancestor.parent;
      const parentName = ancestor ? names.get(ancestor) : null;

      const copy = new THREE.Object3D();
      if (parentName && this.bones.has(parentName)) {
        // Rotations nulles au repos : la position relative au parent est la
        // différence des positions dans la scène du modèle.
        const position = node.getWorldPosition(new THREE.Vector3());
        const parentPosition = ancestor.getWorldPosition(new THREE.Vector3());
        vrm.scene.worldToLocal(position);
        vrm.scene.worldToLocal(parentPosition);
        copy.position.copy(position.sub(parentPosition));
        this.bones.get(parentName).add(copy);
        this.links.push([name, parentName]);
      } else {
        copy.position.copy(vrm.scene.worldToLocal(node.getWorldPosition(new THREE.Vector3())));
        this.root.add(copy);
      }
      this.bones.set(name, copy);
    });
    this.hipsRest = this.bones.get('hips')?.position.clone() ?? null;

    const positions = new Float32Array(this.links.length * 2 * 3);
    this.lines.geometry.setAttribute('position', new THREE.BufferAttribute(positions, 3));
  }

  detach() {
    if (this.root) this.root.removeFromParent();
    this.root = null;
    this.bones.clear();
    this.links = [];
  }

  // `pose` : rotations (repère VRM 1.0) ; `hipsOffset` : déplacement du bassin.
  update(pose, hipsOffset, visible) {
    const show = visible && this.root !== null;
    this.lines.visible = show;
    this.points.visible = show;
    if (!show) return;

    for (const [name, bone] of this.bones) {
      const rotation = pose[name];
      if (rotation) bone.quaternion.copy(this.vrmController.toModelQuaternion(rotation));
    }
    const hips = this.bones.get('hips');
    if (hips && this.hipsRest && hipsOffset) {
      const sign = this.vrmController.isVrm0 ? -1 : 1;
      hips.position.set(
        this.hipsRest.x + sign * hipsOffset.x,
        this.hipsRest.y + hipsOffset.y,
        this.hipsRest.z + sign * hipsOffset.z,
      );
    }
    this.root.updateMatrixWorld(true);

    const attribute = this.lines.geometry.getAttribute('position');
    const point = new THREE.Vector3();
    this.links.forEach(([child, parent], i) => {
      this.bones.get(child).getWorldPosition(point);
      attribute.setXYZ(i * 2, point.x, point.y, point.z);
      this.bones.get(parent).getWorldPosition(point);
      attribute.setXYZ(i * 2 + 1, point.x, point.y, point.z);
    });
    attribute.needsUpdate = true;
  }
}
