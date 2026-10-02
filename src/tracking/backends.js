import { RemoteSession } from './RemoteSession.js';

// Backends d'exécution d'un détecteur. Interface commune :
//   ready      : Promise résolue quand le détecteur accepte des frames
//   busy       : true entre l'envoi d'une frame et la réception du résultat
//   delegate   : 'GPU' | 'CPU' | 'distant' (affichage)
//   send(frame: ImageBitmap, timestamp)  — la frame est cédée au backend
//   onResult({ timestamp, parts, inferenceMs }) / onError(message)
//   dispose()

export class WorkerBackend {
  constructor(kind, options) {
    this.kind = kind;
    this.busy = false;
    this.delegate = null;
    this.onResult = null;
    this.onError = null;

    this.worker = new Worker(new URL('./detection.worker.js', import.meta.url), { type: 'module' });
    this.ready = new Promise((resolve, reject) => {
      this.worker.onmessage = ({ data }) => {
        switch (data.type) {
          case 'ready':
            this.delegate = data.delegate;
            resolve();
            break;
          case 'delegate':
            this.delegate = data.delegate;
            break;
          case 'result':
            this.busy = false;
            this.onResult?.(data);
            break;
          case 'error':
            // Erreur à l'initialisation ou sur une frame : dans les deux cas
            // le worker est de nouveau disponible.
            this.busy = false;
            reject(new Error(data.message));
            this.onError?.(data.message);
            break;
        }
      };
      this.worker.onerror = (event) => {
        const message = event.message || 'erreur du worker';
        reject(new Error(message));
        this.onError?.(message);
      };
    });
    this.worker.postMessage({ type: 'init', kind, options });
  }

  send(frame, timestamp) {
    this.busy = true;
    this.worker.postMessage({ type: 'frame', frame, timestamp }, [frame]);
  }

  dispose() {
    this.worker.terminate();
  }
}

// Exécution sur une machine distante (server/vt_server.py) : la vidéo part
// en continu par WebRTC (RemoteSession, partagée entre détecteurs distants),
// le serveur cadence lui-même chaque détecteur au FPS demandé. `streaming`
// indique à l'ordonnanceur de ne pas lui envoyer de frames.
export class RemoteBackend {
  constructor(kind, options, { id, url, fps, getStream }) {
    this.kind = kind;
    this.id = id;
    this.busy = false;
    this.streaming = true;
    this.delegate = 'distant';
    this.onResult = null;
    this.onError = null;

    if (!url) {
      this.ready = Promise.reject(new Error('adresse du serveur distant non renseignée'));
      this.ready.catch(() => {});
      return;
    }
    this.session = RemoteSession.acquire(url, getStream);
    this.ready = new Promise((resolve, reject) => {
      this.session.register(id, { kind, fps, options }, (message) => {
        switch (message.type) {
          case 'ready':
            this.delegate = message.delegate;
            resolve();
            break;
          case 'result':
            // Horodatage à la réception : les frames WebRTC ne portent pas
            // l'horloge de la page. Inclut donc la latence réseau.
            this.onResult?.({ timestamp: performance.now(), parts: message.parts, inferenceMs: message.inferenceMs });
            break;
          case 'error':
            reject(new Error(message.message));
            this.onError?.(message.message);
            break;
        }
      });
    });
    this.ready.catch(() => {});
  }

  setFps(fps) {
    this.session?.setFps(this.id, fps);
  }

  send(frame) {
    frame.close();
  }

  dispose() {
    this.session?.unregister(this.id);
  }
}
