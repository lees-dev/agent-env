{{- /* Native Linux (Rocky/RHEL servers such as server, or Ubuntu). Called from rules/global.md. */ -}}
# Machine environment (Linux{{ if eq .role "server" }} server{{ end }}, {{ .distro }})

- Native Linux ({{ .distro }}, {{ .distroFamily }} family). Shell: POSIX sh / bash.
{{- if eq .role "server" }}
- This is a shared, headless server. Install tools user-level only (`~/.local/bin`, mise, npm with a user prefix). Never use `sudo`, {{ if eq .distroFamily "rhel" }}`dnf`{{ else }}the system package manager{{ end }} or system units from an agent session.
- System units and server configuration belong to the repository that owns the server, not to your home directory.
{{- end }}
- Prefer project wrappers over global tools: `./mvnw`, `./gradlew`.
