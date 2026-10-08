#!/usr/bin/env python3
"""Create (or update) the Image Studio Runpod Serverless setup. Stdlib only.

    python3 scripts/runpod_setup.py               # dry run: show the plan, change nothing
    python3 scripts/runpod_setup.py --apply       # create / update the resources

Resources (all named "image-studio-*", found again by name, so re-running is safe):
  - network volume  image-studio-models   100 GB, STANDARD tier, one data center
  - secrets         image-studio-hf-token, image-studio-civitai-key  (from .env)
  - endpoint        image-studio-worker   queue endpoint running the worker image
  - registry cred   image-studio-ghcr     only with --registry-auth (private GHCR image)

Uses the Runpod REST API v2 (https://api.runpod.io/v2, OpenAPI at
https://api.runpod.io/v2/openapi.json). v1 (rest.runpod.io/v1) retires 2026-11-15.
In v2 an endpoint carries its container settings itself (Runpod keeps a bound
template internally and deletes it with the endpoint), so no separate template
is created. RUNPOD_ENDPOINT_ID is written back to .env after --apply.
Secret values are never printed.
"""

from __future__ import annotations

import argparse
import os
import sys
from pathlib import Path

sys.path.insert(0, str(Path(__file__).resolve().parent))

from runpod_common import (  # noqa: E402
    DEFAULT_ENV_PATH,
    ApiError,
    Redactor,
    RunpodApi,
    die,
    find_owned,
    mask_env,
    read_env,
    write_env_value,
)

VOLUME_NAME = "image-studio-models"
ENDPOINT_NAME = "image-studio-worker"
REGISTRY_NAME = "image-studio-ghcr"
SECRET_NAMES = {"HF_TOKEN": "image-studio-hf-token", "CIVITAI_API_KEY": "image-studio-civitai-key"}

DEFAULT_IMAGE = "ghcr.io/algotradingfervid/image-studio-worker:latest"
DEFAULT_VOLUME_GB = 100
DEFAULT_CONTAINER_DISK_GB = 20  # the image itself is not counted; worker-comfyui "base" needs ~5 GB
DEFAULT_TIMEOUT_MS = 600_000  # generation; downloads pass policy.executionTimeout per request
DEFAULT_MIN_CUDA = "12.8"  # RTX 5090 (Blackwell) needs CUDA >= 12.8
FALLBACK_DATACENTER = "EU-RO-1"

# Spec priority: RTX 5090, then L40S, then A6000. Type ids as in GET /v2/catalog/gpus.
WANTED_GPUS = ["NVIDIA GeForce RTX 5090", "NVIDIA L40S", "NVIDIA RTX A6000"]

# Used only when the catalog cannot be read (offline dry run). Snapshot of
# GET /v2/catalog/gpus on 2026-10-08: serverless pool -> member GPU type ids.
FALLBACK_POOLS = {
    "ADA_32_PRO": ["NVIDIA GeForce RTX 5090"],
    "ADA_48_PRO": ["NVIDIA L40", "NVIDIA L40S", "NVIDIA RTX 6000 Ada Generation",
                   "NVIDIA RTX PRO 6000 Blackwell Server Edition MIG 2g.48gb"],
    "AMPERE_48": ["NVIDIA A40", "NVIDIA RTX A6000"],
}

LEVEL = {"NONE": 0, "LOW": 1, "MEDIUM": 2, "HIGH": 3}


# --------------------------------------------------------------------------- pure planning functions


def fallback_catalog() -> list[dict]:
    return [{"id": t, "pool": p} for p, types in FALLBACK_POOLS.items() for t in types]


def select_gpus(catalog_gpus: list[dict], wanted: list[str], wide: bool = False) -> dict:
    """Map wanted GPU types onto serverless pools.

    Returns {"pools": [...in priority order], "excludedTypes": [...], "types": [...eligible]}.
    Without `wide`, the other cards in those pools are excluded so only the
    wanted types run. With `wide`, the whole pools are allowed (better stock).
    """
    pool_of = {g["id"]: g.get("pool") for g in catalog_gpus}
    missing = [t for t in wanted if not pool_of.get(t)]
    if missing:
        raise ValueError(f"GPU types not in any serverless pool: {missing}")
    pools: list[str] = []
    for t in wanted:
        if pool_of[t] not in pools:
            pools.append(pool_of[t])
    members = [g["id"] for g in catalog_gpus if g.get("pool") in pools]
    excluded = [] if wide else sorted(t for t in members if t not in wanted)
    types = [t for t in members if t not in excluded]
    return {"pools": pools, "excludedTypes": excluded, "types": types}


def rank_datacenters(datacenters: list[dict], catalog_gpus: list[dict], gpu_types: list[str],
                     priority: list[str]) -> list[dict]:
    """Rank data centers that offer STANDARD network volumes by serverless GPU stock.

    `catalog_gpus` comes from GET /v2/catalog/gpus?include=AVAILABILITY&product=SERVERLESS,
    whose per-GPU `dataCenters` list current stock. Higher-priority GPUs weigh more.
    Returns [{"id", "score", "gpus": {type: level}}] best first; score 0 entries included.
    """
    weight = {t: (len(priority) - priority.index(t)) ** 2 if t in priority else 1 for t in gpu_types}
    stock: dict[str, dict[str, str]] = {}
    for g in catalog_gpus:
        if g["id"] not in gpu_types:
            continue
        for dc in g.get("dataCenters") or []:
            stock.setdefault(dc["id"], {})[g["id"]] = dc.get("availability", "NONE")
    ranked = []
    for dc in datacenters:
        if "STANDARD" not in (dc.get("networkVolumeTypes") or []):
            continue
        gpus = stock.get(dc["id"], {})
        score = sum(weight[t] * LEVEL.get(level, 0) for t, level in gpus.items())
        ranked.append({"id": dc["id"], "score": score, "gpus": gpus})
    ranked.sort(key=lambda r: (-r["score"], r["id"]))
    return ranked


def volume_payload(name: str, size_gb: int, datacenter: str) -> dict:
    return {"name": name, "size": size_gb, "dataCenter": datacenter, "type": "STANDARD"}


def secret_placeholder(secret_name: str) -> str:
    return "{{ RUNPOD_SECRET_" + secret_name + " }}"


def plan_secrets(env_values: dict[str, str], existing_secret_names: set[str], plain_env: bool,
                 rotate: bool) -> tuple[dict[str, str], list[dict], list[str]]:
    """Decide how HF_TOKEN / CIVITAI_API_KEY reach the worker.

    Returns (endpoint_env, secret_actions, warnings). secret_actions items are
    {"action": "create"|"rotate"|"keep", "name", "key"}; values are looked up
    from env_values at apply time and never stored in the plan.
    """
    env: dict[str, str] = {}
    actions: list[dict] = []
    warnings: list[str] = []
    for key, secret_name in SECRET_NAMES.items():
        value = env_values.get(key, "")
        if plain_env:
            if value:
                env[key] = value
                warnings.append(f"{key} is stored as a plain endpoint env var (--plain-env)")
            else:
                warnings.append(f"{key} is empty in .env; the worker will run without it")
            continue
        if secret_name in existing_secret_names:
            env[key] = secret_placeholder(secret_name)
            actions.append({"action": "rotate" if (rotate and value) else "keep", "name": secret_name, "key": key})
        elif value:
            env[key] = secret_placeholder(secret_name)
            actions.append({"action": "create", "name": secret_name, "key": key})
        else:
            warnings.append(f"{key} is empty in .env and no Runpod secret '{secret_name}' exists; "
                            f"the worker will run without it (fill .env and re-run)")
    return env, actions, warnings


def endpoint_payload(*, image: str, env: dict[str, str], gpu: dict, datacenter: str, volume_id: str,
                     disk_gb: int, timeout_ms: int, workers_max: int, idle_timeout: int,
                     min_cuda: str | None, flashboot: str, registry_id: str | None) -> dict:
    """Body for POST /v2/serverless (CreateEndpointRequest)."""
    gpu_cfg = {"pools": list(gpu["pools"]), "count": 1}
    if gpu["excludedTypes"]:
        gpu_cfg["excludedTypes"] = list(gpu["excludedTypes"])
    if min_cuda:
        gpu_cfg["minCudaVersion"] = min_cuda
    body = {
        "name": ENDPOINT_NAME,
        "type": "QUEUE",
        "image": image,
        "disk": disk_gb,
        "env": dict(env),
        "gpu": gpu_cfg,
        "workers": {"min": 0, "max": workers_max, "idleTimeout": idle_timeout},
        "scaling": {"type": "QUEUE_DELAY", "queueDelay": 4},
        "dataCenterIds": [datacenter],
        "networkVolumes": [volume_id],
        "timeout": timeout_ms,
        "flashboot": flashboot,
    }
    if registry_id:
        body["registry"] = registry_id
    return body


def endpoint_patch(existing: dict, desired: dict) -> dict:
    """Body for PATCH /v2/serverless/{id}: only the managed fields that differ.

    Env keys the user added by hand (not managed here) are kept.
    """
    patch: dict = {}
    for field in ("image", "disk", "timeout", "flashboot", "registry"):
        if field in desired and existing.get(field) != desired[field]:
            patch[field] = desired[field]
    for field in ("dataCenterIds", "networkVolumes"):
        if sorted(existing.get(field) or []) != sorted(desired[field]):
            patch[field] = desired[field]
    ew = existing.get("workers") or {}
    if any(ew.get(k) != v for k, v in desired["workers"].items()):
        patch["workers"] = desired["workers"]
    es = existing.get("scaling") or {}
    if es.get("type") != desired["scaling"]["type"] or es.get("queueDelay") != desired["scaling"]["queueDelay"]:
        patch["scaling"] = desired["scaling"]
    merged_env = {**(existing.get("env") or {}), **desired["env"]}
    if merged_env != (existing.get("env") or {}):
        patch["env"] = merged_env
    eg = existing.get("gpu") or {}
    dg = desired["gpu"]
    gpu_patch = {}
    if list(eg.get("pools") or []) != dg["pools"] or \
            sorted(eg.get("excludedTypes") or []) != sorted(dg.get("excludedTypes") or []):
        gpu_patch["pools"] = dg["pools"]
        gpu_patch["excludedTypes"] = dg.get("excludedTypes") or []
    if dg.get("minCudaVersion") and eg.get("minCudaVersion") != dg["minCudaVersion"]:
        gpu_patch["minCudaVersion"] = dg["minCudaVersion"]
    if gpu_patch:
        patch["gpu"] = gpu_patch
    return patch


def find_endpoint(endpoints: list[dict]) -> dict | None:
    # Runpod has historically appended suffixes such as " -fb" to endpoint names.
    matches = [e for e in endpoints
               if e.get("name") == ENDPOINT_NAME or str(e.get("name", "")).startswith(ENDPOINT_NAME + " ")]
    return matches[0] if matches else None


# --------------------------------------------------------------------------- IO / orchestration


def load_catalog(api: RunpodApi | None) -> tuple[list[dict], list[dict], bool]:
    """(gpus with serverless availability, datacenters, live?)"""
    if api is None:
        return fallback_catalog(), [], False
    try:
        gpus = api.get("/v2/catalog/gpus", {"include": "AVAILABILITY", "product": "SERVERLESS"})["gpus"]
        dcs = api.get("/v2/catalog/datacenters")["dataCenters"]
        return gpus, dcs, True
    except (ApiError, OSError, KeyError) as e:
        print(f"warning: catalog unavailable ({e}); using the built-in GPU pool snapshot")
        return fallback_catalog(), [], False


def parse_args(argv):
    p = argparse.ArgumentParser(description=__doc__, formatter_class=argparse.RawDescriptionHelpFormatter)
    mode = p.add_mutually_exclusive_group()
    mode.add_argument("--dry-run", action="store_true", default=True, help="show the plan only (default)")
    mode.add_argument("--apply", action="store_true", help="create / update resources")
    p.add_argument("--image", default=None,
                   help=f"worker image (default: $WORKER_IMAGE or {DEFAULT_IMAGE})")
    p.add_argument("--datacenter", default="auto",
                   help="data center for the network volume and workers, e.g. EU-RO-1. 'auto' (default) "
                        "picks the volume-capable data center with the best current serverless stock of "
                        "the wanted GPUs. Ignored when the volume already exists.")
    p.add_argument("--volume-gb", type=int, default=DEFAULT_VOLUME_GB)
    p.add_argument("--container-disk-gb", type=int, default=DEFAULT_CONTAINER_DISK_GB)
    p.add_argument("--workers-max", type=int, default=2)
    p.add_argument("--idle-timeout", type=int, default=5, help="seconds")
    p.add_argument("--timeout-ms", type=int, default=DEFAULT_TIMEOUT_MS, help="endpoint execution timeout")
    p.add_argument("--min-cuda", default=DEFAULT_MIN_CUDA, help="minimum host CUDA version ('' for none)")
    p.add_argument("--no-flashboot", action="store_true")
    p.add_argument("--wide-gpus", action="store_true",
                   help="allow every card in the RTX 5090 / L40S / A6000 pools (adds L40, RTX 6000 Ada, A40, ...)"
                        " for better availability")
    p.add_argument("--plain-env", action="store_true",
                   help="put HF_TOKEN / CIVITAI_API_KEY in endpoint env as plain values instead of Runpod secrets")
    p.add_argument("--rotate-secrets", action="store_true",
                   help="overwrite existing Runpod secrets with the current .env values")
    p.add_argument("--registry-auth", action="store_true",
                   help="private GHCR image: create/use registry credential image-studio-ghcr from "
                        "GHCR_USERNAME + GHCR_TOKEN (a PAT with read:packages) in .env")
    p.add_argument("--registry-id", default=None, help="use an existing Runpod registry credential id")
    p.add_argument("--env-file", type=Path, default=DEFAULT_ENV_PATH)
    args = p.parse_args(argv)
    if args.apply:
        args.dry_run = False
    return args


def main(argv=None, api_factory=RunpodApi) -> int:
    args = parse_args(argv)
    env_values = read_env(args.env_file)
    image = args.image or os.environ.get("WORKER_IMAGE") or DEFAULT_IMAGE
    api_key = env_values.get("RUNPOD_API_KEY", "")
    redact = Redactor([env_values.get(k, "") for k in ("RUNPOD_API_KEY", "HF_TOKEN", "CIVITAI_API_KEY", "GHCR_TOKEN")])

    if not api_key:
        if args.apply:
            die(f"RUNPOD_API_KEY is empty in {args.env_file}")
        print("note: RUNPOD_API_KEY is empty; showing an offline plan (no lookups of existing resources)\n")
    api = api_factory(api_key, redact=redact) if api_key else None

    try:
        return run(args, api, env_values, image, redact)
    except ApiError as e:
        die(redact(str(e)))
    return 1


def run(args, api, env_values, image, redact) -> int:
    apply = args.apply
    tag = "" if apply else "[dry-run] "
    print(f"{'APPLY' if apply else 'DRY RUN (nothing will be changed; use --apply)'}\n")

    gpus, dcs, live = load_catalog(api)
    gpu = select_gpus(gpus, WANTED_GPUS, wide=args.wide_gpus)

    volumes = find_owned(api.get("/v2/network-volumes")["networkVolumes"], VOLUME_NAME) if api else []
    endpoints = api.list_all("/v2/serverless", "endpoints") if api else []
    secrets = api.get("/v2/account/secrets")["secrets"] if api else []
    existing_secret_names = {s["name"] for s in secrets}

    # ---- data center + volume
    if len(volumes) > 1:
        print(f"warning: {len(volumes)} volumes named {VOLUME_NAME}; using {volumes[0]['id']}")
    volume = volumes[0] if volumes else None
    ranked = rank_datacenters(dcs, gpus, gpu["types"], WANTED_GPUS) if live else []
    if volume:
        datacenter = volume["dataCenter"]
        if args.datacenter not in ("auto", datacenter):
            print(f"warning: volume already exists in {datacenter}; ignoring --datacenter {args.datacenter}")
    elif args.datacenter != "auto":
        datacenter = args.datacenter
        if live and datacenter not in {d["id"] for d in ranked}:
            die(f"{datacenter} does not offer STANDARD network volumes "
                f"(choose from: {', '.join(sorted(d['id'] for d in ranked))})")
    elif ranked and ranked[0]["score"] > 0:
        datacenter = ranked[0]["id"]
    else:
        datacenter = FALLBACK_DATACENTER
        print(f"warning: no live stock data for the wanted GPUs in a volume data center; "
              f"defaulting to {FALLBACK_DATACENTER}")

    print("GPU selection (serverless pools, in spec priority order):")
    print(f"  pools:          {gpu['pools']}")
    print(f"  excludedTypes:  {gpu['excludedTypes'] or '[]'}")
    print(f"  eligible types: {gpu['types']}")
    if ranked:
        print("\nVolume-capable data centers by current serverless stock of those GPUs (snapshot, changes often):")
        for r in ranked[:6]:
            stock = ", ".join(f"{t.replace('NVIDIA ', '')}={lvl}" for t, lvl in r["gpus"].items()) or "none in stock"
            print(f"  {r['id']:<10} score {r['score']:>3}  {stock}")
        chosen = next((r for r in ranked if r["id"] == datacenter), None)
        if chosen is not None and not any(t in chosen["gpus"] for t in gpu["types"]):
            print(f"warning: {datacenter} shows no current stock of the selected GPUs; workers may queue. "
                  f"Consider --wide-gpus or another --datacenter.")
    print(f"\nData center: {datacenter}" + (" (from existing volume)" if volume else ""))

    # ---- secrets
    endpoint_env, secret_actions, warnings = plan_secrets(env_values, existing_secret_names,
                                                          args.plain_env, args.rotate_secrets)
    for w in warnings:
        print(f"warning: {w}")

    # ---- registry credential
    registry_id = args.registry_id
    registry_action = None
    if args.registry_auth and not registry_id:
        regs = find_owned(api.get("/v2/registries")["registries"], REGISTRY_NAME) if api else []
        if regs:
            registry_id = regs[0]["id"]
            registry_action = "keep"
        else:
            if not (env_values.get("GHCR_USERNAME") and env_values.get("GHCR_TOKEN")):
                die("--registry-auth needs GHCR_USERNAME and GHCR_TOKEN (PAT with read:packages) in .env")
            registry_action = "create"

    # ---- print plan
    print("\nPlan:")
    if volume:
        print(f"  = network volume  {VOLUME_NAME}  id={volume['id']}  {volume['size']} GB in {volume['dataCenter']}")
        if volume["size"] < args.volume_gb:
            print(f"    note: smaller than --volume-gb {args.volume_gb}; grow it in the console (sizes only go up)")
    else:
        print(f"  + network volume  {VOLUME_NAME}  {args.volume_gb} GB STANDARD in {datacenter}"
              f"  (~${args.volume_gb * 0.07:.2f}/month)")
    for a in secret_actions:
        sym = {"create": "+", "rotate": "~", "keep": "="}[a["action"]]
        print(f"  {sym} secret          {a['name']}  ({a['action']}; value from .env {a['key']}, not shown)")
    if registry_action:
        print(f"  {'+' if registry_action == 'create' else '='} registry cred   {REGISTRY_NAME}"
              + (f"  id={registry_id}" if registry_id else ""))
    elif registry_id:
        print(f"  = registry cred   id={registry_id} (--registry-id)")

    flashboot = "OFF" if args.no_flashboot else "FLASHBOOT"
    desired = endpoint_payload(
        image=image, env=endpoint_env, gpu=gpu, datacenter=datacenter,
        volume_id=volume["id"] if volume else "<new volume id>",
        disk_gb=args.container_disk_gb, timeout_ms=args.timeout_ms, workers_max=args.workers_max,
        idle_timeout=args.idle_timeout, min_cuda=args.min_cuda or None, flashboot=flashboot,
        registry_id=registry_id or ("<new registry id>" if registry_action == "create" else None))
    existing_ep = find_endpoint(endpoints)
    if existing_ep:
        patch = endpoint_patch(existing_ep, desired) if volume else {"networkVolumes": ["<new volume id>"]}
        if patch:
            print(f"  ~ endpoint        {existing_ep['name']}  id={existing_ep['id']}  update: {sorted(patch)}")
        else:
            print(f"  = endpoint        {existing_ep['name']}  id={existing_ep['id']}  (up to date)")
    else:
        patch = None
        print(f"  + endpoint        {ENDPOINT_NAME}")
    shown = dict(desired, env=mask_env(desired["env"]))
    for k in ("image", "gpu", "workers", "scaling", "timeout", "flashboot", "disk", "dataCenterIds",
              "networkVolumes", "env", "registry"):
        if k in shown:
            print(f"      {k:<15} {shown[k]}")
    print(f"  .env              RUNPOD_ENDPOINT_ID  -> {args.env_file}")

    if not apply:
        print("\nNothing changed. Re-run with --apply to create / update the resources above.")
        return 0

    # ---- apply, in dependency order
    print()
    if not volume:
        volume = api.post("/v2/network-volumes", volume_payload(VOLUME_NAME, args.volume_gb, datacenter))
        print(f"created network volume {VOLUME_NAME}: id={volume['id']} ({volume['dataCenter']})")
    for a in secret_actions:
        value = env_values[a["key"]] if a["action"] != "keep" else None
        if a["action"] == "create":
            s = api.post("/v2/account/secrets", {"name": a["name"], "value": value,
                                                 "description": f"Image Studio worker {a['key']}"})
            print(f"created secret {a['name']}: id={s['id']}")
        elif a["action"] == "rotate":
            sid = next(s["id"] for s in secrets if s["name"] == a["name"])
            api.patch(f"/v2/account/secrets/{sid}", {"value": value})
            print(f"rotated secret {a['name']}: id={sid}")
    if registry_action == "create":
        reg = api.post("/v2/registries", {"name": REGISTRY_NAME, "username": env_values["GHCR_USERNAME"],
                                          "password": env_values["GHCR_TOKEN"]})
        registry_id = reg["id"]
        print(f"created registry credential {REGISTRY_NAME}: id={registry_id}")

    desired["networkVolumes"] = [volume["id"]]
    if registry_id:
        desired["registry"] = registry_id
    if existing_ep:
        patch = endpoint_patch(existing_ep, desired)
        if patch:
            ep = api.patch(f"/v2/serverless/{existing_ep['id']}", patch)
            print(f"updated endpoint {ep.get('name', ENDPOINT_NAME)}: id={existing_ep['id']} ({sorted(patch)})")
        else:
            print(f"endpoint {existing_ep['name']} up to date: id={existing_ep['id']}")
        endpoint_id = existing_ep["id"]
    else:
        ep = api.post("/v2/serverless", desired)
        endpoint_id = ep["id"]
        print(f"created endpoint {ENDPOINT_NAME}: id={endpoint_id}")

    if env_values.get("RUNPOD_ENDPOINT_ID") != endpoint_id:
        write_env_value(args.env_file, "RUNPOD_ENDPOINT_ID", endpoint_id)
        print(f"wrote RUNPOD_ENDPOINT_ID={endpoint_id} to {args.env_file}")
    print(f"\nDone. Health check: curl -H 'Authorization: Bearer $RUNPOD_API_KEY' "
          f"https://api.runpod.ai/v2/{endpoint_id}/health")
    return 0


if __name__ == "__main__":
    sys.exit(main())
