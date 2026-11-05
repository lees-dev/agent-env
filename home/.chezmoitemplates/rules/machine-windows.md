{{- /* Windows native. Called from rules/global.md with .harness set. */ -}}
# Machine environment (Windows host)

- Windows 11 Pro, x64. Work natively on Windows unless the working directory is a WSL path (`\\wsl.localhost\Ubuntu\...` or `\\wsl$\Ubuntu\...`).
- Shells: PowerShell 5.1 and Git Bash (`C:\Program Files\Git`).
- On PATH: Git, Node 24 LTS + npm + pnpm, Java 25 (Temurin, `JAVA_HOME` set), Maven 3.10 (`MAVEN_HOME`), Python 3.13 (`py` / `python`), `gh`, `rg`, Docker Desktop.
- Prefer project wrappers over global tools: `mvnw.cmd` / `./mvnw`, `gradlew.bat` / `./gradlew`.
{{- if eq .harness "claude" }}

## Claude desktop app caveat

- The Claude desktop app is an MSIX package: commands run from its tools get `%APPDATA%` / `%LOCALAPPDATA%` writes silently redirected into `%LOCALAPPDATA%\Packages\Claude_pzs8sxrjxfjjc\LocalCache\...`, invisible to normal shells. Install global tools (e.g. `npm install -g`) and verify "does it work for the user" from outside the package (WMI `Win32_Process.Create`, or check the real disk via WSL `/mnt/c/...`). Plain CLI sessions in a normal terminal are not affected.
{{- end }}

## WSL2 (available, not the default)

- WSL2 Ubuntu exists with its own independent toolchain (Node, Java, git, Claude Code, Codex). Don't assume it is in use.
- Only reach into it (`wsl.exe -d Ubuntu -- <cmd>`) when asked, or when the project lives inside WSL.
- Never install or run `node_modules` / builds across the boundary (Windows npm on a WSL project or vice versa): native binaries differ. Run dependency installs and builds from the same OS that owns the project files.
- Docker Desktop uses the WSL2 backend; `docker` works from both Windows and WSL.
