{{- /* WSL2 Ubuntu on the Windows host. Called from rules/global.md. */ -}}
# Machine environment (WSL2 Ubuntu on a Windows 11 host)

- This is WSL2 Ubuntu with its own Linux toolchain: Node 24 + npm + pnpm, Java 25 (Temurin, JAVA_HOME set), Maven 3.10, Python 3, git, gh, rg.
- Keep projects in the Linux filesystem (~/...) for speed. /mnt/c/... is the Windows drive: slow, and Windows tools own those files.
- Never run Linux npm/builds against a project that was set up from Windows (or vice versa): native binaries in node_modules differ.
- The Windows host has its own separate toolchain and its own Claude Code / Codex installs. Windows executables are reachable via interop (e.g. explorer.exe, cmd.exe) but don't use Windows node/npm/java from here.
- Docker comes from Docker Desktop's WSL integration; `docker` works here.
- Prefer project wrappers: ./mvnw, ./gradlew.
- JetBrains IDEs run on Windows; they open WSL projects via \\wsl.localhost\Ubuntu.
