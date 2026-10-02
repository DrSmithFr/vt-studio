"""Serveur de détection distant de VTuber Studio.

Reçoit le flux webcam du navigateur par WebRTC, exécute les détecteurs
MediaPipe demandés (Holistic, ou corps / visage / mains en mode Composite)
et renvoie les résultats par DataChannel, au même format commun que le Web
Worker du navigateur (voir src/tracking/detectors.js).

Protocole :
  POST /offer  {sdp, type}              -> {sdp, type}   (signalisation WebRTC)
  DataChannel « control » (fiable), navigateur -> serveur :
    {"type": "configure", "detectors": [{"id", "kind", "fps", "options"}]}
  DataChannel « detections » (non fiable, non ordonné), serveur -> navigateur :
    {"type": "ready", "id", "delegate"}
    {"type": "result", "id", "parts", "inferenceMs"}
    {"type": "error", "id", "message"}

Seule la frame la plus récente est conservée : un détecteur lent saute des
frames au lieu d'accumuler du retard.
"""

from __future__ import annotations

import argparse
import asyncio
import json
import logging
import ssl
import time
import urllib.request
from concurrent.futures import ThreadPoolExecutor
from pathlib import Path

from aiohttp import web
from aiortc import RTCPeerConnection, RTCSessionDescription
from aiortc.mediastreams import MediaStreamError

import mediapipe as mp
from mediapipe.tasks import python as mp_tasks
from mediapipe.tasks.python import vision

log = logging.getLogger("vt-server")

MODELS_BASE = "https://storage.googleapis.com/mediapipe-models"
MODEL_URLS = {
    "holistic": f"{MODELS_BASE}/holistic_landmarker/holistic_landmarker/float16/latest/holistic_landmarker.task",
    "face": f"{MODELS_BASE}/face_landmarker/face_landmarker/float16/1/face_landmarker.task",
    "hand": f"{MODELS_BASE}/hand_landmarker/hand_landmarker/float16/1/hand_landmarker.task",
    "pose_lite": f"{MODELS_BASE}/pose_landmarker/pose_landmarker_lite/float16/1/pose_landmarker_lite.task",
    "pose_full": f"{MODELS_BASE}/pose_landmarker/pose_landmarker_full/float16/1/pose_landmarker_full.task",
    "pose_heavy": f"{MODELS_BASE}/pose_landmarker/pose_landmarker_heavy/float16/1/pose_landmarker_heavy.task",
}

# Précision des coordonnées envoyées : 5 décimales suffisent largement
# (coordonnées normalisées 0-1 ou mètres) et réduisent la taille des messages.
PRECISION = 5


# --- Modèles ----------------------------------------------------------------


def model_path(models_dir: Path, key: str) -> str:
    """Télécharge le modèle au premier usage, puis le réutilise."""
    models_dir.mkdir(parents=True, exist_ok=True)
    path = models_dir / f"{key}.task"
    if not path.exists():
        log.info("Téléchargement du modèle %s…", key)
        tmp = path.with_suffix(".part")
        urllib.request.urlretrieve(MODEL_URLS[key], tmp)
        tmp.rename(path)
    return str(path)


def create_task(kind: str, options: dict, models_dir: Path, use_gpu: bool):
    delegate = mp_tasks.BaseOptions.Delegate.GPU if use_gpu else mp_tasks.BaseOptions.Delegate.CPU

    def base(key):
        return mp_tasks.BaseOptions(model_asset_path=model_path(models_dir, key), delegate=delegate)

    video = vision.RunningMode.VIDEO
    if kind == "holistic":
        if not hasattr(vision, "HolisticLandmarker"):
            raise RuntimeError("HolisticLandmarker indisponible dans cette version de mediapipe (mettre à jour)")
        return vision.HolisticLandmarker.create_from_options(
            vision.HolisticLandmarkerOptions(base_options=base("holistic"), running_mode=video, output_face_blendshapes=True)
        )
    if kind == "pose":
        model = options.get("poseModel", "full")
        return vision.PoseLandmarker.create_from_options(
            vision.PoseLandmarkerOptions(base_options=base(f"pose_{model}"), running_mode=video, num_poses=1)
        )
    if kind == "face":
        return vision.FaceLandmarker.create_from_options(
            vision.FaceLandmarkerOptions(
                base_options=base("face"), running_mode=video, output_face_blendshapes=True, num_faces=1
            )
        )
    if kind == "hand":
        return vision.HandLandmarker.create_from_options(
            vision.HandLandmarkerOptions(base_options=base("hand"), running_mode=video, num_hands=2)
        )
    raise ValueError(f"Détecteur inconnu : {kind}")


# --- Normalisation au format commun (voir src/tracking/detectors.js) --------


def first(value):
    """Premier élément d'une liste par personne, ou la liste elle-même si
    l'API la renvoie déjà à plat (selon le détecteur et la version)."""
    if not value:
        return None
    return value[0] if isinstance(value[0], list) else value


def landmarks(points):
    if not points:
        return None
    out = []
    for p in points:
        item = {"x": round(p.x, PRECISION), "y": round(p.y, PRECISION), "z": round(p.z, PRECISION)}
        visibility = getattr(p, "visibility", None)
        if visibility is not None:
            item["visibility"] = round(visibility, 3)
        out.append(item)
    return out


def pair(screen, world):
    s, w = landmarks(screen), landmarks(world)
    return {"screen": s, "world": w} if s and w else None


def blendshapes(categories):
    if not categories:
        return None
    return {c.category_name: round(c.score, 4) for c in categories}


def face_part(points, shapes):
    screen = landmarks(points)
    return {"screen": screen, "blendshapes": blendshapes(shapes)} if screen else None


def normalize(kind: str, result) -> dict:
    if kind == "holistic":
        return {
            "pose": pair(first(result.pose_landmarks), first(result.pose_world_landmarks)),
            "face": face_part(first(result.face_landmarks), first(result.face_blendshapes)),
            "hands": {
                "left": pair(first(result.left_hand_landmarks), first(result.left_hand_world_landmarks)),
                "right": pair(first(result.right_hand_landmarks), first(result.right_hand_world_landmarks)),
            },
        }
    if kind == "pose":
        return {"pose": pair(first(result.pose_landmarks), first(result.pose_world_landmarks))}
    if kind == "face":
        return {"face": face_part(first(result.face_landmarks), first(result.face_blendshapes))}
    if kind == "hand":
        # Même convention que le navigateur : étiquette « Left » = main droite
        # anatomique (image non retournée). Le navigateur réattribue de toute
        # façon chaque main au poignet le plus proche du squelette.
        hands = {"left": None, "right": None}
        for i, handedness in enumerate(result.handedness or []):
            label = handedness[0].category_name if handedness else None
            hand = pair(result.hand_landmarks[i], result.hand_world_landmarks[i])
            if label == "Left":
                hands["right"] = hand
            elif label == "Right":
                hands["left"] = hand
        return {"hands": hands}
    return {}


# --- Session : une connexion WebRTC ------------------------------------------


class Session:
    def __init__(self, pc: RTCPeerConnection, models_dir: Path, use_gpu: bool):
        self.pc = pc
        self.models_dir = models_dir
        self.use_gpu = use_gpu
        self.loop = asyncio.get_running_loop()
        self.channel = None  # DataChannel « detections »
        self.frame = None  # (numpy RGB, horodatage ms) le plus récent
        self.frame_event = asyncio.Event()
        self.detectors: dict[str, dict] = {}
        self.closed = False

    def send(self, message: dict):
        if self.channel and self.channel.readyState == "open":
            self.channel.send(json.dumps(message, separators=(",", ":")))

    async def consume(self, track):
        """Lit le flux vidéo en continu ; ne garde que la dernière frame."""
        while not self.closed:
            try:
                frame = await track.recv()
            except MediaStreamError:
                break
            self.frame = (frame.to_ndarray(format="rgb24"), int(time.monotonic() * 1000))
            self.frame_event.set()

    def configure(self, specs: list[dict]):
        wanted = {spec["id"]: spec for spec in specs}
        for detector_id in list(self.detectors):
            spec = wanted.get(detector_id)
            current = self.detectors[detector_id]
            if spec is None or spec["kind"] != current["kind"] or spec.get("options") != current["options"]:
                current["stop"] = True
                del self.detectors[detector_id]
        for detector_id, spec in wanted.items():
            if detector_id in self.detectors:
                self.detectors[detector_id]["fps"] = max(1, spec.get("fps", 30))
                continue
            detector = {
                "id": detector_id,
                "kind": spec["kind"],
                "options": spec.get("options") or {},
                "fps": max(1, spec.get("fps", 30)),
                "stop": False,
            }
            self.detectors[detector_id] = detector
            asyncio.ensure_future(self.run_detector(detector))

    async def run_detector(self, detector: dict):
        """Boucle d'un détecteur : une inférence à la fois, au plus au FPS
        demandé, toujours sur la frame la plus récente."""
        detector_id, kind = detector["id"], detector["kind"]
        # Une tâche MediaPipe n'est pas partagée entre threads : un exécuteur
        # mono-thread par détecteur.
        thread = ThreadPoolExecutor(max_workers=1, thread_name_prefix=f"mp-{kind}")
        try:
            task = await self.loop.run_in_executor(
                thread, create_task, kind, detector["options"], self.models_dir, self.use_gpu
            )
        except Exception as error:  # noqa: BLE001 — remonté au navigateur
            log.exception("Création du détecteur %s impossible", kind)
            self.send({"type": "error", "id": detector_id, "message": str(error)})
            thread.shutdown(wait=False)
            return
        self.send({"type": "ready", "id": detector_id, "delegate": "GPU distant" if self.use_gpu else "CPU distant"})

        last_timestamp = -1
        next_run = 0.0
        try:
            while not detector["stop"] and not self.closed:
                delay = next_run - time.monotonic()
                if delay > 0:
                    await asyncio.sleep(delay)
                if self.frame is None or self.frame[1] <= last_timestamp:
                    self.frame_event.clear()
                    await self.frame_event.wait()
                    continue
                image, timestamp = self.frame
                # Horodatages strictement croissants exigés par le mode VIDEO.
                timestamp = max(timestamp, last_timestamp + 1)
                last_timestamp = timestamp
                next_run = time.monotonic() + 1 / detector["fps"]
                try:
                    parts, inference_ms = await self.loop.run_in_executor(thread, self.infer, task, kind, image, timestamp)
                    self.send({"type": "result", "id": detector_id, "parts": parts, "inferenceMs": round(inference_ms, 1)})
                except Exception as error:  # noqa: BLE001
                    log.exception("Inférence %s en échec", kind)
                    self.send({"type": "error", "id": detector_id, "message": str(error)})
        finally:
            await self.loop.run_in_executor(thread, task.close)
            thread.shutdown(wait=False)

    @staticmethod
    def infer(task, kind, image, timestamp):
        start = time.perf_counter()
        result = task.detect_for_video(mp.Image(image_format=mp.ImageFormat.SRGB, data=image), timestamp)
        return normalize(kind, result), (time.perf_counter() - start) * 1000

    async def close(self):
        self.closed = True
        for detector in self.detectors.values():
            detector["stop"] = True
        self.frame_event.set()
        await self.pc.close()


# --- Serveur HTTP (signalisation) --------------------------------------------

CORS_HEADERS = {
    "Access-Control-Allow-Origin": "*",
    "Access-Control-Allow-Methods": "POST, GET, OPTIONS",
    "Access-Control-Allow-Headers": "Content-Type",
}


async def index(_request):
    # Page de contrôle : l'ouvrir une fois dans le navigateur permet aussi
    # d'accepter le certificat auto-signé.
    return web.Response(text="VTuber Studio — serveur de détection actif.\n", headers=CORS_HEADERS)


async def preflight(_request):
    return web.Response(headers=CORS_HEADERS)


async def offer(request):
    params = await request.json()
    pc = RTCPeerConnection()
    session = Session(pc, request.app["models_dir"], request.app["gpu"])
    request.app["sessions"].add(session)
    peer = request.remote
    log.info("Nouvelle connexion depuis %s", peer)

    @pc.on("datachannel")
    def on_datachannel(channel):
        if channel.label == "detections":
            session.channel = channel
        elif channel.label == "control":

            @channel.on("message")
            def on_message(message):
                data = json.loads(message)
                if data.get("type") == "configure":
                    log.info("Configuration : %s", [(d["id"], d["kind"], d.get("fps")) for d in data["detectors"]])
                    session.configure(data["detectors"])

    @pc.on("track")
    def on_track(track):
        if track.kind == "video":
            asyncio.ensure_future(session.consume(track))

    @pc.on("connectionstatechange")
    async def on_state():
        log.info("Connexion %s : %s", peer, pc.connectionState)
        if pc.connectionState in ("failed", "closed", "disconnected"):
            await session.close()
            request.app["sessions"].discard(session)

    await pc.setRemoteDescription(RTCSessionDescription(sdp=params["sdp"], type=params["type"]))
    answer = await pc.createAnswer()
    await pc.setLocalDescription(answer)
    return web.json_response(
        {"sdp": pc.localDescription.sdp, "type": pc.localDescription.type}, headers=CORS_HEADERS
    )


async def on_shutdown(app):
    await asyncio.gather(*(session.close() for session in list(app["sessions"])))


def main():
    parser = argparse.ArgumentParser(description="Serveur de détection distant de VTuber Studio")
    parser.add_argument("--host", default="0.0.0.0")
    parser.add_argument("--port", type=int, default=8765)
    parser.add_argument("--cert", help="certificat TLS (la page étant en HTTPS, le serveur doit l'être aussi)")
    parser.add_argument("--key", help="clé privée TLS")
    parser.add_argument("--gpu", action="store_true", help="délégation GPU de MediaPipe (selon la plateforme)")
    parser.add_argument("--models-dir", default=str(Path(__file__).parent / "models"))
    parser.add_argument("--verbose", action="store_true")
    args = parser.parse_args()

    logging.basicConfig(level=logging.DEBUG if args.verbose else logging.INFO, format="%(asctime)s %(name)s %(message)s")

    app = web.Application()
    app["models_dir"] = Path(args.models_dir)
    app["gpu"] = args.gpu
    app["sessions"] = set()
    app.on_shutdown.append(on_shutdown)
    app.router.add_get("/", index)
    app.router.add_post("/offer", offer)
    app.router.add_route("OPTIONS", "/offer", preflight)

    ssl_context = None
    if args.cert and args.key:
        ssl_context = ssl.create_default_context(ssl.Purpose.CLIENT_AUTH)
        ssl_context.load_cert_chain(args.cert, args.key)
    else:
        log.warning("Sans --cert/--key, le serveur est en HTTP : une page servie en HTTPS ne pourra pas le joindre.")

    web.run_app(app, host=args.host, port=args.port, ssl_context=ssl_context)


if __name__ == "__main__":
    main()
