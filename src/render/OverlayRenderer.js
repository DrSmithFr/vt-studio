import { FaceLandmarker, HandLandmarker, PoseLandmarker } from '@mediapipe/tasks-vision';

const POSE_CONNECTIONS = PoseLandmarker.POSE_CONNECTIONS;
const HAND_CONNECTIONS = HandLandmarker.HAND_CONNECTIONS;
const FACE_CONNECTIONS = FaceLandmarker.FACE_LANDMARKS_CONTOURS;

// Indices des poignets de pose, pour placer les étiquettes G/D.
const POSE_WRIST = { left: 15, right: 16 };

// Sous ce seuil de visibilité, un landmark de pose n'est pas dessiné
// (articulation hors champ ou masquée).
const MIN_VISIBILITY = 0.5;

// Couche brute : traits fins et discrets. Couche lissée : couleurs par partie.
const STYLES = {
  raw: {
    lineWidth: 1,
    pointRadius: 1.5,
    colors: { pose: 'rgba(255,255,255,0.45)', face: 'rgba(255,255,255,0.3)', left: 'rgba(255,255,255,0.45)', right: 'rgba(255,255,255,0.45)' },
  },
  smoothed: {
    lineWidth: 2,
    pointRadius: 2.5,
    colors: { pose: '#8f8fff', face: '#5fd3c4', left: '#f2a65a', right: '#e870a8' },
  },
};

// Dessin 2D des détections sur #overlay-canvas, aligné sur la vidéo telle
// qu'elle est affichée (object-fit: contain, miroir éventuel).
export class OverlayRenderer {
  constructor(canvas) {
    this.canvas = canvas;
    this.ctx = canvas.getContext('2d');
  }

  clear() {
    this.ctx.clearRect(0, 0, this.canvas.width, this.canvas.height);
  }

  // `raw` / `smoothed` : détections au format commun (voir
  // tracking/detectors.js). `layers` : réglages de visibilité.
  draw({ raw, smoothed, layers, mirror, videoSize }) {
    const { canvas, ctx } = this;
    const dpr = window.devicePixelRatio || 1;
    const width = Math.round(canvas.clientWidth * dpr);
    const height = Math.round(canvas.clientHeight * dpr);
    if (canvas.width !== width || canvas.height !== height) {
      canvas.width = width;
      canvas.height = height;
    }
    ctx.clearRect(0, 0, width, height);
    if (!videoSize?.width || !videoSize?.height) return;

    // Rectangle occupé par la vidéo dans le canvas (object-fit: contain).
    const scale = Math.min(width / videoSize.width, height / videoSize.height);
    const rect = {
      w: videoSize.width * scale,
      h: videoSize.height * scale,
    };
    rect.x = (width - rect.w) / 2;
    rect.y = (height - rect.h) / 2;
    const project = (p) => ({
      x: rect.x + (mirror ? 1 - p.x : p.x) * rect.w,
      y: rect.y + p.y * rect.h,
    });

    if (layers.rawDetections && raw) this.#drawDetection(raw, STYLES.raw, project, dpr, false);
    if (layers.smoothedDetections && smoothed) this.#drawDetection(smoothed, STYLES.smoothed, project, dpr, true);
  }

  #drawDetection(detection, style, project, dpr, withLabels) {
    const { ctx } = this;
    ctx.lineWidth = style.lineWidth * dpr;
    ctx.lineCap = 'round';

    if (detection.face?.screen) {
      this.#drawConnections(detection.face.screen, FACE_CONNECTIONS, style.colors.face, project);
    }

    const pose = detection.pose?.screen;
    if (pose) {
      this.#drawConnections(pose, POSE_CONNECTIONS, style.colors.pose, project, MIN_VISIBILITY);
      this.#drawPoints(pose, style.colors.pose, style.pointRadius * dpr, project, MIN_VISIBILITY);
    }

    for (const side of ['left', 'right']) {
      const hand = detection.hands?.[side]?.screen;
      if (!hand) continue;
      this.#drawConnections(hand, HAND_CONNECTIONS, style.colors[side], project);
      this.#drawPoints(hand, style.colors[side], style.pointRadius * dpr, project);
    }

    // Étiquettes G/D aux poignets : permettent de vérifier d'un coup d'œil
    // que les côtés anatomiques sont correctement attribués.
    if (withLabels) {
      ctx.font = `600 ${11 * dpr}px system-ui, sans-serif`;
      ctx.textAlign = 'center';
      ctx.textBaseline = 'middle';
      for (const side of ['left', 'right']) {
        const anchor = detection.hands?.[side]?.screen?.[0] ?? this.#visible(pose?.[POSE_WRIST[side]]);
        if (!anchor) continue;
        const { x, y } = project(anchor);
        this.#drawLabel(side === 'left' ? 'G' : 'D', x, y - 16 * dpr, style.colors[side], dpr);
      }
    }
  }

  #visible(point) {
    return point && (point.visibility ?? 1) >= MIN_VISIBILITY ? point : null;
  }

  #drawConnections(points, connections, color, project, minVisibility = 0) {
    const { ctx } = this;
    ctx.strokeStyle = color;
    ctx.beginPath();
    for (const { start, end } of connections) {
      const a = points[start];
      const b = points[end];
      if (!a || !b) continue;
      if ((a.visibility ?? 1) < minVisibility || (b.visibility ?? 1) < minVisibility) continue;
      const pa = project(a);
      const pb = project(b);
      ctx.moveTo(pa.x, pa.y);
      ctx.lineTo(pb.x, pb.y);
    }
    ctx.stroke();
  }

  #drawPoints(points, color, radius, project, minVisibility = 0) {
    const { ctx } = this;
    ctx.fillStyle = color;
    ctx.beginPath();
    for (const point of points) {
      if ((point.visibility ?? 1) < minVisibility) continue;
      const { x, y } = project(point);
      ctx.moveTo(x + radius, y);
      ctx.arc(x, y, radius, 0, Math.PI * 2);
    }
    ctx.fill();
  }

  #drawLabel(text, x, y, color, dpr) {
    const { ctx } = this;
    const r = 8 * dpr;
    ctx.fillStyle = 'rgba(14,14,18,0.8)';
    ctx.beginPath();
    ctx.arc(x, y, r, 0, Math.PI * 2);
    ctx.fill();
    ctx.lineWidth = 1.5 * dpr;
    ctx.strokeStyle = color;
    ctx.stroke();
    ctx.fillStyle = color;
    ctx.fillText(text, x, y + 0.5 * dpr);
  }
}
