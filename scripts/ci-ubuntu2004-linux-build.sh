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

node_major="${NODE_VERSION:-24}"
node_base_url="https://nodejs.org/dist/latest-v${node_major}.x"
node_file="$(curl -fsSL "$node_base_url/SHASUMS256.txt" | awk "/linux-${node_arch}\\.tar\\.xz/ {print \$2; exit}")"
if [ -z "$node_file" ]; then
  echo "Unable to resolve Node.js ${node_major} linux-${node_arch} tarball" >&2
  exit 1
fi

curl -fsSLo "/tmp/${node_file}" "${node_base_url}/${node_file}"
tar -xJf "/tmp/${node_file}" -C /usr/local --strip-components=1

node --version
npm --version
dpkg --print-architecture

npm ci
node scripts/sync-upstream.js --force --skip-win
node scripts/patch-all.js "mac-${arch}"
npm run "build:linux-${arch}"
