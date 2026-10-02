import * as THREE from 'three';

export class SceneManager {
  constructor(canvas) {
    this.canvas = canvas;
    this.scene = new THREE.Scene();
    this.scene.background = new THREE.Color(0x1a1a20);

    this.camera = new THREE.PerspectiveCamera(30, 1, 0.1, 20);
    this.camera.position.set(0, 1.3, 3);
    this.camera.lookAt(0, 1.1, 0);

    this.renderer = new THREE.WebGLRenderer({ canvas, antialias: true, alpha: true });
    this.renderer.setPixelRatio(window.devicePixelRatio);

    const key = new THREE.DirectionalLight(0xffffff, 1.4);
    key.position.set(1, 2, 2);
    this.scene.add(key);
    this.scene.add(new THREE.AmbientLight(0xffffff, 0.6));

    this.#resize();
    window.addEventListener('resize', () => this.#resize());
  }

  #resize() {
    const { clientWidth, clientHeight } = this.canvas;
    this.camera.aspect = clientWidth / clientHeight;
    this.camera.updateProjectionMatrix();
    this.renderer.setSize(clientWidth, clientHeight, false);
  }

  render() {
    this.renderer.render(this.scene, this.camera);
  }
}
