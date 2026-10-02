// Connexion WebRTC au serveur de détection distant (server/vt_server.py),
// partagée par tous les détecteurs distants qui visent la même adresse :
// un seul flux vidéo, un DataChannel de contrôle (fiable) pour la
// configuration et un DataChannel de résultats (non fiable, non ordonné :
// un résultat en retard est perdu plutôt que de retarder les suivants).

// Débit max de la vidéo envoyée : assez pour une détection fiable en 720p
// sur un réseau local, sans saturer le Wi-Fi.
const MAX_BITRATE = 4_000_000;
const ICE_GATHERING_TIMEOUT_MS = 2000;

const sessions = new Map(); // url → RemoteSession

export class RemoteSession {
  // Session partagée pour une adresse (créée au premier détecteur).
  static acquire(url, getStream) {
    const key = url.replace(/\/+$/, '');
    let session = sessions.get(key);
    if (!session) {
      session = new RemoteSession(key, getStream);
      sessions.set(key, session);
    }
    return session;
  }

  constructor(url, getStream) {
    this.url = url;
    this.getStream = getStream;
    this.detectors = new Map(); // id → { kind, fps, options, onMessage }
    this.pc = null;
    this.control = null;
    this.connecting = null;
    this.closed = false;
  }

  // Inscrit un détecteur ; `onMessage` reçoit ses messages (ready, result,
  // error). Ouvre la connexion au besoin, sinon renvoie la configuration.
  register(id, spec, onMessage) {
    this.detectors.set(id, { ...spec, onMessage });
    this.#connect().then(
      () => this.#sendConfiguration(),
      (error) => onMessage({ type: 'error', message: error.message }),
    );
  }

  setFps(id, fps) {
    const detector = this.detectors.get(id);
    if (!detector || detector.fps === fps) return;
    detector.fps = fps;
    this.#sendConfiguration();
  }

  unregister(id) {
    this.detectors.delete(id);
    if (this.detectors.size === 0) {
      this.close();
    } else {
      this.#sendConfiguration();
    }
  }

  close() {
    this.closed = true;
    sessions.delete(this.url);
    this.pc?.close();
  }

  #sendConfiguration() {
    if (this.control?.readyState !== 'open') return;
    const detectors = [...this.detectors].map(([id, { kind, fps, options }]) => ({ id, kind, fps, options }));
    this.control.send(JSON.stringify({ type: 'configure', detectors }));
  }

  #broadcast(message) {
    for (const detector of this.detectors.values()) detector.onMessage(message);
  }

  #connect() {
    this.connecting ??= this.#open().catch((error) => {
      // Échec : la prochaine inscription retentera une connexion neuve.
      sessions.delete(this.url);
      throw error;
    });
    return this.connecting;
  }

  async #open() {
    const stream = this.getStream();
    const track = stream?.getVideoTracks()[0];
    if (!track) throw new Error('webcam indisponible pour le flux distant');

    // Réseau local / VPN : pas de STUN/TURN.
    const pc = new RTCPeerConnection({ iceServers: [] });
    this.pc = pc;
    const sender = pc.addTrack(track, stream);
    this.control = pc.createDataChannel('control');
    const results = pc.createDataChannel('detections', { ordered: false, maxRetransmits: 0 });

    results.onmessage = ({ data }) => {
      const message = JSON.parse(data);
      this.detectors.get(message.id)?.onMessage(message);
    };
    pc.onconnectionstatechange = () => {
      if (['failed', 'disconnected'].includes(pc.connectionState) && !this.closed) {
        this.#broadcast({ type: 'error', message: `connexion distante ${pc.connectionState}` });
      }
    };

    // Signalisation : offre complète (candidats ICE inclus) en une requête.
    await pc.setLocalDescription(await pc.createOffer());
    await waitForIceGathering(pc);
    let response;
    try {
      response = await fetch(`${this.url}/offer`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ sdp: pc.localDescription.sdp, type: pc.localDescription.type }),
      });
    } catch {
      throw new Error(
        `serveur injoignable (${this.url}) : vérifier l'adresse, qu'il est lancé en HTTPS ` +
          'et que son certificat a été accepté (ouvrir son adresse une fois dans le navigateur)',
      );
    }
    if (!response.ok) throw new Error(`serveur distant : HTTP ${response.status}`);
    await pc.setRemoteDescription(await response.json());

    // Priorité à la fluidité plutôt qu'à la définition.
    const parameters = sender.getParameters();
    parameters.degradationPreference = 'maintain-framerate';
    if (parameters.encodings?.[0]) parameters.encodings[0].maxBitrate = MAX_BITRATE;
    await sender.setParameters(parameters).catch(() => {});

    await new Promise((resolve, reject) => {
      if (this.control.readyState === 'open') return resolve();
      this.control.onopen = () => resolve();
      this.control.onerror = () => reject(new Error('canal de contrôle distant fermé'));
    });
  }
}

function waitForIceGathering(pc) {
  if (pc.iceGatheringState === 'complete') return Promise.resolve();
  return new Promise((resolve) => {
    const timer = setTimeout(resolve, ICE_GATHERING_TIMEOUT_MS);
    pc.addEventListener('icegatheringstatechange', () => {
      if (pc.iceGatheringState === 'complete') {
        clearTimeout(timer);
        resolve();
      }
    });
  });
}
