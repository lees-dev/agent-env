@echo off
rem Prints this machine's CLIProxyAPI client key on stdout, for harness auth helpers on Windows
rem (Claude apiKeyHelper runs through cmd on Windows; Codex auth command; Grok auth_provider_command).
rem The key file is written by chezmoi from 1Password (agent-env docs/cpa.md). Unix: cpa-token.
setlocal
set "F=%USERPROFILE%\.config\agent-env\cpa-key"
if not exist "%F%" (
  echo cpa-token: %F% is missing; run chezmoi apply 1>&2
  exit /b 1
)
type "%F%"
