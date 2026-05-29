#!/usr/bin/env bash
set -euo pipefail

# Keep legacy Codex desktop package entry points from launching stale app shells.
#
# The old `codex-desktop` Debian package can remain installed next to the newer
# `codex` package. Updating only the backend CLI is not enough: new product
# features such as slash commands live in the Electron app.asar frontend. This
# script makes legacy launch paths resolve to the current `codex` shell and
# links frontend resources so direct legacy launches do not keep using stale UI.

SOURCE_PACKAGE="${SOURCE_PACKAGE:-codex}"
TARGET_PACKAGES="${TARGET_PACKAGES:-codex-desktop}"
SOURCE_ROOT="${SOURCE_ROOT:-/usr/lib/${SOURCE_PACKAGE}}"
SOURCE_RESOURCES="${SOURCE_RESOURCES:-${SOURCE_ROOT}/resources}"
SOURCE_BIN="${SOURCE_BIN:-/usr/bin/${SOURCE_PACKAGE}}"
BACKUP_SUFFIX="${BACKUP_SUFFIX:-orig-dpkg-shell-sync}"

if [ "${CODEX_SYNC_LEGACY_DESKTOP:-1}" = "0" ]; then
  echo "[skip] legacy Codex desktop shell sync disabled"
  exit 0
fi

if [ "$(id -u)" -ne 0 ]; then
  exec sudo "$0" "$@"
fi

if [ ! -x "${SOURCE_ROOT}/Codex" ]; then
  echo "[skip] source Codex shell not found: ${SOURCE_ROOT}/Codex"
  exit 0
fi

if [ ! -f "${SOURCE_RESOURCES}/app.asar" ]; then
  echo "[skip] source app.asar not found: ${SOURCE_RESOURCES}/app.asar"
  exit 0
fi

owner_user="${SUDO_USER:-${USER:-}}"
owner_home=""
if [ -n "${owner_user}" ]; then
  owner_home="$(getent passwd "${owner_user}" 2>/dev/null | cut -d: -f6 || true)"
fi

resolve_cli_path() {
  local home="${1:-}"
  if [ -n "${CODEX_CLI_PATH:-}" ]; then
    printf '%s\n' "${CODEX_CLI_PATH}"
  elif [ -n "${home}" ] && [ -x "${home}/.local/bin/codex" ]; then
    printf '%s\n' "${home}/.local/bin/codex"
  elif [ -x "${SOURCE_RESOURCES}/codex" ]; then
    printf '%s\n' "${SOURCE_RESOURCES}/codex"
  else
    printf '%s\n' "${SOURCE_BIN}"
  fi
}

default_cli_path="$(resolve_cli_path "${owner_home}")"

backup_once() {
  local path="$1"
  local backup="${path}.${BACKUP_SUFFIX}"
  if [ -e "${path}" ] || [ -L "${path}" ]; then
    if [ ! -e "${backup}" ] && [ ! -L "${backup}" ]; then
      cp -a "${path}" "${backup}"
    fi
  fi
}

replace_with_symlink() {
  local source="$1"
  local target="$2"
  if [ ! -e "${source}" ] && [ ! -L "${source}" ]; then
    return 0
  fi
  if [ -L "${target}" ] && [ "$(readlink "${target}")" = "${source}" ]; then
    return 0
  fi
  backup_once "${target}"
  rm -rf "${target}"
  ln -s "${source}" "${target}"
}

patch_desktop_file() {
  local desktop_file="$1"
  local exec_target="$2"
  local cli_path="$3"
  if [ ! -f "${desktop_file}" ]; then
    return 0
  fi
  backup_once "${desktop_file}"
  sed -i "s#^Exec=.*#Exec=env CODEX_CLI_PATH=${cli_path} ${exec_target} %u#" "${desktop_file}"
}

patch_user_desktop_file() {
  local desktop_file="$1"
  local exec_target="$2"
  if [ ! -f "${desktop_file}" ]; then
    return 0
  fi

  local user_home
  user_home="$(cd "$(dirname "${desktop_file}")/../../.." && pwd -P)"
  local user_name
  user_name="$(stat -c '%U' "${desktop_file}" 2>/dev/null || true)"
  local group_name
  group_name="$(stat -c '%G' "${desktop_file}" 2>/dev/null || true)"

  patch_desktop_file "${desktop_file}" "${exec_target}" "$(resolve_cli_path "${user_home}")"

  if [ -n "${user_name}" ] && [ -n "${group_name}" ]; then
    chown "${user_name}:${group_name}" "${desktop_file}" 2>/dev/null || true
  fi
}

for target_package in ${TARGET_PACKAGES}; do
  target_root="/usr/lib/${target_package}"
  target_resources="${target_root}/resources"

  if [ ! -d "${target_root}" ]; then
    echo "[skip] ${target_package}: ${target_root} not installed"
    continue
  fi

  mkdir -p "${target_resources}"

  for resource in \
    app.asar \
    app.asar.unpacked \
    plugins \
    THIRD_PARTY_NOTICES.txt \
    icon.icns \
    rg; do
    replace_with_symlink \
      "${SOURCE_RESOURCES}/${resource}" \
      "${target_resources}/${resource}"
  done

  # Keep a usable backend for direct legacy launches, but desktop files still
  # pass CODEX_CLI_PATH so the user's selected CLI wins.
  replace_with_symlink \
    "${SOURCE_RESOURCES}/codex" \
    "${target_resources}/codex"

  if [ -e "/usr/bin/${target_package}" ] || [ -L "/usr/bin/${target_package}" ]; then
    backup_once "/usr/bin/${target_package}"
    ln -sfn "../lib/${SOURCE_PACKAGE}/Codex" "/usr/bin/${target_package}"
  fi

  patch_desktop_file \
    "/usr/share/applications/${target_package}.desktop" \
    "${SOURCE_BIN}" \
    "${default_cli_path}"

  if [ -n "${owner_home}" ]; then
    patch_user_desktop_file \
      "${owner_home}/.local/share/applications/${target_package}.desktop" \
      "${SOURCE_BIN}"
  fi

  for desktop_file in /home/*/.local/share/applications/"${target_package}.desktop"; do
    [ -f "${desktop_file}" ] || continue
    patch_user_desktop_file "${desktop_file}" "${SOURCE_BIN}"
  done

  echo "[ok] ${target_package}: synced shell/resources to ${SOURCE_PACKAGE}"
done
