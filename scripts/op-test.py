"""Exercise 1Password flows with fake op only; never use the real account or home.

Run with Python 3.11+ from Git Bash or WSL. All subprocess output stays captured so
an assertion cannot display a generated test key. Scratch files live under .tools/.
"""
import json
import os
from pathlib import Path
import shutil
import subprocess
import sys
import tempfile

REPO = Path(__file__).resolve().parent.parent

FAKE = r'''
import json, os, sys
from pathlib import Path
a = sys.argv[1:]
data = sys.stdin.read()  # Hangs if the caller inherits the test's deliberately open pipe.
root = Path(os.environ['FAKE_OP_ROOT'])
with (root / 'calls').open('a') as f:
    f.write(json.dumps(a) + '\n')
if os.environ.get('OP_SERVICE_ACCOUNT_TOKEN') != 'fake-service-token':
    sys.exit(93)
if a[:2] == ['item', 'create']:
    assert a[-1] == '-'
    item = json.loads(data)
    assert item['title'] == 'cpa-client-device'
    (root / 'item.json').write_text(json.dumps(item))
elif data:
    sys.exit(94)
elif a == ['--version']:
    print('2.41.1')
elif a == ['whoami'] or a[:2] == ['vault', 'get']:
    pass
elif a[:2] == ['vault', 'list']:
    if os.environ.get('FAKE_SCOPE') == 'failure':
        sys.exit(95)
    vaults = [{'id': 'device-vault'}]
    if os.environ.get('FAKE_SCOPE') == 'broad':
        vaults.append({'id': 'admin-vault'})
    print(json.dumps(vaults))
elif a[:2] == ['item', 'list']:
    items = [{'title': 'cpa-client-device'}]
    if '--vault' not in a:
        if not os.environ.get('FAKE_ROSTER_MISSING'):
            items.append({'title': 'cpa-client-remote-device'})
    elif 'admin-vault' in a:
        items = [{'title': 'owner-only-test-item'}]
    print(json.dumps(items))
elif a[:2] == ['item', 'get']:
    sys.exit(0 if (root / 'item.json').exists() else 1)
elif a[:3] == ['item', 'template', 'get']:
    print(json.dumps({'fields': [{'id': 'credential', 'value': ''}]}))
elif a[:1] == ['read']:
    if os.environ.get('FAKE_READ_FAIL'):
        sys.exit(96)
    item = json.loads((root / 'item.json').read_text())
    print(item['fields'][0]['value'])
else:
    sys.exit(97)
'''


def run(args, env):
    # Keep the parent's pipe open while waiting. A child that inherits it instead of
    # closing op's stdin hangs here, reproducing the agent-host pipe failure.
    p = subprocess.Popen(args, env=env, stdin=subprocess.PIPE, stdout=subprocess.PIPE,
                         stderr=subprocess.PIPE, text=True, encoding='utf-8')
    try:
        p.wait(timeout=15)
    except subprocess.TimeoutExpired:
        p.kill()
        p.communicate()
        raise AssertionError('subprocess timed out; check explicit op stdin') from None
    out, err = p.communicate()
    return p.returncode, out + err


def token_consumers(root, env, fakebin, suffix='', mocked_loader=None):
    """Run verify startup and the runbook loaders with a fake chezmoi and saved environment."""
    fake = root / 'fake-chezmoi.py'
    fake.write_text("""
import os, sys
args = sys.argv[1:]
if args == ['--version']:
    print('chezmoi version v2.74.0')
elif args[:1] == ['execute-template']:
    for key, value in [('role', 'client'), ('machine', 'device'), ('opMode', 'service')]:
        if args[1] == '{{ .' + key + ' }}':
            print(value)
elif args == ['source-path']:
    print(os.environ['TEST_REPO'])
elif args[:1] in [['verify'], ['apply'], ['status']]:
    ready = (os.environ.get('OP_SERVICE_ACCOUNT_TOKEN') == 'fake-service-token' and
             os.environ.get('CPA_APP_DIR') == os.environ.get('TEST_CPA_DIR'))
    sys.exit(0 if ready else 98)
else:
    sys.exit(99)
""", encoding='ascii')
    (fakebin / 'chezmoi').write_text(
        '#!/bin/sh\nexec "' + Path(sys.executable).as_posix() + '" -I "' +
        fake.as_posix() + '" "$@"\n', encoding='ascii', newline='\n')
    (fakebin / 'chezmoi').chmod(0o700)
    if os.name == 'nt':
        (fakebin / 'chezmoi.cmd').write_text(
            '@echo off\n"' + sys.executable + '" -I "' + str(fake) + '" %*\n',
            encoding='ascii', newline='\r\n')
    env['TEST_REPO'] = str(REPO)
    source = (REPO / ('scripts/verify' + suffix)).read_text()
    runbook = (REPO / 'AGENTS.md').read_text()
    env['TEST_CPA_DIR'] = str(root / 'saved-cpa-dir')
    env.pop('CPA_APP_DIR', None)
    if suffix:
        saved_path = root / 'load-cpa-dir.ps1'
        saved_path.write_text((REPO / 'scripts/lib/load-cpa-dir.ps1').read_text().replace(
            "[Environment]::GetEnvironmentVariable('CPA_APP_DIR', 'User')", "$env:TEST_CPA_DIR"),
            encoding='ascii', newline='\n')
        prefix = source[:source.index("Ae-Section 'Harnesses'")]
        prefix = prefix.replace('$PSScriptRoot', "'" + (REPO / 'scripts').as_posix() + "'")
        prefix = prefix.replace("(Join-Path '" + (REPO / 'scripts').as_posix() +
                                "' 'lib/load-token.ps1')", "'" + mocked_loader.as_posix() + "'")
        prefix = prefix.replace("(Join-Path '" + (REPO / 'scripts').as_posix() +
                                "' 'lib/load-cpa-dir.ps1')", "'" + saved_path.as_posix() + "'")
        summary = '\nif ($script:AeFail -gt 0) { exit 1 }\n'
        cmd = ['powershell.exe', '-NoProfile', '-NonInteractive', '-ExecutionPolicy', 'Bypass', '-File']
        # Exercise the actual inline reads. Registry reads alone are mocked, never persisted.
        reads = '\n'.join(line for line in runbook.split('### 5. Apply')[1].splitlines()
                          if line.startswith(('if (', '$opMode =')))
        assert '.ps1' not in reads
        reads = reads.replace("[Environment]::GetEnvironmentVariable('OP_SERVICE_ACCOUNT_TOKEN','User')",
                              '$env:TEST_PERSISTED_TOKEN').replace(
            "[Environment]::GetEnvironmentVariable('CPA_APP_DIR','User')", '$env:TEST_CPA_DIR')
        apply = reads + '\nchezmoi apply --force --no-tty\nexit $LASTEXITCODE\n'
        status = reads + '\nchezmoi status\nexit $LASTEXITCODE\n'
    else:
        path_file = Path(env['HOME']) / '.config/agent-env/cpa-app-dir'
        path_file.parent.mkdir(parents=True, exist_ok=True)
        path_file.write_text(env['TEST_CPA_DIR'] + '\n')
        path_file.chmod(0o600)
        prefix = source[:source.index('ae_section "Harnesses"')]
        repo_line = next(line for line in prefix.splitlines() if line.startswith('REPO='))
        prefix = prefix.replace(repo_line, "REPO='" + REPO.as_posix() + "'")
        summary = '\n[ "$AE_FAIL" -eq 0 ]\n'
        cmd = ['sh']
        block = runbook.split('### 5. Apply')[1].split('```sh\n', 1)[1].split('```', 1)[0]
        apply = block.replace('<account|service>', 'service').replace(
            '. scripts/lib/', ". '" + (REPO / 'scripts/lib').as_posix() + '/')
        # Close the quoted absolute source paths without changing the runbook's logic.
        apply = apply.replace('load-token.sh\n', "load-token.sh'\n").replace(
            'load-cpa-dir.sh\n', "load-cpa-dir.sh'\n")
        status = apply.replace('chezmoi apply --force --no-tty', 'chezmoi status')
    for label, content in [('verify-startup', prefix + summary), ('apply-loader', apply),
                           ('status-loader', status)]:
        script = root / (label + (suffix or '.sh'))
        script.write_text(content, encoding='ascii', newline='\n')
        code, output = run(cmd + [str(script)], env)
        assert code == 0, label + ' did not load saved token before chezmoi'
        assert 'fake-service-token' not in output, label + ' printed saved token'
    if suffix:
        # The owner/agent session can stay Restricted: these are inline commands, not a .ps1.
        restricted = ['powershell.exe', '-NoProfile', '-NonInteractive', '-ExecutionPolicy',
                      'Restricted', '-Command']
        code, output = run(restricted + [apply], env)
        assert code == 0, 'inline apply loader failed under Restricted policy'
        assert 'fake-service-token' not in output, 'inline apply printed saved token'
        account = reads.replace("$opMode = 'service'", "$opMode = 'account'")
        account += '\nif (Test-Path Env:OP_SERVICE_ACCOUNT_TOKEN) { exit 1 }\n'
        env['OP_SERVICE_ACCOUNT_TOKEN'] = 'fake-service-token'
        code, _ = run(restricted + [account], env)
        env.pop('OP_SERVICE_ACCOUNT_TOKEN')
        assert code == 0, 'account mode loaded or retained a service token'
    # A process override wins over the persisted value.
    env['CPA_APP_DIR'] = env['TEST_CPA_DIR'] + '-override'
    if suffix:
        override = ". '" + saved_path.as_posix() + "'\nAe-LoadCpaDir\nif ($env:CPA_APP_DIR -ne ($env:TEST_CPA_DIR + '-override')) { exit 1 }\n"
    else:
        override = ". '" + (REPO / 'scripts/lib/load-cpa-dir.sh').as_posix() + "'\nae_load_cpa_dir && [ \"$CPA_APP_DIR\" = \"$TEST_CPA_DIR-override\" ]\n"
    script.write_text(override, encoding='ascii', newline='\n')
    code, _ = run(cmd + [str(script)], env)
    assert code == 0, 'CPA path loader replaced a process override'
    env.pop('CPA_APP_DIR')
    for name in ['chezmoi', 'chezmoi.cmd']:
        (fakebin / name).unlink(missing_ok=True)
    print('op-test: ' + (suffix or 'sh') + ' saved token/path reach verify, apply, status; process path wins')


def owner_prompt(root, env):
    """Paste the documented no-echo block into a real Unix terminal, then interrupt it."""
    import pty
    import re
    import select
    import signal
    import termios
    import time

    doc = (REPO / 'docs/cpa.md').read_text()
    block = doc[doc.index("# Run in the owner's terminal"):].split('```', 1)[0]
    def prompt_reached(data):
        clean = re.sub(rb'\x1b\[[0-9;?]*[A-Za-z]', b'', data).replace(b'\r', b'')
        return b'\nOP_SERVICE_ACCOUNT_TOKEN: ' in clean

    for interrupt in [False, True]:
        home = root / ('prompt-interrupt' if interrupt else 'prompt-success')
        home.mkdir()
        pid, master = pty.fork()
        if pid == 0:
            child_env = dict(env, HOME=str(home), PS1='test-prompt> ', HISTFILE='/dev/null', TERM='dumb')
            child_env.pop('OP_SERVICE_ACCOUNT_TOKEN', None)
            os.execvpe('bash', ['bash', '--noprofile', '--norc', '-i'], child_env)
        output = b''
        try:
            # Wait for the interactive shell, then paste only the compound command.
            deadline = time.monotonic() + 5
            while b'test-prompt> ' not in output and time.monotonic() < deadline:
                if select.select([master], [], [], 0.05)[0]:
                    output += os.read(master, 65536)
            output = b''
            os.write(master, block.encode())
            deadline = time.monotonic() + 5
            while not prompt_reached(output) and time.monotonic() < deadline:
                if select.select([master], [], [], 0.05)[0]:
                    output += os.read(master, 65536)
            assert prompt_reached(output), 'owner prompt not reached'
            assert not termios.tcgetattr(master)[3] & termios.ECHO, 'owner prompt did not disable echo'
            output = b''
            os.write(master, b'\x03' if interrupt else b'prompt-test-token\n')
            deadline = time.monotonic() + 5
            while b'test-prompt> ' not in output and time.monotonic() < deadline:
                if select.select([master], [], [], 0.05)[0]:
                    output += os.read(master, 65536)
            assert b'test-prompt> ' in output, 'owner prompt closed the shell'
            # Bash readline itself disables ECHO. Check it during an executed command.
            os.write(master, b"stty -a; printf '\\157wner-shell-alive\\n'\n")
            deadline = time.monotonic() + 5
            while b'owner-shell-alive\r\n' not in output and time.monotonic() < deadline:
                if select.select([master], [], [], 0.05)[0]:
                    output += os.read(master, 65536)
            assert b'owner-shell-alive\r\n' in output, 'owner prompt closed the shell'
            flags = output.decode().split()
            assert '-echo' not in flags and 'echo' in flags, 'owner prompt did not restore echo'
            assert b'prompt-test-token' not in output, 'owner prompt echoed token'
            token = home / '.config/op/agent-env-token'
            if interrupt:
                assert not token.exists(), 'interrupted prompt persisted token'
            else:
                assert token.read_text().strip() == 'prompt-test-token', 'owner prompt did not persist token'
                assert token.stat().st_mode & 0o777 == 0o600, 'owner prompt token mode'
        finally:
            os.close(master)
            os.kill(pid, signal.SIGKILL)
            os.waitpid(pid, 0)
    print('op-test: owner no-echo prompt persists mode 0600; Ctrl-C restores echo and keeps shell open')


def main():
    tools = REPO / '.tools'
    tools.mkdir(exist_ok=True)
    with tempfile.TemporaryDirectory(prefix='op-test-', dir=tools) as tmp:
        root = Path(tmp)
        if os.name != 'nt':
            # DrvFs cannot prove Unix file modes; use native temporary storage, as below.
            with tempfile.TemporaryDirectory(prefix='agent-env-prompt-') as prompt_tmp:
                owner_prompt(Path(prompt_tmp), {k: v for k, v in os.environ.items()
                                              if not k.startswith(('OP_', 'AGENT_ENV_', 'CPA_'))})
        fakebin = root / 'bin'
        fakebin.mkdir()
        fake = root / 'fake-op.py'
        fake.write_text(FAKE, encoding='utf-8')
        # Both native Python/PowerShell and POSIX sh must resolve the fake first.
        (fakebin / 'op').write_text(
            '#!/bin/sh\nexec "' + Path(sys.executable).as_posix() + '" -I "' +
            fake.as_posix() + '" "$@"\n', encoding='utf-8', newline='\n')
        (fakebin / 'op').chmod(0o700)
        if os.name == 'nt':
            (fakebin / 'op.cmd').write_text(
                '@echo off\n"' + sys.executable + '" -I "' + str(fake) + '" %*\n',
                encoding='ascii', newline='\r\n')
        env = {k: v for k, v in os.environ.items()
               if not k.startswith(('OP_', 'AGENT_ENV_', 'CPA_'))}
        emptyhome = root / 'empty-home'
        emptyhome.mkdir()
        env.update(HOME=str(emptyhome), PATH=str(fakebin) + os.pathsep + env['PATH'],
                   OP_SERVICE_ACCOUNT_TOKEN='fake-service-token', FAKE_OP_ROOT=str(root))
        assert Path(shutil.which('op', path=env['PATH'])).parent == fakebin

        hub = root / 'hub'
        (hub / 'cpa-core').mkdir(parents=True)
        gui = hub / 'config.toml'
        core = hub / 'cpa-core/config.yaml'
        gui.write_text('api-keys = [{ key = "test-bootstrap-value", remark = "hub" }]\n')
        core.write_text("access:\n  api-keys:\n    - 'test-bootstrap-value'\n")
        env['CPA_APP_DIR'] = str(hub)
        mint = [sys.executable, '-I', str(REPO / 'home/dot_cpa-tools/mint_client_key.py'),
                'device', '--vault', 'agent-env-device']
        before = gui.read_bytes(), core.read_bytes()
        code, _ = run(mint + ['--dry-run'], env)
        assert code == 0 and not (root / 'item.json').exists(), 'mint dry run'
        assert before == (gui.read_bytes(), core.read_bytes()), 'dry run changed hub'
        code, output = run(mint, env)
        assert code == 0, 'mint with service token and open parent stdin'
        item = json.loads((root / 'item.json').read_text())
        key = item['fields'][0]['value']
        assert key in gui.read_text() and key in core.read_text(), 'mint did not register key'
        assert key not in output, 'mint printed key'
        code, _ = run(mint, env)
        assert code != 0, 'mint accepted duplicate item'
        (root / 'item.json').unlink()
        env['FAKE_READ_FAIL'] = '1'
        before = gui.read_bytes(), core.read_bytes()
        code, _ = run(mint, env)
        assert code != 0 and before == (gui.read_bytes(), core.read_bytes()), 'failed read registered key'
        del env['FAKE_READ_FAIL']
        print('op-test: mint dry-run, create/read/register, duplicate and read failure passed')

        # Run the real 1Password preflight section in isolation: no network, installed
        # configs, Tailscale, packages, desktop app, or real home are consulted.
        for suffix in ['', '.ps1']:
            if suffix and os.name != 'nt':
                continue
            source = (REPO / ('scripts/preflight' + suffix)).read_text()
            if suffix:
                start, end = "Ae-Section '1Password (op)'", "Ae-Section 'Tailscale and hub'"
                section = source[source.index(start):source.index(end)]
                section = section.replace("(Join-Path $PSScriptRoot 'lib/load-token.ps1')", "'" + (REPO / 'scripts/lib/load-token.ps1').as_posix() + "'")
                # Mock only the registry read; never touch the host's User token.
                loader = (REPO / 'scripts/lib/load-token.ps1').read_text().replace(
                    "[Environment]::GetEnvironmentVariable('OP_SERVICE_ACCOUNT_TOKEN', 'User')", "$env:TEST_PERSISTED_TOKEN")
                mocked_loader = root / 'load-token.ps1'
                mocked_loader.write_text(loader, encoding='ascii', newline='\n')
                section = section.replace((REPO / 'scripts/lib/load-token.ps1').as_posix(), mocked_loader.as_posix())
                bootstrap = (
                    ". '" + (REPO / 'scripts/lib/common.ps1').as_posix() + "'\n"
                    "$Role=$env:TEST_ROLE; $Machine='device'; $OpMode='service'\n"
                    "$Vault=$env:TEST_VAULT\n"
                    "$Versions='" + (REPO / 'versions.toml').as_posix() + "'\n")
                cmd = ['powershell.exe', '-NoProfile', '-NonInteractive', '-File']
                summary = "\nif ($script:AeFail -gt 0) { exit 1 }; if ($script:AeWarn -gt 0) { exit 2 }\n"
            else:
                start, end = 'ae_section "1Password (op)"', 'ae_section "Tailscale and hub"'
                section = source[source.index(start):source.index(end)]
                bootstrap = (
                    ". '" + (REPO / 'scripts/lib/common.sh').as_posix() + "'\n"
                    ". '" + (REPO / 'scripts/lib/load-token.sh').as_posix() + "'\n"
                    "REPO='" + REPO.as_posix() + "'\n"
                    "ROLE=$TEST_ROLE; MACHINE=device; OP_MODE=service; VAULT=$TEST_VAULT\n"
                    "VERSIONS='" + (REPO / 'versions.toml').as_posix() + "'\n")
                cmd = ['sh']
                summary = '\n[ "$AE_FAIL" -eq 0 ] || exit 1\n[ "$AE_WARN" -eq 0 ] || exit 2\n'
            script = root / ('preflight-op' + (suffix or '.sh'))
            script.write_text(bootstrap + section + summary, encoding='ascii', newline='\n')
            for role, scope, expected in [('hub', 'broad', 0), ('client', 'narrow', 0),
                                           ('client', 'broad', 2), ('client', 'failure', 1)]:
                env.update(TEST_ROLE=role, TEST_VAULT='agent-env' if role == 'hub' else 'agent-env-device',
                           FAKE_SCOPE=scope)
                code, _ = run(cmd + [str(script)], env)
                assert code == expected, 'preflight scope: ' + (suffix or 'sh') + ' ' + role + ' ' + scope
            del env['OP_SERVICE_ACCOUNT_TOKEN']
            (root / 'calls').unlink()
            code, _ = run(cmd + [str(script)], env)
            calls = [json.loads(line) for line in (root / 'calls').read_text().splitlines()]
            assert code == 1 and calls == [['--version']], 'missing token attempted sign-in'
            if suffix:
                env.update(TEST_PERSISTED_TOKEN='fake-service-token', FAKE_SCOPE='narrow')
                code, output = run(cmd + [str(script)], env)
                assert code == 0, 'preflight did not load mocked User token'
                assert 'fake-service-token' not in output, 'preflight printed User token'
                token_consumers(root, env, fakebin, suffix, mocked_loader)
                del env['TEST_PERSISTED_TOKEN']
            if not suffix and os.name != 'nt':
                # Native temp storage is needed to test Unix modes even on a DrvFs checkout.
                with tempfile.TemporaryDirectory(prefix='agent-env-token-') as home_tmp:
                    fakehome = Path(home_tmp)
                    token = fakehome / '.config/op/agent-env-token'
                    token.parent.mkdir(parents=True)
                    token.write_text('fake-service-token\n')
                    token.chmod(0o600)
                    env.update(HOME=str(fakehome), FAKE_SCOPE='narrow')
                    code, output = run(cmd + [str(script)], env)
                    assert code == 0, 'preflight failed to load persisted token in existing agent session'
                    assert 'fake-service-token' not in output, 'preflight printed persisted token'
                    token_consumers(root, env, fakebin)
                    token.chmod(0o644)
                    code, _ = run(cmd + [str(script)], env)
                    assert code == 1, 'preflight accepted unsafe token mode'
                    token.chmod(0o600)
                    token.rename(token.with_suffix('.raw'))
                    token.symlink_to(token.with_suffix('.raw'))
                    code, _ = run(cmd + [str(script)], env)
                    assert code == 1, 'preflight accepted symlink token'
                    token.unlink()
                    # Use a fake stat result to exercise another uid without needing root.
                    (fakebin / 'stat').write_text('#!/bin/sh\nprintf "600:999999\\n"\n')
                    (fakebin / 'stat').chmod(0o700)
                    token.write_text('fake-service-token\n')
                    token.chmod(0o600)
                    code, _ = run(cmd + [str(script)], env)
                    assert code == 1, 'preflight accepted token owned by another uid'
                    (fakebin / 'stat').unlink()
                    env['HOME'] = str(emptyhome)
            env['OP_SERVICE_ACCOUNT_TOKEN'] = 'fake-service-token'
            print('op-test: ' + (suffix or 'sh') + ' hub/device scope, list failure and missing token passed')

        # Exercise the real macOS branch with no CLI and a reachable fake hub.
        (fakebin / 'curl').write_text('#!/bin/sh\nprintf 401\n', encoding='ascii')
        (fakebin / 'curl').chmod(0o700)
        source = (REPO / 'scripts/preflight').read_text()
        start, end = source.index('ts_cli=$(command'), source.index('ae_section "Harnesses"')
        script = root / 'macos-connectivity.sh'
        mac_ts = root / 'Tailscale.app/Contents/MacOS/Tailscale'
        mac_section = source[start:end].replace('/Applications/Tailscale.app/Contents/MacOS/Tailscale', mac_ts.as_posix())
        script.write_text(
            ". '" + (REPO / 'scripts/lib/common.sh').as_posix() + "'\n" +
            "OS=macos; ROLE=client; CPA_URL=https://hub.example.com\n" +
            "VERSIONS='" + (REPO / 'versions.toml').as_posix() + "'\n" +
            "command() { case \"$*\" in '-v tailscale') return 1 ;; *) /bin/sh -c 'command \"$@\"' _ \"$@\" ;; esac; }\n" +
            mac_section + '\n[ "$AE_FAIL" -eq 0 ] && [ "$AE_WARN" -eq 1 ]\n',
            encoding='ascii', newline='\n')
        code, _ = run(['sh', str(script)], env)
        assert code == 0, 'macOS CLI missing despite reachable hub'
        mac_ts.parent.mkdir(parents=True)
        mac_ts.write_text('#!/bin/sh\nif [ "$1" = version ]; then echo 1.104.5; else echo \'{"BackendState":"Running"}\'; fi\n', encoding='ascii')
        mac_ts.chmod(0o700)
        script.write_text(script.read_text(encoding='ascii').replace('[ "$AE_WARN" -eq 1 ]', '[ "$AE_WARN" -eq 0 ]'), encoding='ascii')
        code, _ = run(['sh', str(script)], env)
        assert code == 0, 'macOS app CLI fallback failed'
        (fakebin / 'curl').unlink()
        # The actual preflight default must distinguish WSL from its Windows host.
        start, end = source.index('OS=$(ae_os_flavour)'), source.index('OP_MODE=${')
        script.write_text("ae_os_flavour() { echo wsl; }\nhostname() { echo devbox; }\nMACHINE=''\n" +
                          source[start:end] + '\n[ "$MACHINE" = devbox-wsl ]\n', encoding='ascii')
        code, _ = run(['sh', str(script)], env)
        assert code == 0, 'preflight WSL default reused Windows remark'
        print('op-test: macOS app CLI fallback, missing CLI with HTTP 401, and non-hub WSL remark passed')

        if os.name == 'nt':
            source = (REPO / 'scripts/verify.d/40-cpa.ps1').read_text()
            start = source.index('                    # Device keys live in separate vaults;')
            end = source.index('                    $titles = $null', start)
            script = root / 'roster.ps1'
            script.write_text(
                ". '" + (REPO / 'scripts/lib/common.ps1').as_posix() + "'\n"
                "$k = [pscustomobject]@{ remarks = @('device', 'remote-device') }\n" +
                source[start:end] + '\nif ($script:AeFail -gt 0) { exit 1 }; '
                'if ($script:AeWarn -gt 0) { exit 2 }\n', encoding='ascii', newline='\n')
            cmd = ['powershell.exe', '-NoProfile', '-NonInteractive', '-File', str(script)]
            code, _ = run(cmd, env)
            assert code == 0, 'hub roster ignored per-device vaults'
            env['FAKE_ROSTER_MISSING'] = '1'
            code, _ = run(cmd, env)
            assert code == 2, 'hub roster ignored a missing device key'
            print('op-test: .ps1 hub roster spans device vaults and still warns for missing keys')
            source = (REPO / 'scripts/preflight.d/40-cpa.ps1').read_text()
            start = source.index('    $cpaPythonReady')
            script.write_text(
                ". '" + (REPO / 'scripts/lib/common.ps1').as_posix() + "'\n" +
                'function Ae-Have { return $false }\n$LASTEXITCODE = 0\n' +
                source[start:source.rfind('}')] +
                '\nif ($script:AeFail -gt 0 -or $script:AeWarn -ne 1) { exit 1 }\n',
                encoding='ascii', newline='\n')
            code, _ = run(cmd, env)
            assert code == 0, 'hub missing Python must warn before apply'
            source = (REPO / 'home/.chezmoiscripts/run_onchange_after_40-cpa-rebalancer-task.ps1.tmpl').read_text()
            start, end = source.index('$pathParts ='), source.index('$want =')
            probe = source[start:end].replace("[Environment]::GetEnvironmentVariable('Path', $scope)", "''")
            pyw = root / 'Programs/Python/Python313/pythonw.exe'
            pyw.parent.mkdir(parents=True)
            pyw.touch()
            probe = "$env:Path = ''; $env:LOCALAPPDATA = '" + root.as_posix() + "'\n" + probe
            script.write_text(probe + "\nif ($py -ne '" + str(pyw) + "') { exit 1 }\n", encoding='ascii', newline='\n')
            code, _ = run(cmd, env)
            assert code == 0, 'rebalancer cannot find newly installed pythonw outside old PATH'
            print('op-test: hub Python warns before apply; rebalancer finds install-dir pythonw')
            # Execute the task guard against a scratch home with every task API replaced.
            body = source[source.index("$ErrorActionPreference ="):source.rindex('{{- end }}')]
            body = body.replace('{{ $rb.interval_minutes }}', '5').replace('{{ $rb.time_limit_minutes }}', '4')
            body = body.replace('$HOME', "'" + root.as_posix() + "'")
            task_probe = ("function Get-ScheduledTask { Write-Output 'private task gate reached'; exit 23 }\n"
                          "function Register-ScheduledTask { throw 'unexpected registration' }\n"
                          "$env:LOCALAPPDATA = '" + root.as_posix() + "'\n")
            script.write_text(task_probe + body, encoding='ascii', newline='\n')
            code, output = run(cmd, env)
            assert code == 0 and "owner's private backup" in output, 'missing private tool did not warn and skip'
            assert 'private task gate reached' not in output, 'missing private tool consulted task APIs'
            private_tool = root / '.cpa-tools/soonest_reset.py'
            private_tool.parent.mkdir()
            private_tool.touch()
            code, output = run(cmd, env)
            assert code == 23 and 'private task gate reached' in output, 'existing private tool did not reach task comparison'
            print('op-test: missing private tool skips task APIs; existing tool reaches task comparison')


    return 0


if __name__ == '__main__':
    try:
        sys.exit(main())
    except AssertionError as exc:
        # All assertion messages are static labels, never subprocess output or field values.
        print('FAIL op-test: ' + str(exc))
        sys.exit(1)
