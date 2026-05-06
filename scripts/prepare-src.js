#!/usr/bin/env node
/**
 * Pre-build: Repack patched ASAR, replace codex CLI, assemble for forge.
 *
 * Flow:
 *   1. Repack _asar/ -> app.asar (with patches applied)
 *   2. Replace codex binary with @cometix/codex version
 *   3. Copy everything to src/ for forge (app.asar + unpacked + resources)
 *
 * For Linux: strip macOS-only resources, add Linux codex from @cometix/codex
 *
 * Usage:
 *   node scripts/prepare-src.js --platform mac-arm64
 *   node scripts/prepare-src.js --platform linux-x64
 */
const fs = require("fs");
const path = require("path");
const { execSync } = require("child_process");

const SRC = path.join(__dirname, "..", "src");
const PROJECT_ROOT = path.join(__dirname, "..");

const TARGET_TRIPLE_MAP = {
  "mac-arm64": "aarch64-apple-darwin",
  "mac-x64": "x86_64-apple-darwin",
  "linux-x64": "x86_64-unknown-linux-musl",
  "linux-arm64": "aarch64-unknown-linux-musl",
  "win": "x86_64-pc-windows-msvc",
};

// macOS-only resources to strip for Linux
const MACOS_STRIP = new Set([
  "codex_chronicle", "node", "node_repl",
  "electron.icns", "Assets.car",
  "codexTemplate.png", "codexTemplate@2x.png",
]);
const MACOS_STRIP_DIRS = new Set(["native"]);

function copyRecursive(src, dest, skipFiles, skipDirs) {
  fs.mkdirSync(dest, { recursive: true });
  let count = 0;
  for (const e of fs.readdirSync(src, { withFileTypes: true })) {
    if (skipDirs?.has(e.name)) continue;
    if (skipFiles?.has(e.name)) continue;
    const s = path.join(src, e.name), d = path.join(dest, e.name);
    if (e.isDirectory()) { count += copyRecursive(s, d, skipFiles, skipDirs); }
    else if (e.isSymbolicLink()) { /* skip */ }
    else { fs.copyFileSync(s, d); count++; }
  }
  return count;
}

/**
 * Resolve codex CLI binary from @cometix/codex.
 * Tries node_modules first, falls back to npm pack + extract.
 */
function resolveCodexVendor(platform) {
  const triple = TARGET_TRIPLE_MAP[platform];
  if (!triple) return null;
  const isWin = platform === "win";
  const binName = isWin ? "codex.exe" : "codex";

  // 1. Try local node_modules
  const localPath = path.join(PROJECT_ROOT, "node_modules", "@cometix", "codex", "vendor", triple, "codex", binName);
  if (fs.existsSync(localPath)) return localPath;

  // 2. npm pack + extract
  console.log("   [codex] fetching @cometix/codex via npm pack...");
  const tmpDir = path.join(require("os").tmpdir(), "cometix-codex-pack");
  if (!fs.existsSync(tmpDir)) fs.mkdirSync(tmpDir, { recursive: true });

  try {
    const tgzName = execSync("npm pack @cometix/codex@latest --pack-destination " + tmpDir, {
      cwd: tmpDir, encoding: "utf-8", stdio: ["pipe", "pipe", "pipe"],
    }).trim().split("\n").pop();

    const tgzPath = path.join(tmpDir, tgzName);
    const extractDir = path.join(tmpDir, "extracted");
    if (fs.existsSync(extractDir)) fs.rmSync(extractDir, { recursive: true });
    fs.mkdirSync(extractDir, { recursive: true });
    execSync(`tar xzf "${tgzPath}" -C "${extractDir}"`, { stdio: "pipe" });

    const vendorPath = path.join(extractDir, "package", "vendor", triple, "codex", binName);
    if (fs.existsSync(vendorPath)) return vendorPath;
  } catch (e) {
    console.log(`   [!] npm pack failed: ${e.message}`);
  }

  return null;
}

function main() {
  const args = process.argv.slice(2);
  const platIdx = args.indexOf("--platform");
  const platform = platIdx !== -1 ? args[platIdx + 1] : null;

  const VALID = ["mac-arm64", "mac-x64", "win", "linux-x64", "linux-arm64"];
  if (!platform || !VALID.includes(platform)) {
    console.error(`[x] Usage: prepare-src.js --platform <${VALID.join("|")}>`);
    process.exit(1);
  }

  const isLinux = platform.startsWith("linux");
  const sourceDir = isLinux
    ? path.join(SRC, platform === "linux-arm64" ? "mac-arm64" : "mac-x64")
    : path.join(SRC, platform);

  if (!fs.existsSync(sourceDir)) {
    console.error(`[x] Source not found: ${path.relative(PROJECT_ROOT, sourceDir)}/`);
    process.exit(1);
  }

  const asarContentDir = path.join(sourceDir, "_asar");
  if (!fs.existsSync(asarContentDir)) {
    console.error(`[x] _asar/ not found in ${path.relative(PROJECT_ROOT, sourceDir)}/`);
    process.exit(1);
  }

  console.log(`-- prepare-src: ${platform}`);
  console.log(`   source: ${path.relative(PROJECT_ROOT, sourceDir)}/`);

  // 1. Repack _asar/ -> app.asar
  const repackedAsar = path.join(sourceDir, "app.asar");
  console.log("   [repack] _asar/ -> app.asar");
  execSync(`npx asar pack "${asarContentDir}" "${repackedAsar}"`);
  const asarSize = (fs.statSync(repackedAsar).size / 1048576).toFixed(1);
  console.log(`   [ok] app.asar: ${asarSize} MB`);

  // 2. Replace codex binary with @cometix/codex
  const isWin = platform === "win";
  const codexBinName = isWin ? "codex.exe" : "codex";
  const vendorCodex = resolveCodexVendor(platform);
  if (vendorCodex) {
    const dest = path.join(sourceDir, codexBinName);
    fs.copyFileSync(vendorCodex, dest);
    try { fs.chmodSync(dest, 0o755); } catch {}
    console.log(`   [codex] replaced with @cometix/codex`);
  } else {
    console.log(`   [!] @cometix/codex vendor not found for ${platform}, keeping upstream`);
  }

  // 3. For Linux: copy _asar/ content to flat src/ (forge packs ASAR from src/)
  if (isLinux) {
    // Clear flat src/ dirs
    for (const d of [".vite", "webview", "skills", "native-menu-locales", "node_modules"]) {
      const p = path.join(SRC, d);
      if (fs.existsSync(p)) fs.rmSync(p, { recursive: true });
    }
    for (const f of fs.readdirSync(SRC)) {
      const p = path.join(SRC, f);
      if (fs.statSync(p).isFile()) fs.unlinkSync(p);
    }
    const count = copyRecursive(asarContentDir, SRC);
    console.log(`   [linux] _asar/ -> src/ (${count} files for forge ASAR packing)`);
  }

  // 4. Sync version to root package.json
  const upstreamPkg = path.join(asarContentDir, "package.json");
  if (fs.existsSync(upstreamPkg)) {
    const upstream = JSON.parse(fs.readFileSync(upstreamPkg, "utf-8"));
    const rootPkgPath = path.join(PROJECT_ROOT, "package.json");
    const rootPkg = JSON.parse(fs.readFileSync(rootPkgPath, "utf-8"));
    const oldVer = rootPkg.version;
    rootPkg.version = upstream.version || rootPkg.version;
    rootPkg.main = "src/.vite/build/bootstrap.js";
    for (const key of [
      "codexBuildNumber", "codexBuildFlavor",
      "codexSparkleFeedUrl", "codexSparklePublicKey",
      "codexWindowsUpdateUrl", "codexWindowsPackageIdentity",
      "codexWindowsPackagePublisher",
    ]) {
      if (upstream[key]) rootPkg[key] = upstream[key];
    }
    fs.writeFileSync(rootPkgPath, JSON.stringify(rootPkg, null, 2) + "\n");
    console.log(`   version: ${oldVer} -> ${rootPkg.version}`);
  }

  // Write build mode marker for forge.config.js
  const marker = path.join(SRC, ".build-mode");
  fs.writeFileSync(marker, isLinux ? "linux" : "upstream-asar");
  console.log(`   [mode] ${isLinux ? "linux (forge packs ASAR)" : "upstream-asar (pre-built)"}`);

  console.log(`   [ok] src/ ready for ${platform} build`);
}

main();
