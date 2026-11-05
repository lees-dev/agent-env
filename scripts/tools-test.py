"""Exercise the tools stage without installing software or reading credentials.

Run with Python 3.11+ and chezmoi on PATH (or AGENT_ENV_CHEZMOI).
All destinations and fake homes live under .tools/ and are deleted afterwards.
"""
import json
import hashlib
import os
from pathlib import Path
import shutil
import subprocess
import tempfile
import tarfile
import tomllib
import urllib.request
import urllib.error
from concurrent.futures import ThreadPoolExecutor

REPO = Path(__file__).resolve().parent.parent
WINDOWS = os.name == "nt"
CZ = os.environ.get("AGENT_ENV_CHEZMOI") or shutil.which("chezmoi")
if not CZ:
    CZ = str(REPO / (".tools/chezmoi.exe" if WINDOWS else ".tools/linux/chezmoi"))
# A bare command name (AGENT_ENV_CHEZMOI=chezmoi) must be a real path before fixtures copy it.
CZ = shutil.which(CZ) or CZ


def run(args, env):
    result = subprocess.run(args, cwd=REPO, env=env, stdin=subprocess.DEVNULL,
                            capture_output=True, text=True, timeout=120)
    assert result.returncode == 0, "tools subprocess failed: " + result.stdout + result.stderr
    return result.stdout


def manifest(root):
    # Windows PowerShell itself maintains this startup cache before executing -File.
    return {str(p.relative_to(root)): p.read_bytes() for p in root.rglob("*")
            if p.is_file() and p.name != "StartupProfileData-NonInteractive"}


(REPO / ".tools").mkdir(exist_ok=True)
with tempfile.TemporaryDirectory(prefix="tools-test-", dir=REPO / ".tools") as tmp:
    root = Path(tmp)
    home = root / "home"
    home.mkdir()
    # An existing broken normal config must not affect this production path.
    config = home / ".config/chezmoi"
    config.mkdir(parents=True)
    (config / "chezmoi.toml").write_text("invalid normal config [\n")
    fakebin = root / "bin"
    fakebin.mkdir()
    (root / "runtime").mkdir()
    bomb = fakebin / ("op.cmd" if WINDOWS else "op")
    bomb.write_text("@echo off\r\nexit /b 99\r\n" if WINDOWS else "#!/bin/sh\nexit 99\n")
    bomb.chmod(0o755)
    dpkg = fakebin / "dpkg-query"
    dpkg.write_text('#!/bin/sh\n[ -n "${TEST_DPKG_VERSION:-}" ] || exit 1\nprintf "install ok installed %s\\n" "$TEST_DPKG_VERSION"\n')
    dpkg.chmod(0o755)
    env = dict(os.environ, HOME=str(home), USERPROFILE=str(home),
               # Keep shell/CLI runtime caches separate from the destination being checked.
               APPDATA=str(root / "runtime/Roaming"), LOCALAPPDATA=str(root / "runtime/Local"),
               PSModuleAnalysisCachePath=str(root / "runtime/ModuleAnalysisCache"),
               XDG_CONFIG_HOME=str(home / ".config"), AGENT_ENV_CHEZMOI=CZ,
               AGENT_ENV_DRY_RUN="1", AGENT_ENV_SYSTEM_PACKAGES="1",
               AGENT_ENV_HARNESSES="codex", PATH=str(fakebin) + os.pathsep + os.environ["PATH"])
    for key in ("AGENT_ENV_NO_SECRETS", "OP_SERVICE_ACCOUNT_TOKEN", "AGENT_ENV_ROLE"):
        env.pop(key, None)
    before = manifest(home)
    for role in ("client", "server"):
        if WINDOWS:
            args = ["powershell", "-NoProfile", "-ExecutionPolicy", "Bypass", "-File",
                    str(REPO / "scripts/install-tools.ps1"), "-Role", role, "-Machine", "tools-test"]
        else:
            args = ["sh", str(REPO / "scripts/install-tools"), "--role", role, "--machine", "tools-test"]
        output = run(args, env)
        for tool in ("claude", "codex", "grok", "muse", "pnpm", "bun", "higgsfield", "vercel"):
            assert tool in output, "missing default tool: " + tool
        if role == "server":
            assert "winget install T3Tools" not in output and "winget upgrade Docker" not in output
            assert "would install T3 Code" not in output
        assert manifest(home) == before, "dry-run changed paths: " + str(set(manifest(home)) ^ set(before))
    print("tools-test: 2 native dry stages passed; all harnesses, no credentials or destination deployment")

    source = root / "source"
    for path in (REPO / "packages/tools-stage.txt").read_text().splitlines():
        if not path or path.startswith("#"):
            continue
        assert "secrets/" not in path and not path.endswith(".chezmoi.toml.tmpl")
        target = source / path
        target.parent.mkdir(parents=True, exist_ok=True)
        shutil.copyfile(REPO / "home" / path, target)
    desktop_scripts = {}
    # Render both Unix desktop branches on each host, with no init or apply.
    for platform in ("linux", "macos", "wsl"):
        for role in ("client", "server"):
            data = dict(role=role, machine="tools-test", osFlavour=platform,
                        distro="ubuntu", distroFamily="debian", pkgManager="apt",
                        headless=role == "server" or platform == "wsl",
                        harnesses=["claude", "codex", "grok", "muse"],
                        repoDir=REPO.as_posix(), backupRoot=(home / "backups").as_posix())
            cfg = root / "render.toml"
            cfg.write_text("[data]\n" + "\n".join(k + " = " + json.dumps(v) for k, v in data.items()))
            rendered = run([CZ, "--source", str(source), "--config", str(cfg),
                            "--destination", str(home), "--persistent-state", str(root / "state"),
                            "--cache", str(root / "cache"), "execute-template", "--file",
                            str(source / ".chezmoiscripts/run_onchange_before_14-packages-desktop.sh.tmpl")], env)
            if data["headless"]:
                assert not rendered.strip(), "desktop script rendered on headless role"
            else:
                desktop_scripts[platform] = rendered
                assert "T3-Code-" in rendered and "JetBrains Toolbox" in rendered
                assert ("Docker.dmg" in rendered) == (platform == "macos")
                script = root / "desktop.sh"
                script.write_text(rendered, newline="\n")
                run(["sh", "-n", str(script)], env)
                shellcheck = shutil.which("shellcheck")
                if shellcheck:
                    run([shellcheck, "-s", "sh", "-S", "warning", str(script)], env)
    print("tools-test: 6 desktop role/platform renders passed; active branches parsed")

    def render(path, expect_error=None, **changes):
        fixture_data = dict(data, **changes)
        cfg.write_text("[data]\n" + "\n".join(k + " = " + json.dumps(v) for k, v in fixture_data.items()))
        args = [CZ, "--source", str(source), "--config", str(cfg),
                "--destination", str(home), "--persistent-state", str(root / "state"),
                "--cache", str(root / "cache"), "execute-template", "--file", str(source / path)]
        if expect_error:
            result = subprocess.run(args, env=env, stdin=subprocess.DEVNULL,
                                    capture_output=True, text=True, timeout=120)
            assert result.returncode != 0 and expect_error in result.stderr, result.stderr
            return result.stderr
        return run(args, env)

    def shell_fixture(body, **changes):
        script = root / "fixture.sh"
        script.write_text(body, newline="\n")
        return run(["sh", str(script)], dict(env, **changes))

    # The real environment fragment must preserve an existing JAVA_HOME on failed/empty
    # lookup, replace it on success, and omit the lookup entirely for a skip override.
    mise = home / ".local/bin/mise"
    mise.parent.mkdir(parents=True, exist_ok=True)
    mise.write_text('#!/bin/sh\nprintf "%s" "$TEST_JAVA_RESULT"\nexit "$TEST_JAVA_RC"\n')
    mise.chmod(0o755)
    fragment = render("dot_config/agent-env/env.d/10-packages.sh.tmpl", osFlavour="linux", role="client")
    for result, rc, expected in (("", "1", "/existing"), ("", "0", "/existing"), ("/new-jdk", "0", "/new-jdk")):
        output = shell_fixture('JAVA_HOME=/existing; export JAVA_HOME\n' + fragment + '\nprintf "JAVA=%s\\n" "$JAVA_HOME"\n',
                               TEST_JAVA_RESULT=result, TEST_JAVA_RC=rc)
        assert "JAVA=" + expected in output, "JAVA_HOME lost on mise lookup"
    override = home / ".config/agent-env/versions.local.toml"
    override.parent.mkdir(parents=True, exist_ok=True)
    override.write_text('[overrides]\njava = "skip"\n')
    skipped = render("dot_config/agent-env/env.d/10-packages.sh.tmpl", osFlavour="linux", role="client")
    assert "mise\" where" not in skipped and "JAVA_HOME=" not in skipped
    override.unlink()
    mise.unlink()
    print("tools-test: JAVA_HOME failed/empty/success/skip fixtures passed")

    # Changed T3 versions must not inherit the default release's checksums, or mix
    # checksums from a lower-priority override block with a local version override.
    pins_repo = root / "pins-repo"
    pins_repo.mkdir()
    versions = (REPO / "versions.toml").read_text()
    (pins_repo / "versions.toml").write_text(versions)
    checksum_keys = ("macos_arm64", "macos_x64", "linux_arm64", "linux_x64", "deb_arm64", "deb_x64")
    version_override = 't3code = "0.0.0-fixture"\n'
    checksums = "".join('t3code_sha256_' + key + ' = "' + "a" * 64 + '"\n' for key in checksum_keys)
    pin_args = dict(repoDir=pins_repo.as_posix(), machine="tools-test")
    for body in (version_override, version_override + checksums.replace("a" * 64, "invalid", 1)):
        override.write_text("[overrides]\n" + body)
        render(".chezmoitemplates/packages/pins.json", expect_error="t3code version override requires", **pin_args)
    (pins_repo / "versions.toml").write_text(versions + '\n[overrides.tools-test]\n' + version_override + checksums)
    override.write_text("[overrides]\n" + version_override)
    render(".chezmoitemplates/packages/pins.json", expect_error="t3code version override requires", **pin_args)
    for local in (False, True):
        if local:
            override.write_text("[overrides]\n" + version_override + checksums)
        else:
            override.unlink()
        resolved = json.loads(render(".chezmoitemplates/packages/pins.json", **pin_args))["tools.t3code"]
        assert resolved["version"] == "0.0.0-fixture"
        assert all(resolved["sha256_" + key] == "a" * 64 for key in checksum_keys)
    override.write_text('[overrides]\nt3code = "skip"\n')
    assert json.loads(render(".chezmoitemplates/packages/pins.json", **pin_args))["tools.t3code"]["version"] == "skip"
    # A tool's own <name>_winget key survives its version override (Toolbox: 3.9.2 -> 3.9.2.0).
    override.write_text('[overrides]\ntoolbox = "3.9.2"\ntoolbox_winget = "3.9.2.0"\n')
    toolbox = json.loads(render(".chezmoitemplates/packages/pins.json", **pin_args))["tools.toolbox"]
    assert toolbox["version"] == "3.9.2" and toolbox["winget"] == "3.9.2.0", toolbox
    override.write_text('[overrides]\ntoolbox = "3.9.2"\n')
    assert json.loads(render(".chezmoitemplates/packages/pins.json", **pin_args))["tools.toolbox"]["winget"] == "3.9.2"
    override.unlink()
    print("tools-test: T3 overrides require valid checksums together at the winning precedence")
    print("tools-test: per-tool winget overrides survive a version override")

    # Run the real npm loop with a fake mise; parent counters must include every result.
    globals_script = render(".chezmoiscripts/run_onchange_before_13-packages-harnesses.sh.tmpl",
                            osFlavour="linux", role="client", harnesses=[])
    mise.write_text('#!/bin/sh\nexit "$TEST_NPM_RC"\n')
    mise.chmod(0o755)
    for rc, expected in (("0", "4 changed, 0 failed"), ("1", "0 changed, 4 failed")):
        script = root / "npm-globals.sh"
        script.write_text(globals_script, newline="\n")
        result = subprocess.run(["sh", str(script)], env=dict(env, AGENT_ENV_DRY_RUN="0", TEST_NPM_RC=rc),
                                capture_output=True, text=True, timeout=120)
        assert result.returncode == int(rc) and expected in result.stdout, result.stdout + result.stderr
    mise.unlink()
    print("tools-test: real Unix npm loop reports successes and failures in parent counters")

    # Keep the actual installer functions but suppress their top-level calls. Network
    # access is a hard error in the newer-version fixtures, including opted-in apt.
    for platform, rendered in desktop_scripts.items():
        definitions = rendered
        for name in ("t3code", "toolbox", "docker_desktop"):
            definitions = definitions.replace("\ninstall_" + name + "\n", "\n")
        definitions = definitions.split("\npk_finish 14-packages-desktop")[0]
        mocks = '''
pk_fetch() { echo 'unexpected download' >&2; exit 99; }
pk_appimage_version() { echo 999.0.0; }
pk_toolbox_latest() { PK_TOOLBOX_VERSION=999.0.0; PK_TOOLBOX_TARGET="$HOME/toolbox"; }
app_version() { echo 999.0.0; }
ln() { :; }
'''
        calls = "\ninstall_t3code\ninstall_toolbox\n"
        if platform == "macos":
            calls += "install_docker_desktop\n"
        shell_fixture(definitions + mocks + calls + '\n[ "$PK_CHANGED:$PK_FAILED" = 0:0 ]\n', AGENT_ENV_DRY_RUN="0", TEST_DPKG_VERSION="998.0.0")
        if platform == "linux":
            output = shell_fixture(definitions + '\ninstall_t3code\n', AGENT_ENV_DRY_RUN="1")
            assert ".deb" in output, "apt desktop did not select Debian asset"
            output = shell_fixture(definitions + '\nOPTIN=0\ninstall_t3code\n', AGENT_ENV_DRY_RUN="1")
            assert ".AppImage" in output, "non-opted-in desktop lost AppImage fallback"
    print("tools-test: newer macOS/Linux apps never download or downgrade; apt/fallback selection passed")

    # The arm64 archive's real layout and Toolbox's updater layout both supply build.txt.
    toolbox = home / ".local/share/jetbrains-toolbox/jetbrains-toolbox-3.9.1.89198-arm64/bin"
    toolbox.mkdir(parents=True)
    (toolbox / "jetbrains-toolbox").write_text("#!/bin/sh\nexit 99\n")
    (toolbox / "jetbrains-toolbox").chmod(0o755)
    (toolbox / "build.txt").write_text("3.9.1.89198\n")
    desktop_helpers = (REPO / "home/.chezmoitemplates/packages/desktop.sh").read_text()
    output = shell_fixture((REPO / "home/.chezmoitemplates/packages/lib.sh").read_text() + desktop_helpers +
                           '\npk_toolbox_latest\nprintf "%s:%s\\n" "$PK_TOOLBOX_TARGET" "$PK_TOOLBOX_VERSION"\n')
    assert "-arm64:3.9.1" in output
    print("tools-test: arm64 Toolbox metadata resolves the archive directory")
    # Extract a checksum-verified fake vendor archive through the real arm64 installer.
    archive = root / "toolbox.tar.gz"
    with tarfile.open(archive, "w:gz") as tar:
        tar.add(toolbox.parent, arcname=toolbox.parent.name)
    digest = hashlib.sha256(archive.read_bytes()).hexdigest()
    shutil.rmtree(toolbox.parent)
    linux_definitions = desktop_scripts["linux"]
    for name in ("t3code", "toolbox", "docker_desktop"):
        linux_definitions = linux_definitions.replace("\ninstall_" + name + "\n", "\n")
    extract_fixture = '''
ARCH=arm64
pk_fetch() {
  case "$1" in *.sha256) printf '%s\\n' "$TEST_DIGEST" > "$2" ;; *) cp "$TEST_ARCHIVE" "$2" ;; esac
}
ln() { :; }
install_toolbox
[ "$PK_CHANGED:$PK_FAILED" = 1:0 ]
'''
    shell_fixture(linux_definitions + extract_fixture, AGENT_ENV_DRY_RUN="0",
                  TEST_ARCHIVE=archive.as_posix(), TEST_DIGEST=digest)
    assert (toolbox / "jetbrains-toolbox").exists()
    print("tools-test: real arm64 Toolbox installer extracts and checks the suffixed archive path")

    # A bad Debian download must never reach apt; a verified one must use sudo apt-get.
    payload = b"fake Debian payload"
    digest = hashlib.sha256(payload).hexdigest()
    t3pins = tomllib.loads((REPO / "versions.toml").read_text())["tools"]["t3code"]
    deb_definitions = linux_definitions.replace(t3pins["sha256_deb_x64"], digest).replace(t3pins["sha256_deb_arm64"], digest)
    deb_fixture = '''
pk_fetch() { printf '%s' "$TEST_DEB_PAYLOAD" > "$2"; }
sudo() { printf '%s\\n' "$*" > "$TEST_APT_CALL"; }
install_t3code
printf 'RESULT=%s:%s\\n' "$PK_CHANGED" "$PK_FAILED"
'''
    apt_call = root / "apt-call"
    for content, expected in (("corrupt", "0:1"), (payload.decode(), "1:0")):
        output = shell_fixture(deb_definitions + deb_fixture, AGENT_ENV_DRY_RUN="0",
                               TEST_DEB_PAYLOAD=content, TEST_APT_CALL=apt_call.as_posix())
        assert "RESULT=" + expected in output
        assert apt_call.exists() == (expected == "1:0")
    assert "-n apt-get install -y " in apt_call.read_text() and ".deb" in apt_call.read_text()
    print("tools-test: Debian checksum failure blocks apt; verified payload reaches the opted-in install")

    # Exercise the real bundle copy against fake DMG utilities under the fake home.
    # A stale file must disappear, and an admin-writable directory must not use sudo.
    bundle_test = '''
PK_TMP="$HOME/dmg"; mkdir -p "$PK_TMP/mount" "$HOME/apps/Docker.app"
echo stale > "$HOME/apps/Docker.app/stale"
hdiutil() { if [ "$1" = attach ]; then mkdir -p "$PK_TMP/mount/Docker.app"; echo fresh > "$PK_TMP/mount/Docker.app/fresh"; fi; }
ditto() { cp -R "$1" "$2"; }
sudo() { echo 'unexpected sudo' >&2; return 99; }
install_dmg ignored "$HOME/apps" Docker.app
[ -f "$HOME/apps/Docker.app/fresh" ] && [ ! -e "$HOME/apps/Docker.app/stale" ]
'''
    mac_definitions = desktop_scripts["macos"]
    for name in ("t3code", "toolbox", "docker_desktop"):
        mac_definitions = mac_definitions.replace("\ninstall_" + name + "\n", "\n")
    shell_fixture(mac_definitions + bundle_test, AGENT_ENV_DRY_RUN="0")
    print("tools-test: DMG replacement removes stale bundle files without sudo on writable directories")

    # Verify's actual desktop block must warn for self-updates and fail missing/older.
    verify_source = (REPO / "scripts/verify.d/10-packages.sh").read_text()
    desktop_verify = verify_source.split('# Desktop apps:')[1].split('# System-managed tools:')[0]
    desktop_verify = '# Desktop apps:' + desktop_verify
    desktop_verify = desktop_verify.replace('/usr/libexec/PlistBuddy', 'plist')
    helpers = (REPO / 'home/.chezmoitemplates/packages/lib.sh').read_text()
    for have, want, expected in (("999.0.0", "1.0.0", "WARN"), ("1.0.0", "1.0.0", "OK"),
                                 ("0.9.0", "1.0.0", "FAIL"), ("", "1.0.0", "FAIL"), ("", "skip", "INFO")):
        prelude = '''
ROLE=client; OS=macos
_pk_pin() { echo "$TEST_WANT"; }
ae_toml_get() { echo 'T3 Code (Beta)'; }
plist() { echo "$TEST_HAVE"; }
ae_semver() { pk_semver "$1"; }
ae_ok() { echo "OK $*"; }; ae_warn() { echo "WARN $*"; }
ae_fail() { echo "FAIL $*"; }; ae_info() { echo "INFO $*"; }
'''
        output = shell_fixture(helpers + prelude + desktop_verify, REPO=REPO.as_posix(), TEST_HAVE=have, TEST_WANT=want)
        assert expected + " Docker Desktop" in output, output
        assert ("self-updated" in output) == (expected == "WARN")
        if expected != "FAIL":
            assert "FAIL" not in output
    print("tools-test: Unix desktop verify newer/equal/older/missing/skip fixtures passed")

    # Verify real AppImage artifacts with the same override precedence as installation.
    image_sums = {}
    for version in ("1.0.0", "2.0.0", "3.0.0"):
        image = home / (".local/share/t3code/" + version + "/T3-Code.AppImage")
        image.parent.mkdir(parents=True, exist_ok=True)
        image.write_text('#!/bin/sh\nmkdir -p squashfs-root\nprintf "X-AppImage-Version=' + version +
                         '\\n" > squashfs-root/fixture.desktop\n')
        image.chmod(0o755)
        image_sums[version] = hashlib.sha256(image.read_bytes()).hexdigest()
    verify_versions = root / "verify-versions.toml"
    base_pins = ('[tools.t3code]\nversion = "1.0.0"\ndeb_package = "fixture-t3code"\nsha256_linux_x64 = "' +
                 image_sums["1.0.0"] + '"\n[tools.toolbox]\nversion = "skip"\n')
    machine_override = ('\n[overrides.fixture]\nt3code = "2.0.0"\nt3code_sha256_linux_x64 = "' +
                        image_sums["2.0.0"].upper() + '"\n')
    common = (REPO / "scripts/lib/common.sh").read_text()
    verify_prelude = '''
ROLE=client; OS=linux; MACHINE=fixture; VERSIONS=$TEST_VERSIONS
_pk_local="$HOME/.config/agent-env/versions.local.toml"
_pk_pin() { ae_pin "$VERSIONS" "$1" "$2" "$MACHINE"; }
uname() { echo x86_64; }
'''
    for machine, local, version, good in (
        (False, None, "1.0.0", True),
        (True, None, "2.0.0", True),
        (True, 't3code = "3.0.0"\nt3code_sha256_linux_x64 = "' + image_sums["3.0.0"] + '"\n', "3.0.0", True),
        (True, 't3code = "3.0.0"\n', "3.0.0", False),
        (True, 't3code = "3.0.0"\nt3code_sha256_linux_x64 = "' + image_sums["2.0.0"] + '"\n', "3.0.0", False),
        (True, 't3code = "1.0.0"\n', "1.0.0", True),
    ):
        verify_versions.write_text(base_pins + (machine_override if machine else ""))
        if local is None:
            override.unlink(missing_ok=True)
        else:
            override.write_text("[overrides]\n" + local)
        output = shell_fixture(common + verify_prelude + desktop_verify,
                               REPO=REPO.as_posix(), TEST_VERSIONS=verify_versions.as_posix(), TEST_DPKG_VERSION="")
        expected = "OK    T3 Code (AppImage) " + version if good else "FAIL  T3 Code checksum differs"
        assert expected in output, output
    override.unlink()
    print("tools-test: AppImage verify base/machine/local checksums, case normalization, and failure paths passed")

    if WINDOWS:
        win11 = render(".chezmoiscripts/run_onchange_before_11-packages-winget.ps1.tmpl", osFlavour="windows", role="client", headless=False)
        win14 = render(".chezmoiscripts/run_onchange_before_14-packages-desktop.ps1.tmpl", osFlavour="windows", role="client", headless=False)
        for app in ("T3Tools.T3Code", "Docker.DockerDesktop", "JetBrains.Toolbox"):
            assert "Id = '" + app + "'" not in win11 and "Id = '" + app + "'" in win14
        override.write_text('[overrides]\njava = "25.0.4.1"\njava_winget = "25.0.4.101"\njava_mise = "temurin-25.0.4+101.0.LTS"\n')
        java11 = render(".chezmoiscripts/run_onchange_before_11-packages-winget.ps1.tmpl", osFlavour="windows", role="client", headless=False)
        assert "Pin = '25.0.4.101'; ProbePin = '25.0.4.1'" in java11
        override.unlink()
        ps_fixture = root / "verify-fixture.ps1"
        verify = (REPO / "scripts/verify.d/10-packages.ps1").read_text()
        block = verify.split('# winget.txt tools at their pins.')[1].split('# Python 3.12 through uv.')[0]
        ps_helpers = (REPO / "home/.chezmoitemplates/packages/lib.ps1").read_text()
        # A tool on PATH can be unmanaged; only WinGet's inventory selects upgrade.
        winget_loop = (REPO / "home/.chezmoitemplates/packages/winget-run.ps1").read_text()
        ps_fixture.write_text(ps_helpers + '''
$env:AGENT_ENV_DRY_RUN = '0'
$items = @(@{ Id='Fixture.Tool'; Name='fixture'; Pin='2.0.0'; Exe='fixture'; Args=@(); Scope='user'; Match='exact' })
$packageRole = 'client'; $optin = '0'; $script:installed = $false
function Pk-Version { if ($script:installed) { '2.0.0' } else { '1.0.0' } }
function Pk-RefreshPath { }
function winget {
    if ($args[0] -eq 'list') { $global:LASTEXITCODE = [int]$env:TEST_INVENTORY_RC; return }
    if ($args[0] -ne $env:TEST_VERB) { throw 'wrong WinGet operation' }
    $script:installed = $true; $global:LASTEXITCODE = 0
}
''' + winget_loop + "\nif ($script:PkChanged -ne 1 -or $script:PkFailed -ne 0) { throw 'winget did not install' }\n", newline="\n")
        for rc, verb in (("0", "upgrade"), ("1", "install")):
            run(["powershell", "-NoProfile", "-ExecutionPolicy", "Bypass", "-File", str(ps_fixture)],
                dict(env, TEST_INVENTORY_RC=rc, TEST_VERB=verb))

        # Exercise npm's completion check with a fake manifest and optional command shim.
        harnesses = render(".chezmoiscripts/run_onchange_before_13-packages-harnesses.ps1.tmpl",
                           osFlavour="windows", role="client", harnesses=[])
        npm_loop = harnesses.split('foreach ($it in $npmItems)')[1].split("Pk-Finish '13-packages-harnesses'")[0]
        for rc, shim, failures in (("0", "0", 1), ("1", "1", 1), ("0", "1", 0)):
            ps_fixture.write_text(ps_helpers + '''
$env:AGENT_ENV_DRY_RUN = '0'
$npmItems = @(@{ Package='fixture'; Pin='1.0.0'; Cmd='fixture' })
function Get-Command { return $true }
function npm.cmd {
    New-Item -ItemType Directory -Force -Path (Join-Path $env:APPDATA 'npm/node_modules/fixture') | Out-Null
    [IO.File]::WriteAllText((Join-Path $env:APPDATA 'npm/node_modules/fixture/package.json'), '{"version":"1.0.0"}')
    if ($env:TEST_SHIM -eq '1') { [IO.File]::WriteAllText((Join-Path $env:APPDATA 'npm/fixture.cmd'), '') }
    $global:LASTEXITCODE = [int]$env:TEST_NPM_RC
}
foreach ($it in $npmItems)''' + npm_loop + '''
if ($script:PkFailed -ne [int]$env:TEST_FAILURES -or $script:PkChanged -ne (1 - [int]$env:TEST_FAILURES)) { throw 'incorrect npm result' }
''', newline="\n")
            fixture_shim = Path(env["APPDATA"]) / "npm/fixture.cmd"
            fixture_shim.unlink(missing_ok=True)
            fixture_manifest = Path(env["APPDATA"]) / "npm/node_modules/fixture/package.json"
            fixture_manifest.unlink(missing_ok=True)
            run(["powershell", "-NoProfile", "-ExecutionPolicy", "Bypass", "-File", str(ps_fixture)],
                dict(env, TEST_NPM_RC=rc, TEST_SHIM=shim, TEST_FAILURES=str(failures)))

        # Run only the PATH snapshot block against fake backup directories, never HKCU.
        path_script = render(".chezmoiscripts/run_onchange_before_10-packages-path.ps1.tmpl",
                             osFlavour="windows", role="client", headless=False)
        snapshot_block = path_script.split('    # The tools stage can run before scripts/backup. Keep earlier snapshots intact.\n')[1].split('    $new =')[0]
        ps_fixture.write_text("$ErrorActionPreference = 'Stop'\n$backupRoot = $env:TEST_BACKUPS\n$raw = 'before-first'\n" +
                              snapshot_block + "\n$raw = 'before-second'\n" + snapshot_block, newline="\n")
        backups = root / "path-backups"
        prior = backups / "20260101T000000Z"
        prior.mkdir(parents=True)
        snapshot = prior / "user-path-before-packages.txt"
        snapshot.write_text("original")
        run(["powershell", "-NoProfile", "-ExecutionPolicy", "Bypass", "-File", str(ps_fixture)],
            dict(env, TEST_BACKUPS=str(backups)))
        assert snapshot.read_text() == "original"
        assert sorted(p.read_text() for p in prior.glob("*.txt")) == ["before-first", "before-second", "original"]
        print("tools-test: Windows inventory, npm exit/shim, and non-overwriting PATH snapshot fixtures passed")

        # Drive the actual bootstrap entry point with harmless PowerShell commands.
        # A missing custom binary must switch to the user-scoped installed command.
        ps_fixture.write_text('''
$ErrorActionPreference = 'Stop'
$env:AGENT_ENV_DRY_RUN = '0'
$env:AGENT_ENV_CHEZMOI = Join-Path $env:USERPROFILE 'missing-chezmoi.exe'
$env:TEST_BOOTSTRAPPED = '0'
function winget {
    $scope = [Array]::IndexOf($args, '--scope')
    if ($scope -lt 0 -or $args[$scope + 1] -ne 'user') { throw 'bootstrap requires user scope' }
    $env:TEST_BOOTSTRAPPED = '1'
    $global:LASTEXITCODE = 0
}
function chezmoi { $global:LASTEXITCODE = 0 }
& (Join-Path $env:TEST_REPO 'scripts/install-tools.ps1') -Role $env:TEST_ROLE -Machine tools-test
if ($env:TEST_BOOTSTRAPPED -ne '1') { throw 'bootstrap not exercised' }
''', newline="\n")
        for role, optin in (("server", "1"), ("client", "0"), ("client", "1")):
            run(["powershell", "-NoProfile", "-ExecutionPolicy", "Bypass", "-File", str(ps_fixture)],
                dict(env, TEST_REPO=str(REPO), TEST_ROLE=role, AGENT_ENV_SYSTEM_PACKAGES=optin))
        print("tools-test: real Windows entry point bootstraps user scope on server and client roles")

        # Preserve Java's fourth runtime component rather than comparing the MSI ID.
        ps_fixture.write_text(ps_helpers + '''
function java { Write-Output 'openjdk 25.0.4.1 2026-10-20 LTS'; $global:LASTEXITCODE = 0 }
if ((Pk-Version 'java' @('--version')) -ne '25.0.4.1') { throw 'Java runtime component lost' }
''', newline="\n")
        run(["powershell", "-NoProfile", "-ExecutionPolicy", "Bypass", "-File", str(ps_fixture)], env)
        for have, expected in (("25.0.4.1", "OK java"), ("25.0.4", "WARN java")):
            ps_fixture.write_text(ps_helpers + '''
$Role = 'client'; $Repo = $env:TEST_REPO
function Pk-PinOf {
    param($area, $name, $key)
    if ($name -ne 'java') { return 'skip' }
    if ($key -eq 'winget') { return '25.0.4.101' }
    return '25.0.4.1'
}
function Pk-Version { return $env:TEST_HAVE }
function Ae-Ok { param($m) Write-Output "OK $m" }
function Ae-Warn { param($m) Write-Output "WARN $m" }
function Ae-Fail { param($m) throw $m }
function Ae-Info { }
''' + block, newline="\n")
            output = run(["powershell", "-NoProfile", "-ExecutionPolicy", "Bypass", "-File", str(ps_fixture)],
                         dict(env, TEST_HAVE=have, TEST_REPO=str(REPO)))
            assert expected in output
        print("tools-test: Java runtime probe and verify preserve the fourth version component")

        for have, verdict in (("999.0.0", "WARN"), ("0.0.1", "FAIL"), ("", "FAIL")):
            ps_fixture.write_text(ps_helpers + '''
$Role = 'client'
function Pk-PinOf { return '1.0.0' }
function Pk-Version { return $env:TEST_HAVE }
function Ae-Ok { param($m) Write-Output "OK $m" }
function Ae-Warn { param($m) Write-Output "WARN $m" }
function Ae-Fail { param($m) Write-Output "FAIL $m" }
function Ae-Info { param($m) Write-Output "INFO $m" }
$Repo = $env:TEST_REPO
''' + block, newline="\n")
            output = run(["powershell", "-NoProfile", "-ExecutionPolicy", "Bypass", "-File", str(ps_fixture)],
                         dict(env, TEST_HAVE=have, TEST_REPO=str(REPO)))
            for name in ("t3code", "toolbox", "docker-desktop"):
                assert verdict + " " + name in output, output
            assert ("self-updated" in output) == (verdict == "WARN")
        print("tools-test: Windows script ordering, separate Java override, desktop verify drift fixtures passed")

        # Real @docker-desktop file probe, against a harmless copied executable's metadata.
        docker = root / "program-files/Docker/Docker/Docker Desktop.exe"
        docker.parent.mkdir(parents=True)
        shutil.copyfile(CZ, docker)
        preflight = (REPO / "scripts/preflight.d/10-packages.ps1").read_text()
        machine_block = preflight.split('$pkMachine = @()')[1].split('# Git Bash:')[0]
        ps_fixture.write_text(ps_helpers + '''
$Repo = $env:TEST_REPO; $Role = 'client'
function Get-Command { param($name) if ($name.StartsWith('@')) { throw 'pseudo-probe used as command' }; return $true }
function Ae-Ok { param($m) Write-Output "OK $m" }
function Ae-Warn { param($m) throw $m }
function Ae-Hint { param($m) throw $m }
$pkMachine = @()
''' + machine_block, newline="\n")
        output = run(["powershell", "-NoProfile", "-ExecutionPolicy", "Bypass", "-File", str(ps_fixture)],
                     dict(env, TEST_REPO=str(REPO), ProgramFiles=str(root / "program-files")))
        assert "OK per-machine packages" in output and "docker-desktop" in output and "java" in output
        print("tools-test: Windows preflight accepts installed Docker metadata and lists every machine package")

    if not WINDOWS:
        # Exercise the whole production entry point with fake sudo/chezmoi/mise only.
        # No scripts are applied. The sudo loop's PID must be gone after its EXIT trap.
        for name, body in {
            "sudo": '#!/bin/sh\nif [ "$1" = -v ]; then exit 0; fi\necho "$PPID" > "$TEST_SUDO_PID"\n',
            "chezmoi": '#!/bin/sh\nsleep 0.2\n',
        }.items():
            path = fakebin / name
            path.write_text(body)
            path.chmod(0o755)
        mise.write_text("#!/bin/sh\nexit 0\n")
        mise.chmod(0o755)
        installer = root / "fake-installer"
        installer.write_text('''#!/bin/sh
while [ "$#" -gt 0 ]; do
  if [ "$1" = -b ]; then shift; mkdir -p "$1"; cp "$TEST_CHEZMOI_STUB" "$1/chezmoi"; chmod 755 "$1/chezmoi"; exit; fi
  shift
done
exit 99
''')
        curl = fakebin / "curl"
        curl.write_text('''#!/bin/sh
while [ "$#" -gt 0 ]; do
  if [ "$1" = -o ]; then shift; cp "$TEST_INSTALLER" "$1"; exit; fi
  shift
done
exit 99
''')
        curl.chmod(0o755)
        pidfile = root / "sudo-pid"
        for executable in (fakebin / "chezmoi", root / "missing-chezmoi"):
            pidfile.unlink(missing_ok=True)
            run(["sh", str(REPO / "scripts/install-tools"), "--role", "client", "--machine", "tools-test"],
                dict(env, AGENT_ENV_DRY_RUN="0", AGENT_ENV_CHEZMOI=str(executable), TEST_SUDO_PID=str(pidfile),
                     TEST_INSTALLER=str(installer), TEST_CHEZMOI_STUB=str(fakebin / "chezmoi")))
            sudo_pid = int(pidfile.read_text())
            try:
                os.kill(sudo_pid, 0)
            except ProcessLookupError:
                pass
            else:
                raise AssertionError("sudo keepalive survived tools-stage exit/bootstrap")
        mise.unlink()
        print("tools-test: opted-in Unix entry point stops its sudo keepalive with existing or bootstrapped chezmoi")

    if WINDOWS:
        pins = tomllib.loads((REPO / "versions.toml").read_text())
        pin = pins["tools"]["maven"]["version"]
        # A fake installed archive proves the launcher path and second-run no-op.
        # The script must never enter its downloader for this fixture.
        stub = home / (".local/share/maven/apache-maven-" + pin + "/bin/mvn.cmd")
        stub.parent.mkdir(parents=True)
        stub.write_bytes(("@echo off\r\necho Apache Maven " + pin + "\r\n").encode("ascii"))
        data.update(osFlavour="windows", role="client", headless=False)
        cfg.write_text("[data]\n" + "\n".join(k + " = " + json.dumps(v) for k, v in data.items()))
        rendered = run([CZ, "--source", str(source), "--config", str(cfg),
                        "--destination", str(home), "--persistent-state", str(root / "state"),
                        "--cache", str(root / "cache"), "execute-template", "--file",
                        str(source / ".chezmoiscripts/run_onchange_before_12-packages-development.ps1.tmpl")], env)
        script = root / "maven.ps1"
        script.write_text(rendered, newline="\n")
        live_env = dict(env, AGENT_ENV_DRY_RUN="0")
        args = ["powershell", "-NoProfile", "-ExecutionPolicy", "Bypass", "-File", str(script)]
        run(args, live_env)
        installed = manifest(home)
        output = run(args, live_env)
        assert "0 changed, 0 failed" in output and manifest(home) == installed
        launcher = home / ".local/bin/mvn.cmd"
        assert pin in launcher.read_text()
        output = run(["cmd", "/d", "/c", str(launcher)], live_env)
        assert ("Apache Maven " + pin) in output
        print("tools-test: Windows Maven fixture resolves the pin; second run changes nothing")

        # A failed install must leave a working launcher from the previous pin intact.
        prior_launcher = b'@echo off\r\necho prior Maven\r\n'
        launcher.write_bytes(prior_launcher)
        stub.unlink()
        script.write_text("function Invoke-WebRequest { throw 'fixture download failed' }\n" + rendered, newline="\n")
        failed = subprocess.run(args, env=dict(live_env, TEMP=str(root / "runtime"), TMP=str(root / "runtime")),
                                capture_output=True, text=True, timeout=120)
        assert failed.returncode == 1 and "0 changed, 1 failed" in failed.stdout, failed.stdout + failed.stderr
        assert launcher.read_bytes() == prior_launcher, "failed Maven download replaced the prior launcher"
        print("tools-test: failed Maven install preserves the previous launcher and reports no changes")


    pins = tomllib.loads((REPO / "versions.toml").read_text())
    refs = tomllib.loads((REPO / "packages/mise-tools.toml").read_text())["tools"]
    for name in ("node", "java", "maven", "ripgrep", "uv", "gh"):
        area, key = refs[name].split(".")
        assert pins[area][key]["version"] and pins[area][key]["source"].startswith("https://")
    java = pins["tools"]["java"]
    def check_java(platform):
        url = "https://mise-java.jdx.dev/jvm/ga/" + platform + ".json"
        try:
            request = urllib.request.Request(url, headers={"User-Agent": "agent-env-pin-check"})
            with urllib.request.urlopen(request, timeout=15) as response:
                metadata = json.load(response)
        except (OSError, ValueError):
            # Some corporate proxies cache a forbidden response for the bare URL.
            try:
                with urllib.request.urlopen(url + "?agent-env-pin-check=1", timeout=15) as response:
                    metadata = json.load(response)
            except (OSError, ValueError):
                return "tools-test: Java metadata unavailable: skipped " + platform
        matches = [entry for entry in metadata
                   if entry["vendor"] + "-" + entry["version"] == java["mise"]
                   and entry["image_type"] == "jdk" and not entry.get("features")]
        assert matches, "unknown mise Java ID on " + platform + ": " + java["mise"]
        assert any(entry["java_version"].split("+")[0] == java["version"] for entry in matches), "Java runtime/mise mismatch"
        return "tools-test: Java ID and runtime verified against " + platform
    with ThreadPoolExecutor(max_workers=4) as executor:
        for result in executor.map(check_java, ("linux/x86_64", "linux/aarch64", "macosx/x86_64", "macosx/aarch64")):
            print(result)
    print("tools-test: shared development-tool references resolve to sourced pins")
