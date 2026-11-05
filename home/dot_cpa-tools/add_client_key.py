"""Add a client API key (read from stdin) to the hub's CPA: GUI config.toml + core config.yaml.
usage: add_client_key.py <remark> < key   (restart EasyCLIProxyAPI afterwards)

Deployed by agent-env (chezmoi, hub role only). Prefer mint_client_key.py, which generates
the key, stores it in 1Password as cpa-client-<remark> and then runs this script, so the key
is never typed, shown or written anywhere else (docs/cpa.md).
The install directory comes from CPA_APP_DIR, else app_dir in cpa-tools.toml next to this script.
Prints the remark only, never the key."""
import os, re, shutil, sys, tomllib
from pathlib import Path


def app_dir() -> str:
    value = os.environ.get("CPA_APP_DIR")
    if not value:
        try:
            with open(Path(__file__).resolve().with_name("cpa-tools.toml"), "rb") as f:
                value = tomllib.load(f).get("app_dir")
        except OSError:
            value = None
    if not value:
        sys.exit("no CPA install dir: set CPA_APP_DIR or run chezmoi apply")
    return str(value)


if len(sys.argv) != 2:
    sys.exit(__doc__.splitlines()[1])
R = app_dir()
remark, key = sys.argv[1], sys.stdin.read().strip()
# Same rule as the agent-env machine remark, so remark == machine == 1Password item suffix.
assert re.fullmatch(r"[a-z0-9][a-z0-9-]{0,62}", remark), "bad remark (lowercase a-z 0-9 -)"
assert re.fullmatch(r"[\x21-\x7e]{16,}", key) and '"' not in key and "'" not in key, "bad key"
tp, yp = os.path.join(R, "config.toml"), os.path.join(R, "cpa-core", "config.yaml")
t = open(tp, encoding="utf-8").read()
if key in t: sys.exit("already present")
if re.search(r'remark = "' + re.escape(remark) + r'"', t): sys.exit("remark already in use: " + remark)
for p in (tp, yp): shutil.copy(p, p + ".bak-addkey-" + remark)
t, n = re.subn(r"^(api-keys = \[.*)\]$", lambda m: m.group(1) + f', {{ key = "{key}", remark = "{remark}" }}]', t, count=1, flags=re.M)
assert n == 1; tomllib.loads(t)
y = open(yp, encoding="utf-8").read()
m = re.search(r"^  api-keys:\n((?:    - '.*'\n)+)", y, re.M); assert m
y = y[:m.end(1)] + f"    - '{key}'\n" + y[m.end(1):]
open(tp, "w", encoding="utf-8", newline="").write(t)
open(yp, "w", encoding="utf-8", newline="").write(y)
print("added", remark)
