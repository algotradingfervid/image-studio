"""Unit tests for the Runpod setup scripts. Run: python3 -m unittest discover -s scripts/tests -v"""

from __future__ import annotations

import io
import json
import os
import stat
import sys
import tempfile
import unittest
from contextlib import redirect_stdout
from pathlib import Path
from unittest import mock

sys.path.insert(0, str(Path(__file__).resolve().parent.parent))

import runpod_common as rc  # noqa: E402
import runpod_setup as rs  # noqa: E402
import runpod_teardown as rt  # noqa: E402

ENV_TEXT = """# RunPod credentials
# keep me

RUNPOD_API_KEY=rpa_TESTKEY123
export RUNPOD_ENDPOINT_ID=
CIVITAI_API_KEY="civ_secret_value"   # inline comment
HF_TOKEN=hf_secretvalue
OTHER=keep # trailing
"""

CATALOG_GPUS = [
    {"id": "NVIDIA GeForce RTX 5090", "pool": "ADA_32_PRO",
     "dataCenters": [{"id": "EU-RO-1", "availability": "LOW"}, {"id": "EUR-IS-2", "availability": "HIGH"}]},
    {"id": "NVIDIA L40", "pool": "ADA_48_PRO", "dataCenters": [{"id": "US-TX-3", "availability": "HIGH"}]},
    {"id": "NVIDIA L40S", "pool": "ADA_48_PRO", "dataCenters": [{"id": "US-TX-3", "availability": "MEDIUM"}]},
    {"id": "NVIDIA RTX 6000 Ada Generation", "pool": "ADA_48_PRO", "dataCenters": []},
    {"id": "NVIDIA A40", "pool": "AMPERE_48", "dataCenters": [{"id": "CA-MTL-1", "availability": "HIGH"}]},
    {"id": "NVIDIA RTX A6000", "pool": "AMPERE_48", "dataCenters": [{"id": "EU-RO-1", "availability": "HIGH"}]},
    {"id": "NVIDIA GeForce RTX 4090", "pool": "ADA_24", "dataCenters": [{"id": "EU-RO-1", "availability": "HIGH"}]},
    {"id": "AMD Instinct MI300X OAM", "pool": None},
]
DATACENTERS = [
    {"id": "EU-RO-1", "networkVolumeTypes": ["STANDARD"]},
    {"id": "EUR-IS-2", "networkVolumeTypes": []},  # 5090 HIGH but no volumes -> not eligible
    {"id": "US-TX-3", "networkVolumeTypes": ["STANDARD"]},
    {"id": "CA-MTL-1", "networkVolumeTypes": ["HIGH_PERFORMANCE"]},  # no STANDARD tier
]


class EnvFileTests(unittest.TestCase):
    def setUp(self):
        self.dir = tempfile.TemporaryDirectory()
        self.path = Path(self.dir.name) / ".env"
        self.path.write_text(ENV_TEXT)
        os.chmod(self.path, 0o600)

    def tearDown(self):
        self.dir.cleanup()

    def test_parse(self):
        with mock.patch.dict(os.environ, {}, clear=True):
            v = rc.read_env(self.path)
        self.assertEqual(v["RUNPOD_API_KEY"], "rpa_TESTKEY123")
        self.assertEqual(v["RUNPOD_ENDPOINT_ID"], "")
        self.assertEqual(v["CIVITAI_API_KEY"], "civ_secret_value")
        self.assertEqual(v["OTHER"], "keep")
        self.assertNotIn("#", "".join(v))

    def test_process_env_overrides_file(self):
        with mock.patch.dict(os.environ, {"HF_TOKEN": "from_env"}, clear=True):
            self.assertEqual(rc.read_env(self.path)["HF_TOKEN"], "from_env")

    def test_write_replaces_in_place_and_keeps_everything_else(self):
        rc.write_env_value(self.path, "RUNPOD_ENDPOINT_ID", "abc123")
        expected = ENV_TEXT.replace("export RUNPOD_ENDPOINT_ID=\n", "export RUNPOD_ENDPOINT_ID=abc123\n")
        self.assertEqual(self.path.read_text(), expected)
        self.assertEqual(stat.S_IMODE(self.path.stat().st_mode), 0o600)

    def test_write_keeps_other_modes(self):
        os.chmod(self.path, 0o640)
        rc.write_env_value(self.path, "RUNPOD_ENDPOINT_ID", "x")
        self.assertEqual(stat.S_IMODE(self.path.stat().st_mode), 0o640)

    def test_write_appends_missing_key_and_newline(self):
        self.path.write_text("# only a comment\nA=1")  # no trailing newline
        rc.write_env_value(self.path, "RUNPOD_ENDPOINT_ID", "e1")
        self.assertEqual(self.path.read_text(), "# only a comment\nA=1\nRUNPOD_ENDPOINT_ID=e1\n")

    def test_write_ignores_commented_key(self):
        text = "# RUNPOD_ENDPOINT_ID=old\nRUNPOD_ENDPOINT_ID=old\n"
        self.assertEqual(rc.set_env_text(text, "RUNPOD_ENDPOINT_ID", "new"),
                         "# RUNPOD_ENDPOINT_ID=old\nRUNPOD_ENDPOINT_ID=new\n")

    def test_write_creates_file_0600(self):
        new = Path(self.dir.name) / "fresh.env"
        rc.write_env_value(new, "RUNPOD_ENDPOINT_ID", "e2")
        self.assertEqual(new.read_text(), "RUNPOD_ENDPOINT_ID=e2\n")
        self.assertEqual(stat.S_IMODE(new.stat().st_mode), 0o600)

    def test_crlf_preserved(self):
        self.assertEqual(rc.set_env_text("A=1\r\nRUNPOD_ENDPOINT_ID=\r\n", "RUNPOD_ENDPOINT_ID", "z"),
                         "A=1\r\nRUNPOD_ENDPOINT_ID=z\r\n")


class PayloadTests(unittest.TestCase):
    def test_select_gpus_strict(self):
        g = rs.select_gpus(CATALOG_GPUS, rs.WANTED_GPUS)
        self.assertEqual(g["pools"], ["ADA_32_PRO", "ADA_48_PRO", "AMPERE_48"])
        self.assertEqual(g["excludedTypes"], ["NVIDIA A40", "NVIDIA L40", "NVIDIA RTX 6000 Ada Generation"])
        self.assertEqual(sorted(g["types"]), sorted(rs.WANTED_GPUS))

    def test_select_gpus_wide(self):
        g = rs.select_gpus(CATALOG_GPUS, rs.WANTED_GPUS, wide=True)
        self.assertEqual(g["excludedTypes"], [])
        self.assertIn("NVIDIA A40", g["types"])
        self.assertNotIn("NVIDIA GeForce RTX 4090", g["types"])

    def test_select_gpus_unknown_type(self):
        with self.assertRaises(ValueError):
            rs.select_gpus(CATALOG_GPUS, ["NVIDIA Imaginary 9000"])

    def test_fallback_catalog_matches_wanted(self):
        g = rs.select_gpus(rs.fallback_catalog(), rs.WANTED_GPUS)
        self.assertEqual(g["pools"], ["ADA_32_PRO", "ADA_48_PRO", "AMPERE_48"])

    def test_rank_datacenters(self):
        types = rs.select_gpus(CATALOG_GPUS, rs.WANTED_GPUS)["types"]
        ranked = rs.rank_datacenters(DATACENTERS, CATALOG_GPUS, types, rs.WANTED_GPUS)
        ids = [r["id"] for r in ranked]
        self.assertEqual(ids, ["EU-RO-1", "US-TX-3"])  # EUR-IS-2 / CA-MTL-1 lack STANDARD volumes
        # EU-RO-1: 5090 LOW (9*1) + A6000 HIGH (1*3) = 12; US-TX-3: L40S MEDIUM (4*2) = 8, L40 excluded
        self.assertEqual([r["score"] for r in ranked], [12, 8])

    def test_volume_payload(self):
        self.assertEqual(rs.volume_payload("image-studio-models", 100, "EU-RO-1"),
                         {"name": "image-studio-models", "size": 100, "dataCenter": "EU-RO-1", "type": "STANDARD"})

    def test_plan_secrets_creates_and_uses_placeholders(self):
        env, actions, warnings = rs.plan_secrets({"HF_TOKEN": "hf_x", "CIVITAI_API_KEY": ""}, set(), False, False)
        self.assertEqual(env, {"HF_TOKEN": "{{ RUNPOD_SECRET_image-studio-hf-token }}"})
        self.assertEqual(actions, [{"action": "create", "name": "image-studio-hf-token", "key": "HF_TOKEN"}])
        self.assertEqual(len(warnings), 1)
        self.assertNotIn("hf_x", json.dumps([env, actions, warnings]))

    def test_plan_secrets_existing_keep_and_rotate(self):
        existing = {"image-studio-hf-token", "image-studio-civitai-key"}
        _, actions, _ = rs.plan_secrets({"HF_TOKEN": "a", "CIVITAI_API_KEY": ""}, existing, False, rotate=True)
        self.assertEqual([a["action"] for a in actions], ["rotate", "keep"])

    def test_plan_secrets_plain_env(self):
        env, actions, warnings = rs.plan_secrets({"HF_TOKEN": "hf_x", "CIVITAI_API_KEY": "c"}, set(), True, False)
        self.assertEqual(env, {"HF_TOKEN": "hf_x", "CIVITAI_API_KEY": "c"})
        self.assertEqual(actions, [])
        self.assertTrue(all("plain" in w for w in warnings))

    def _desired(self, **over):
        kw = dict(image="ghcr.io/o/image-studio-worker:latest", env={"HF_TOKEN": "{{ RUNPOD_SECRET_x }}"},
                  gpu=rs.select_gpus(CATALOG_GPUS, rs.WANTED_GPUS), datacenter="EU-RO-1", volume_id="vol1",
                  disk_gb=20, timeout_ms=600000, workers_max=2, idle_timeout=5, min_cuda="12.8",
                  flashboot="FLASHBOOT", registry_id=None)
        kw.update(over)
        return rs.endpoint_payload(**kw)

    def test_endpoint_payload(self):
        b = self._desired()
        self.assertEqual(b["name"], "image-studio-worker")
        self.assertEqual(b["type"], "QUEUE")
        self.assertEqual(b["workers"], {"min": 0, "max": 2, "idleTimeout": 5})
        self.assertEqual(b["gpu"]["pools"], ["ADA_32_PRO", "ADA_48_PRO", "AMPERE_48"])
        self.assertEqual(b["gpu"]["minCudaVersion"], "12.8")
        self.assertEqual(b["networkVolumes"], ["vol1"])
        self.assertEqual(b["dataCenterIds"], ["EU-RO-1"])
        self.assertEqual(b["timeout"], 600000)
        self.assertEqual(b["flashboot"], "FLASHBOOT")
        self.assertNotIn("registry", b)
        self.assertEqual(self._desired(registry_id="r1")["registry"], "r1")

    def test_endpoint_patch_none_when_equal(self):
        d = self._desired()
        existing = json.loads(json.dumps(d))
        existing.update(id="ep1", gpu=dict(d["gpu"], allowedCudaVersions=[]))
        self.assertEqual(rs.endpoint_patch(existing, d), {})

    def test_endpoint_patch_changes_and_keeps_manual_env(self):
        d = self._desired(image="ghcr.io/o/image-studio-worker:sha-abc",
                          env={"HF_TOKEN": "{{ RUNPOD_SECRET_x }}", "CIVITAI_API_KEY": "{{ RUNPOD_SECRET_y }}"})
        existing = json.loads(json.dumps(self._desired()))
        existing["env"]["MANUAL"] = "1"
        existing["workers"]["max"] = 3
        existing["gpu"]["excludedTypes"] = []
        p = rs.endpoint_patch(existing, d)
        self.assertEqual(sorted(p), ["env", "gpu", "image", "workers"])
        self.assertEqual(p["env"]["MANUAL"], "1")
        self.assertEqual(p["gpu"]["pools"], d["gpu"]["pools"])  # pools resent with exclusions
        self.assertEqual(p["gpu"]["excludedTypes"], d["gpu"]["excludedTypes"])

    def test_find_endpoint_tolerates_suffix(self):
        eps = [{"id": "a", "name": "other"}, {"id": "b", "name": "image-studio-worker -fb"}]
        self.assertEqual(rs.find_endpoint(eps)["id"], "b")
        self.assertIsNone(rs.find_endpoint([{"id": "c", "name": "image-studio-workerX"}]))

    def test_find_owned(self):
        items = [{"name": "image-studio-models"}, {"name": "wan-ltx-vol"}, {"name": "image-studio-hf-token"}]
        self.assertEqual(len(rc.find_owned(items)), 2)
        self.assertEqual(rc.find_owned(items, "image-studio-models"), [items[0]])


class FakeRunpod:
    """In-memory Runpod v2 transport. Records every request."""

    def __init__(self, volumes=(), endpoints=(), secrets=(), registries=(), templates=()):
        self.state = {"volumes": list(volumes), "endpoints": list(endpoints), "secrets": list(secrets),
                      "registries": list(registries), "templates": list(templates)}
        self.calls = []
        self.n = 0

    def _id(self):
        self.n += 1
        return f"id{self.n}"

    def __call__(self, method, url, headers, body):
        assert headers["Authorization"].startswith("Bearer ")
        path = url.split("https://api.runpod.io", 1)[1].split("?")[0]
        data = json.loads(body) if body else None
        self.calls.append((method, path, data))
        s = self.state
        routes = {
            "/v2/catalog/gpus": lambda: {"gpus": CATALOG_GPUS},
            "/v2/catalog/datacenters": lambda: {"dataCenters": DATACENTERS},
            "/v2/network-volumes": lambda: {"networkVolumes": s["volumes"]},
            "/v2/serverless": lambda: {"endpoints": s["endpoints"],
                                       "pagination": {"hasNextPage": False, "nextCursor": None}},
            "/v2/templates": lambda: {"templates": s["templates"],
                                      "pagination": {"hasNextPage": False, "nextCursor": None}},
            "/v2/account/secrets": lambda: {"secrets": [{k: v for k, v in x.items() if k != "value"}
                                                        for x in s["secrets"]]},
            "/v2/registries": lambda: {"registries": s["registries"]},
        }
        kinds = {"/v2/network-volumes": "volumes", "/v2/serverless": "endpoints", "/v2/account/secrets": "secrets",
                 "/v2/registries": "registries", "/v2/templates": "templates"}
        if method == "GET" and path in routes:
            return 200, json.dumps(routes[path]()).encode()
        if method == "POST" and path in kinds:
            obj = dict(data, id=self._id())
            if path == "/v2/network-volumes":
                obj = {"id": obj["id"], "name": data["name"], "size": data["size"],
                       "dataCenter": data["dataCenter"], "type": data["type"]}
            s[kinds[path]].append(obj)
            return 201, json.dumps({k: v for k, v in obj.items() if k not in ("value", "password")}).encode()
        base, _, rid = path.rpartition("/")
        if base in kinds:
            coll = s[kinds[base]]
            match = [x for x in coll if x["id"] == rid]
            if not match:
                return 404, b'{"title":"Not Found","status":404,"detail":"nope"}'
            if method == "PATCH":
                match[0].update(data)
                return 200, json.dumps(match[0]).encode()
            if method == "DELETE":
                coll.remove(match[0])
                return 204, b""
        return 404, b'{"title":"Not Found","status":404,"detail":"no route"}'

    def writes(self):
        return [(m, p) for m, p, _ in self.calls if m != "GET"]


class SetupFlowTests(unittest.TestCase):
    def setUp(self):
        self.dir = tempfile.TemporaryDirectory()
        self.env = Path(self.dir.name) / ".env"
        self.env.write_text(ENV_TEXT)
        os.chmod(self.env, 0o600)
        self._environ = mock.patch.dict(os.environ, {}, clear=True)
        self._environ.start()

    def tearDown(self):
        self._environ.stop()
        self.dir.cleanup()

    def run_setup(self, fake, *args):
        factory = lambda key, redact=None: rc.RunpodApi(key, transport=fake, redact=redact)  # noqa: E731
        out = io.StringIO()
        with redirect_stdout(out):
            code = rs.main(["--env-file", str(self.env), *args], api_factory=factory)
        return code, out.getvalue()

    def test_dry_run_makes_no_writes_and_hides_secrets(self):
        fake = FakeRunpod()
        code, out = self.run_setup(fake)
        self.assertEqual(code, 0)
        self.assertEqual(fake.writes(), [])
        self.assertIn("DRY RUN", out)
        self.assertIn("Data center: EU-RO-1", out)
        for secret in ("rpa_TESTKEY123", "hf_secretvalue", "civ_secret_value"):
            self.assertNotIn(secret, out)
        self.assertEqual(self.env.read_text(), ENV_TEXT)

    def test_apply_creates_everything_then_is_idempotent(self):
        fake = FakeRunpod()
        code, out = self.run_setup(fake, "--apply", "--image", "ghcr.io/o/w:1")
        self.assertEqual(code, 0, out)
        self.assertEqual(fake.writes(), [("POST", "/v2/network-volumes"), ("POST", "/v2/account/secrets"),
                                         ("POST", "/v2/account/secrets"), ("POST", "/v2/serverless")])
        ep = fake.state["endpoints"][0]
        self.assertEqual(ep["networkVolumes"], [fake.state["volumes"][0]["id"]])
        self.assertEqual(ep["env"]["HF_TOKEN"], "{{ RUNPOD_SECRET_image-studio-hf-token }}")
        self.assertEqual({s["value"] for s in fake.state["secrets"]}, {"hf_secretvalue", "civ_secret_value"})
        self.assertIn(f"export RUNPOD_ENDPOINT_ID={ep['id']}\n", self.env.read_text())
        self.assertEqual(stat.S_IMODE(self.env.stat().st_mode), 0o600)
        for secret in ("rpa_TESTKEY123", "hf_secretvalue", "civ_secret_value"):
            self.assertNotIn(secret, out)

        fake.calls.clear()
        code, out = self.run_setup(fake, "--apply", "--image", "ghcr.io/o/w:1")
        self.assertEqual(code, 0, out)
        self.assertEqual(fake.writes(), [], out)
        self.assertIn("up to date", out)

        fake.calls.clear()
        code, out = self.run_setup(fake, "--apply", "--image", "ghcr.io/o/w:2")
        self.assertEqual(fake.writes(), [("PATCH", f"/v2/serverless/{ep['id']}")])
        self.assertEqual(fake.calls[-1][2], {"image": "ghcr.io/o/w:2"})

    def test_existing_volume_pins_datacenter(self):
        fake = FakeRunpod(volumes=[{"id": "v9", "name": "image-studio-models", "size": 100,
                                    "dataCenter": "US-TX-3", "type": "STANDARD"},
                                   {"id": "other", "name": "wan-ltx-vol", "size": 75,
                                    "dataCenter": "US-CA-2", "type": "STANDARD"}])
        code, out = self.run_setup(fake, "--apply")
        self.assertEqual(code, 0, out)
        self.assertNotIn(("POST", "/v2/network-volumes"), fake.writes())
        self.assertEqual(fake.state["endpoints"][0]["dataCenterIds"], ["US-TX-3"])
        self.assertEqual(fake.state["endpoints"][0]["networkVolumes"], ["v9"])

    def test_api_error_is_redacted(self):
        def boom(method, url, headers, body):
            return 400, json.dumps({"title": "Bad", "status": 400, "detail": "key rpa_TESTKEY123 bad"}).encode()
        api = rc.RunpodApi("rpa_TESTKEY123", transport=boom)
        with self.assertRaises(rc.ApiError) as cm:
            api.get("/v2/network-volumes")
        self.assertNotIn("rpa_TESTKEY123", str(cm.exception))


class TeardownTests(unittest.TestCase):
    def setUp(self):
        self.dir = tempfile.TemporaryDirectory()
        self.env = Path(self.dir.name) / ".env"
        self.env.write_text(ENV_TEXT.replace("RUNPOD_ENDPOINT_ID=", "RUNPOD_ENDPOINT_ID=ep1"))
        self._environ = mock.patch.dict(os.environ, {}, clear=True)
        self._environ.start()
        self.fake = FakeRunpod(
            volumes=[{"id": "v1", "name": "image-studio-models"}, {"id": "v2", "name": "wan-ltx-vol"}],
            endpoints=[{"id": "ep1", "name": "image-studio-worker"}],
            secrets=[{"id": "s1", "name": "image-studio-hf-token"}, {"id": "s2", "name": "key1"}],
            templates=[{"id": "t9", "name": "wan-ltx-worker-template"}])

    def tearDown(self):
        self._environ.stop()
        self.dir.cleanup()

    def run_teardown(self, *args):
        factory = lambda key, redact=None: rc.RunpodApi(key, transport=self.fake, redact=redact)  # noqa: E731
        out = io.StringIO()
        with redirect_stdout(out):
            code = rt.main(["--env-file", str(self.env), *args], api_factory=factory)
        return code, out.getvalue()

    def test_dry_run(self):
        code, out = self.run_teardown()
        self.assertEqual(code, 0)
        self.assertEqual(self.fake.writes(), [])
        self.assertIn("network volume kept", out)

    def test_apply_keeps_volume_and_foreign_resources(self):
        code, out = self.run_teardown("--apply")
        self.assertEqual(code, 0, out)
        self.assertEqual(self.fake.writes(), [("DELETE", "/v2/serverless/ep1"), ("DELETE", "/v2/account/secrets/s1")])
        self.assertIn("RUNPOD_ENDPOINT_ID=\n", self.env.read_text())

    def test_apply_with_volume_needs_yes_when_not_a_tty(self):
        with mock.patch("sys.stdin", io.StringIO("")), self.assertRaises(SystemExit):
            self.run_teardown("--apply", "--include-volume")
        code, out = self.run_teardown("--apply", "--include-volume", "--yes")
        self.assertEqual(code, 0, out)
        self.assertIn(("DELETE", "/v2/network-volumes/v1"), self.fake.writes())
        self.assertNotIn(("DELETE", "/v2/network-volumes/v2"), self.fake.writes())
        self.assertIn("deletes ALL models", out)


if __name__ == "__main__":
    unittest.main()
