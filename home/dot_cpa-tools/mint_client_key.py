"""Mint one machine's CLIProxyAPI client key, store it in 1Password, then register it on this hub.

usage: py -I mint_client_key.py <remark> [--vault NAME] [--dry-run]

  <remark>   the machine remark (agent-env `machine`): lowercase a-z 0-9 -, for example beast-1-wsl
  --vault    1Password vault, default agent-env (hub or opt-in account-mode machines). Other devices
             use their own vault agent-env-<remark>, so each service account sees no other key
             (docs/cpa.md "1Password vaults"). Never an owner-only vault.
  --dry-run  check everything and print the plan; create nothing

Steps, in this order, so the key is never only on the hub:
  1. op is signed in, the vault is readable, and item cpa-client-<remark> does not exist yet
  2. generate the key in memory: sk-cpa- plus 42 random bytes, URL-safe base64 (63 characters)
  3. create the 1Password item from op's own "API Credential" template, piped on stdin
     (never as a command-line argument, which other processes can read)
  4. read it back with op read and compare in memory
  5. pipe it into add_client_key.py <remark>, which adds it to the GUI and core configs
Then restart EasyCLIProxyAPI. Prints remarks, item names and status only, never the key.

Deployed by agent-env (chezmoi, hub role only). See docs/cpa.md, "Mint a key for a new machine".
"""
import json
import re
import secrets
import shutil
import subprocess
import sys
from datetime import datetime, timezone
from pathlib import Path

HERE = Path(__file__).resolve().parent


def run(args: list[str], stdin: str = "") -> subprocess.CompletedProcess:
    """Capture output and explicitly close stdin unless a JSON template is supplied.

    Inherit OP_SERVICE_ACCOUNT_TOKEN from BEAST's user environment. Never inherit an open
    stdin pipe: op item get/read can misbehave, and item edit waits for a template there.
    """
    return subprocess.run(args, input=stdin, capture_output=True, text=True,
                          encoding="utf-8", timeout=120)


def main() -> int:
    argv = sys.argv[1:]
    vault, dry, remark = "agent-env", False, None
    while argv:
        a = argv.pop(0)
        if a == "--vault" and argv:
            vault = argv.pop(0)
        elif a == "--dry-run":
            dry = True
        elif not a.startswith("-") and remark is None:
            remark = a
        else:
            print(__doc__.split("\n\n")[1])
            return 2
    if not remark or not re.fullmatch(r"[a-z0-9][a-z0-9-]{0,62}", remark):
        print("remark must match ^[a-z0-9][a-z0-9-]{0,62}$")
        return 2
    item = f"cpa-client-{remark}"
    op = shutil.which("op")
    if not op:
        print("FAIL 1Password CLI 'op' not found (agent-env preflight prints the install steps)")
        return 1
    if run([op, "whoami"]).returncode != 0:
        print("FAIL op is not signed in (desktop-app integration or OP_SERVICE_ACCOUNT_TOKEN)")
        return 1
    if run([op, "vault", "get", vault]).returncode != 0:
        print(f"FAIL vault '{vault}' is not readable by this op session")
        return 1
    if run([op, "item", "get", item, "--vault", vault, "--format", "json"]).returncode == 0:
        print(f"FAIL item '{item}' already exists in '{vault}'. To rotate it, follow docs/cpa.md "
              "'Rotate or revoke a key' (remove the old key on the hub, archive the item, then mint)")
        return 1
    if not (HERE / "add_client_key.py").is_file():
        print("FAIL add_client_key.py is not next to this script (run chezmoi apply)")
        return 1

    t = run([op, "item", "template", "get", "API Credential", "--format", "json"])
    if t.returncode != 0:
        print("FAIL op item template get 'API Credential' failed")
        return 1
    template = json.loads(t.stdout)
    fields = [f for f in template.get("fields", []) if f.get("id") == "credential" or f.get("label") == "credential"]
    if len(fields) != 1:
        print("FAIL the API Credential template has no single 'credential' field; nothing created")
        return 1

    if dry:
        print(f"dry run: would create '{item}' in '{vault}', then run add_client_key.py {remark}")
        return 0

    key = "sk-cpa-" + secrets.token_urlsafe(42)
    fields[0]["value"] = key
    template["title"] = item
    stamp = datetime.now(timezone.utc).strftime("%Y-%m-%d")
    template["notesPlain"] = (f"CLIProxyAPI client key for agent-env machine remark '{remark}'. "
                              f"Minted on the hub {stamp} by ~/.cpa-tools/mint_client_key.py. "
                              "One key per machine: never copy it to another machine.")
    c = run([op, "item", "create", "--vault", vault, "-"], stdin=json.dumps(template))
    template = None
    if c.returncode != 0:
        print(f"FAIL op item create '{item}' failed (exit {c.returncode}); nothing was registered on the hub")
        return 1
    print(f"ok    stored '{item}' in '{vault}'")
    r = run([op, "read", f"op://{vault}/{item}/credential"])
    if r.returncode != 0 or r.stdout.strip() != key:
        print(f"FAIL read-back of '{item}' did not match; not registering. Check the item, then rerun "
              "add_client_key.py by piping 'op read' into it (docs/cpa.md)")
        return 1
    print(f"ok    read-back of '{item}' matches")
    a = subprocess.run([sys.executable, "-I", str(HERE / "add_client_key.py"), remark],
                       input=key, capture_output=True, text=True, encoding="utf-8", timeout=60)
    key = None
    if a.returncode != 0:
        print(f"FAIL add_client_key.py exit {a.returncode}; inspect the installed config privately")
        return 1
    print(f"ok    registered remark '{remark}' on this hub")
    print("next: restart EasyCLIProxyAPI, then run agent-env preflight on that machine")
    return 0


if __name__ == "__main__":
    sys.exit(main())
