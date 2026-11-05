# shellcheck shell=sh
# Read desktop metadata without starting Electron or Toolbox.
# The AppImage runtime extracts just its desktop entry; it never invokes AppRun.
pk_appimage_version() (
  [ -x "$1" ] || exit 0
  _image=$(CDPATH='' cd -- "$(dirname "$1")" && pwd)/$(basename "$1")
  _dir=$(mktemp -d) || exit 1
  trap 'rm -rf "$_dir"' 0
  cd "$_dir" || exit 1
  "$_image" --appimage-extract '*.desktop' >/dev/null 2>&1 || exit 0
  sed -n 's/^X-AppImage-Version=//p' squashfs-root/*.desktop 2>/dev/null | head -n 1
)

# Select the newest installed Toolbox, including its own updater's standard directory.
# PK_TOOLBOX_TARGET and PK_TOOLBOX_VERSION are outputs; build.txt ships in the vendor tar.
pk_toolbox_latest() {
  PK_TOOLBOX_TARGET=''; PK_TOOLBOX_VERSION=''
  for _tb in "$HOME/.local/share/jetbrains-toolbox"/jetbrains-toolbox-* "$HOME/.local/share/JetBrains/Toolbox"; do
    [ -x "$_tb/bin/jetbrains-toolbox" ] && [ -r "$_tb/bin/build.txt" ] || continue
    _tv=$(pk_semver "$(cat "$_tb/bin/build.txt")")
    [ -n "$_tv" ] || continue
    if [ -z "$PK_TOOLBOX_VERSION" ] || [ "$(pk_cmp "$_tv" "$PK_TOOLBOX_VERSION")" = gt ]; then
      # shellcheck disable=SC2034 # Outputs consumed by the installer and verifier.
      PK_TOOLBOX_TARGET=$_tb; PK_TOOLBOX_VERSION=$_tv
    fi
  done
}
