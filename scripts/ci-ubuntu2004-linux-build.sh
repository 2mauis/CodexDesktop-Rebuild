#!/usr/bin/env bash
set -euo pipefail

arch="${1:-}"
case "$arch" in
  x64) node_arch="x64" ;;
  arm64) node_arch="arm64" ;;
  *)
    echo "Usage: $0 <x64|arm64>" >&2
    exit 2
    ;;
esac

export DEBIAN_FRONTEND=noninteractive
export npm_config_arch="$node_arch"
export npm_config_platform=linux
export npm_config_cache=/tmp/npm-cache
export HOME=/tmp/codex-ci-home

restore_owner() {
  if [ -n "${HOST_UID:-}" ] && [ -n "${HOST_GID:-}" ]; then
    chown -R "${HOST_UID}:${HOST_GID}" out src node_modules package-lock.json package.json 2>/dev/null || true
  fi
}
trap restore_owner EXIT

apt-get update
apt-get install -y --no-install-recommends \
  ca-certificates \
  curl \
  dpkg \
  fakeroot \
  file \
  gcc-10 \
  g++ \
  g++-10 \
  git \
  make \
  p7zip-full \
  python3 \
  unzip \
  xz-utils
rm -rf /var/lib/apt/lists/*

export CC=gcc-10
export CXX=g++-10
compat_include=/tmp/codex-ci-include
mkdir -p "$compat_include"
cat > "$compat_include/source_location" <<'EOF'
#pragma once
#include <cstdint>

namespace std {
class source_location {
 public:
  static constexpr source_location current() noexcept { return source_location(); }
  constexpr source_location() noexcept = default;
  constexpr const char* file_name() const noexcept { return ""; }
  constexpr const char* function_name() const noexcept { return ""; }
  constexpr std::uint_least32_t line() const noexcept { return 0; }
  constexpr std::uint_least32_t column() const noexcept { return 0; }
};
}
EOF
export CXXFLAGS="-I${compat_include} ${CXXFLAGS:-}"

node_version="${NODE_VERSION:-24.11.0}"
node_version="${node_version#v}"
if [[ "$node_version" =~ ^[0-9]+$ ]]; then
  node_base_url="https://nodejs.org/dist/latest-v${node_version}.x"
else
  node_base_url="https://nodejs.org/dist/v${node_version}"
fi
node_file="$(curl -fsSL "$node_base_url/SHASUMS256.txt" | awk "/linux-${node_arch}\\.tar\\.xz/ {print \$2; exit}")"
if [ -z "$node_file" ]; then
  echo "Unable to resolve Node.js ${node_version} linux-${node_arch} tarball" >&2
  exit 1
fi

curl -fsSLo "/tmp/${node_file}" "${node_base_url}/${node_file}"
tar -xJf "/tmp/${node_file}" -C /usr/local --strip-components=1

node --version
npm --version
dpkg --print-architecture

npm ci
node scripts/sync-upstream.js --force --skip-win
npm run "build:linux-${arch}"
