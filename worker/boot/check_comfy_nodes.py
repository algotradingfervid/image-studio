"""Build-time check: every ComfyUI node class our graphs use is registered.

Run by worker/Dockerfile.runtime after ComfyUI and its requirements are
installed (CPU only, no GPU needed):

    python check_comfy_nodes.py /comfyui /app-baked/src/workflows.py

The class names are read from workflows.py (`.add("ClassName", ...)`), so the
list never drifts from the graphs. Exits 1 and names the missing classes (and
any comfy_extras module that failed to import) when something is missing,
e.g. because a dependency was left out of the slim image.
"""

from __future__ import annotations

import asyncio
import os
import re
import sys
from pathlib import Path

ADD_RE = re.compile(r"\.add\(\s*\"([A-Za-z0-9_]+)\"")


def required_classes(workflows_py: Path) -> list[str]:
    return sorted(set(ADD_RE.findall(workflows_py.read_text())))


def main(argv: list[str]) -> int:
    if len(argv) != 3:
        print("usage: check_comfy_nodes.py <comfyui dir> <workflows.py>", file=sys.stderr)
        return 2
    comfy_dir, workflows_py = Path(argv[1]).resolve(), Path(argv[2])
    need = required_classes(workflows_py)
    if not need:
        print(f"no node classes found in {workflows_py}", file=sys.stderr)
        return 1
    os.chdir(comfy_dir)
    sys.path.insert(0, str(comfy_dir))
    sys.argv = [str(comfy_dir / "main.py"), "--cpu"]
    import comfy.options  # noqa: E402  (ComfyUI parses sys.argv on import)
    comfy.options.enable_args_parsing()
    import nodes  # noqa: E402

    failed = asyncio.run(nodes.init_extra_nodes(init_custom_nodes=False, init_api_nodes=False))
    missing = [c for c in need if c not in nodes.NODE_CLASS_MAPPINGS]
    print(f"ComfyUI nodes: {len(nodes.NODE_CLASS_MAPPINGS)} registered; "
          f"{len(need)} required by workflows.py; comfy_extras import failures: "
          f"{', '.join(failed) or 'none'}")
    if missing:
        print(f"MISSING node classes: {', '.join(missing)}", file=sys.stderr)
        return 1
    print("all required node classes present")
    return 0


if __name__ == "__main__":
    sys.exit(main(sys.argv))
