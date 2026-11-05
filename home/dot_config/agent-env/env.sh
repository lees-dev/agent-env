# shellcheck shell=sh
# agent-env shell environment. Managed by chezmoi from the agent-env repo; edit it there.
# Sourced by the "# >>> agent-env >>>" block that the packages run script adds to ~/.bashrc,
# ~/.zshrc and the login file (~/.bash_profile or ~/.profile), on WSL, Linux, macOS and in
# Git Bash on Windows. POSIX sh; safe to source any number of times.
# Each area adds its own drop-in as ~/.config/agent-env/env.d/<NN>-<area>.sh.
for _ae_env in "$HOME/.config/agent-env/env.d"/*.sh; do
  # Drop-ins are found by glob at run time, so there is no fixed path to follow.
  # shellcheck disable=SC1090
  [ -r "$_ae_env" ] && . "$_ae_env"
done
unset _ae_env
