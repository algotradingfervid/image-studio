#!/usr/bin/env python3
"""Delete the Image Studio Runpod resources. Stdlib only.

    python3 scripts/runpod_teardown.py                      # dry run: list what would be deleted
    python3 scripts/runpod_teardown.py --apply              # delete endpoint(s), secrets, registry cred
    python3 scripts/runpod_teardown.py --apply --include-volume   # ...and the network volume

Only resources whose name starts with "image-studio-" are touched.
WARNING: deleting the network volume deletes every downloaded model and LoRA
on it (tens of GB to re-download). It is kept unless --include-volume is given.
Order: endpoints first (a volume attached to an endpoint cannot be removed;
deleting a v2 endpoint also removes its bound template), then leftover
templates, registry credentials, secrets, and finally the volume.
"""

from __future__ import annotations

import argparse
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
    read_env,
    write_env_value,
)


def plan_teardown(api: RunpodApi, include_volume: bool, keep_secrets: bool) -> list[tuple[str, str, str]]:
    """[(kind, id, name)] in deletion order."""
    plan = []
    for e in find_owned(api.list_all("/v2/serverless", "endpoints")):
        plan.append(("endpoint", e["id"], e["name"]))
    for t in find_owned(api.list_all("/v2/templates", "templates")):
        plan.append(("template", t["id"], t["name"]))
    for r in find_owned(api.get("/v2/registries")["registries"]):
        plan.append(("registry", r["id"], r["name"]))
    if not keep_secrets:
        for s in find_owned(api.get("/v2/account/secrets")["secrets"]):
            plan.append(("secret", s["id"], s["name"]))
    if include_volume:
        for v in find_owned(api.get("/v2/network-volumes")["networkVolumes"]):
            plan.append(("volume", v["id"], v["name"]))
    return plan


PATHS = {
    "endpoint": "/v2/serverless/{}",
    "template": "/v2/templates/{}",
    "registry": "/v2/registries/{}",
    "secret": "/v2/account/secrets/{}",
    "volume": "/v2/network-volumes/{}",
}


def main(argv=None, api_factory=RunpodApi) -> int:
    p = argparse.ArgumentParser(description=__doc__, formatter_class=argparse.RawDescriptionHelpFormatter)
    p.add_argument("--apply", action="store_true", help="actually delete (default: dry run)")
    p.add_argument("--include-volume", action="store_true",
                   help="also delete the network volume AND ALL MODELS ON IT")
    p.add_argument("--keep-secrets", action="store_true", help="keep the image-studio-* Runpod secrets")
    p.add_argument("--yes", action="store_true", help="skip the confirmation prompt for the volume")
    p.add_argument("--env-file", type=Path, default=DEFAULT_ENV_PATH)
    args = p.parse_args(argv)

    env_values = read_env(args.env_file)
    api_key = env_values.get("RUNPOD_API_KEY", "")
    if not api_key:
        die(f"RUNPOD_API_KEY is empty in {args.env_file}")
    api = api_factory(api_key, redact=Redactor([api_key]))

    try:
        plan = plan_teardown(api, args.include_volume, args.keep_secrets)
    except ApiError as e:
        die(str(e))
    if not plan:
        print("Nothing named image-studio-* found.")
        return 0

    print(("DELETING" if args.apply else "DRY RUN — would delete") + ":")
    for kind, rid, name in plan:
        print(f"  - {kind:<9} {name}  id={rid}")
    if not args.include_volume:
        print("  (network volume kept; add --include-volume to delete it and all models on it)")
    volumes = [x for x in plan if x[0] == "volume"]
    if volumes:
        print("\nWARNING: deleting the network volume permanently deletes ALL models and LoRAs on it.")

    if not args.apply:
        print("\nNothing changed. Re-run with --apply to delete.")
        return 0

    if volumes and not args.yes:
        if not sys.stdin.isatty():
            die("refusing to delete the volume non-interactively without --yes")
        answer = input(f"Type the volume name ({volumes[0][2]}) to confirm: ").strip()
        if answer != volumes[0][2]:
            die("not confirmed; nothing deleted")

    failed = 0
    deleted_endpoints = set()
    for kind, rid, name in plan:
        try:
            api.delete(PATHS[kind].format(rid))
            print(f"deleted {kind} {name} ({rid})")
            if kind == "endpoint":
                deleted_endpoints.add(rid)
        except ApiError as e:
            if e.status == 404:
                print(f"already gone: {kind} {name} ({rid})")  # e.g. bound template removed with its endpoint
            else:
                failed += 1
                print(f"error deleting {kind} {name}: {e}", file=sys.stderr)

    if env_values.get("RUNPOD_ENDPOINT_ID") in deleted_endpoints:
        write_env_value(args.env_file, "RUNPOD_ENDPOINT_ID", "")
        print(f"cleared RUNPOD_ENDPOINT_ID in {args.env_file}")
    return 1 if failed else 0


if __name__ == "__main__":
    sys.exit(main())
