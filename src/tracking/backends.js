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

// Exécution sur une machine distante (serveur Python + MediaPipe, WebRTC) :
// prévue en phase 7. En attendant, le backend signale qu'il n'est pas
// disponible plutôt que de faire échouer toute la détection.
export class RemoteBackend {
  constructor(kind) {
    this.kind = kind;
    this.busy = false;
    this.delegate = 'distant';
    this.onResult = null;
    this.onError = null;
    this.ready = Promise.reject(new Error('exécution distante pas encore disponible (phase 7)'));
    this.ready.catch(() => {});
  }

  send(frame) {
    frame.close();
  }

  dispose() {}
}
