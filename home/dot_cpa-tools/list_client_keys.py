"""List this hub's CLIProxyAPI client keys by remark. Prints remarks and counts, never a key.

usage: py -I list_client_keys.py [--json]

Reads the GUI config.toml (api-keys = [{ key, remark }, ...]) and the core config.yaml
(api-keys: list) under the install directory, and reports:
  - each remark (or "(no remark)") with the key's length
  - gui=N core=M unnamed=K in_sync=true|false (the same set of keys in both files)
--json prints {"remarks": [...], "gui": N, "core": M, "unnamed": K, "in_sync": bool} for
scripts/verify.d/40-cpa.ps1. Deployed by agent-env (chezmoi, hub role only).
"""
import json
import os
import re
import sys
import tomllib
from pathlib import Path


def app_dir() -> Path:
    value = os.environ.get("CPA_APP_DIR")
    if not value:
        try:
            with open(Path(__file__).resolve().with_name("cpa-tools.toml"), "rb") as f:
                value = tomllib.load(f).get("app_dir")
        except OSError:
            value = None
    if not value:
        sys.exit("no CPA install dir: set CPA_APP_DIR or run chezmoi apply")
    return Path(value)


def main() -> int:
    root = app_dir()
    with open(root / "config.toml", "rb") as f:
        gui = tomllib.load(f).get("api-keys") or []
    rows = []
    for e in gui:
        if isinstance(e, dict):
            rows.append((str(e.get("remark") or ""), str(e.get("key") or "")))
        else:
            rows.append(("", str(e)))
    y = (root / "cpa-core" / "config.yaml").read_text(encoding="utf-8")
    m = re.search(r"^  api-keys:\n((?:    - .*\n)+)", y, re.M)
    core = [re.sub(r"^    - ", "", line).strip().strip("'\"") for line in (m.group(1).splitlines() if m else [])]
    out = {
        "remarks": sorted(r for r, _ in rows if r),
        "gui": len(rows),
        "core": len(core),
        "unnamed": sum(1 for r, _ in rows if not r),
        "in_sync": sorted(k for _, k in rows) == sorted(core),
    }
    if "--json" in sys.argv:
        print(json.dumps(out))
    else:
        for r, k in rows:
            print(f"{r or '(no remark)'}  len {len(k)}")
        print(f"gui={out['gui']} core={out['core']} unnamed={out['unnamed']} in_sync={str(out['in_sync']).lower()}")
    return 0


if __name__ == "__main__":
    sys.exit(main())
