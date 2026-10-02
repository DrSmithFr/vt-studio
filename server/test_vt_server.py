"""Tests du serveur de détection distant.

Les dépendances lourdes (aiohttp, aiortc, mediapipe) sont remplacées par des
modules bouchons quand elles ne sont pas installées : on teste ici la logique
propre au serveur (normalisation au format commun, configuration des
détecteurs), pas MediaPipe lui-même. Lancement : python -m unittest -v
"""

import asyncio
import json
import sys
import types
import unittest
from pathlib import Path
from types import SimpleNamespace as NS
from unittest import mock


def _install_stubs():
    for name in ("aiohttp", "aiortc", "mediapipe"):
        try:
            __import__(name)
            continue
        except ImportError:
            pass
        if name == "aiohttp":
            module = types.ModuleType("aiohttp")
            module.web = NS()
            sys.modules["aiohttp"] = module
        elif name == "aiortc":
            module = types.ModuleType("aiortc")
            module.RTCPeerConnection = module.RTCSessionDescription = object
            streams = types.ModuleType("aiortc.mediastreams")
            streams.MediaStreamError = Exception
            sys.modules["aiortc"] = module
            sys.modules["aiortc.mediastreams"] = streams
        elif name == "mediapipe":
            mp = types.ModuleType("mediapipe")
            tasks = types.ModuleType("mediapipe.tasks")
            python = types.ModuleType("mediapipe.tasks.python")
            vision = types.ModuleType("mediapipe.tasks.python.vision")
            tasks.python = python
            python.vision = vision
            mp.tasks = tasks
            sys.modules.update(
                {
                    "mediapipe": mp,
                    "mediapipe.tasks": tasks,
                    "mediapipe.tasks.python": python,
                    "mediapipe.tasks.python.vision": vision,
                }
            )


_install_stubs()
sys.path.insert(0, str(Path(__file__).parent))
import vt_server as server  # noqa: E402


def landmarks(n, visibility=None):
    return [NS(x=0.123456789, y=0.5, z=-0.1, visibility=visibility) for _ in range(n)]


def category(name, score=0.9):
    return NS(category_name=name, score=score)


class NormalizeTest(unittest.TestCase):
    def test_pose(self):
        parts = server.normalize("pose", NS(pose_landmarks=[landmarks(33, 0.9)], pose_world_landmarks=[landmarks(33, 0.9)]))
        self.assertEqual(len(parts["pose"]["screen"]), 33)
        self.assertEqual(parts["pose"]["screen"][0], {"x": 0.12346, "y": 0.5, "z": -0.1, "visibility": 0.9})

    def test_pose_absente(self):
        self.assertIsNone(server.normalize("pose", NS(pose_landmarks=[], pose_world_landmarks=[]))["pose"])

    def test_visage_blendshapes_en_dictionnaire(self):
        parts = server.normalize(
            "face", NS(face_landmarks=[landmarks(478)], face_blendshapes=[[category("jawOpen", 0.42)]])
        )
        self.assertEqual(parts["face"]["blendshapes"], {"jawOpen": 0.42})
        self.assertNotIn("visibility", parts["face"]["screen"][0])

    def test_mains_etiquette_left_main_droite(self):
        parts = server.normalize(
            "hand",
            NS(handedness=[[category("Left")]], hand_landmarks=[landmarks(21)], hand_world_landmarks=[landmarks(21)]),
        )
        self.assertIsNotNone(parts["hands"]["right"])
        self.assertIsNone(parts["hands"]["left"])

    def test_holistic_listes_a_plat(self):
        result = NS(
            pose_landmarks=landmarks(33),
            pose_world_landmarks=landmarks(33),
            face_landmarks=landmarks(478),
            face_blendshapes=[category("jawOpen", 0.3)],
            left_hand_landmarks=landmarks(21),
            left_hand_world_landmarks=landmarks(21),
            right_hand_landmarks=[],
            right_hand_world_landmarks=[],
        )
        parts = server.normalize("holistic", result)
        self.assertEqual(len(parts["pose"]["screen"]), 33)
        self.assertEqual(parts["face"]["blendshapes"], {"jawOpen": 0.3})
        self.assertIsNotNone(parts["hands"]["left"])
        self.assertIsNone(parts["hands"]["right"])

    def test_message_visage_tient_dans_un_datachannel(self):
        parts = server.normalize("face", NS(face_landmarks=[landmarks(478)], face_blendshapes=[[category("jawOpen")]]))
        size = len(json.dumps({"type": "result", "id": "face", "parts": parts}, separators=(",", ":")))
        self.assertLess(size, 64 * 1024)


class ConfigureTest(unittest.IsolatedAsyncioTestCase):
    async def asyncSetUp(self):
        self.session = server.Session(NS(close=mock.AsyncMock()), Path("/tmp"), use_gpu=False)
        self.started = []

        async def fake_run(detector):
            self.started.append(detector["id"])

        self.session.run_detector = fake_run

    async def test_ajout_mise_a_jour_et_retrait(self):
        self.session.configure([{"id": "pose", "kind": "pose", "fps": 15, "options": {"poseModel": "full"}}])
        await asyncio.sleep(0)
        self.assertEqual(self.started, ["pose"])

        # Changement de FPS : même détecteur, pas de redémarrage.
        self.session.configure([{"id": "pose", "kind": "pose", "fps": 30, "options": {"poseModel": "full"}}])
        await asyncio.sleep(0)
        self.assertEqual(self.started, ["pose"])
        self.assertEqual(self.session.detectors["pose"]["fps"], 30)

        # Changement de modèle : le détecteur est recréé.
        old = self.session.detectors["pose"]
        self.session.configure([{"id": "pose", "kind": "pose", "fps": 30, "options": {"poseModel": "lite"}}])
        await asyncio.sleep(0)
        self.assertTrue(old["stop"])
        self.assertEqual(self.started, ["pose", "pose"])

        # Retrait.
        current = self.session.detectors["pose"]
        self.session.configure([])
        self.assertTrue(current["stop"])
        self.assertEqual(self.session.detectors, {})

    async def test_fps_minimum_un(self):
        self.session.configure([{"id": "hand", "kind": "hand", "fps": 0}])
        self.assertEqual(self.session.detectors["hand"]["fps"], 1)

    async def test_envoi_ignore_si_canal_ferme(self):
        self.session.channel = NS(readyState="closed", send=mock.Mock())
        self.session.send({"type": "result"})
        self.session.channel.send.assert_not_called()


if __name__ == "__main__":
    unittest.main()
