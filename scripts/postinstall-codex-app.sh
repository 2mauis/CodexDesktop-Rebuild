#!/usr/bin/env bash
set -euo pipefail

# Post-install checks for the Linux Codex App package.
#
# The official OpenAI Codex CLI installer owns the `codex` command. This
# package intentionally installs the desktop shell as `codex-app` and keeps the
# bundled desktop backend at resources/codex for Electron app-server use.

APP_PACKAGE="${APP_PACKAGE:-codex-app}"
APP_ROOT="${APP_ROOT:-/usr/lib/${APP_PACKAGE}}"
DESKTOP_FILE="${DESKTOP_FILE:-/usr/share/applications/${APP_PACKAGE}.desktop}"
BWRAP_APPARMOR_PROFILE="${BWRAP_APPARMOR_PROFILE:-/etc/apparmor.d/bwrap}"

install_bwrap_apparmor_profile() {
  if [ "${CODEX_INSTALL_BWRAP_APPARMOR_PROFILE:-1}" = "0" ]; then
    echo "[skip] bwrap AppArmor profile install disabled"
    return 0
  fi

  if [ ! -x /usr/bin/bwrap ]; then
    echo "[skip] bwrap not found at /usr/bin/bwrap"
    return 0
  fi

  if [ ! -d /etc/apparmor.d ]; then
    echo "[skip] AppArmor profile directory not found"
    return 0
  fi

  if ! command -v apparmor_parser >/dev/null 2>&1; then
    echo "[skip] apparmor_parser not found"
    return 0
  fi

  local restrict_userns
  restrict_userns="$(cat /proc/sys/kernel/apparmor_restrict_unprivileged_userns 2>/dev/null || printf '0')"
  if [ "${restrict_userns}" != "1" ]; then
    echo "[skip] AppArmor unprivileged userns restriction is not enabled"
    return 0
  fi

  if [ -f "${BWRAP_APPARMOR_PROFILE}" ] &&
    ! grep -q 'profile bwrap /usr/bin/bwrap flags=(unconfined)' "${BWRAP_APPARMOR_PROFILE}"; then
    cp -a "${BWRAP_APPARMOR_PROFILE}" "${BWRAP_APPARMOR_PROFILE}.orig-codex-app"
  fi

  cat >"${BWRAP_APPARMOR_PROFILE}" <<'EOF'
# This profile allows bubblewrap to create unprivileged user namespaces on
# Ubuntu systems that enable kernel.apparmor_restrict_unprivileged_userns.

abi <abi/4.0>,
include <tunables/global>

profile bwrap /usr/bin/bwrap flags=(unconfined) {
  userns,

  include if exists <local/bwrap>
}
EOF

  apparmor_parser -r -K "${BWRAP_APPARMOR_PROFILE}"
  echo "[ok] bwrap: installed AppArmor userns profile"
}

if [ "$(id -u)" -ne 0 ]; then
  exec sudo "$0" "$@"
fi

if [ ! -x "${APP_ROOT}/Codex" ]; then
  echo "missing Codex App executable: ${APP_ROOT}/Codex" >&2
  exit 1
fi

if [ ! -x "${APP_ROOT}/resources/codex" ]; then
  echo "missing bundled Codex App backend: ${APP_ROOT}/resources/codex" >&2
  exit 1
fi

install_bwrap_apparmor_profile

if [ -f "${DESKTOP_FILE}" ] && command -v update-desktop-database >/dev/null 2>&1; then
  update-desktop-database "$(dirname "${DESKTOP_FILE}")"
fi

echo "[ok] ${APP_PACKAGE}: installed as codex-app; codex remains available for the official CLI"
