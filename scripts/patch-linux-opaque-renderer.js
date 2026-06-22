#!/usr/bin/env node
/**
 * Linux window patch: keep normal Electron app windows opaque.
 *
 * Upstream allows transparent Electron surfaces on Linux. On some compositors
 * that leaks as a black column beside the thread/workspace shell. Patch both
 * the main-process BrowserWindow opacity decision and the renderer CSS.
 */
const fs = require("fs");
const path = require("path");
const { locateBundles, relPath, SRC_DIR } = require("./patch-util");

const MAIN_MARKER = "codex-rebuild-linux-opaque-window-surface";
const LEGACY_MAIN_MARKER = "codex-rebuild-linux-opaque-window-surface-legacy";
const CSS_V1_MARKER = "codex-rebuild-linux-opaque-renderer";
const CSS_V2_MARKER = "codex-rebuild-linux-opaque-renderer-v2";

const OPAQUE_APPEARANCES =
  "e===`primary`||e===`secondary`||e===`hud`||e===`hotkeyWindowHome`||e===`hotkeyWindowThread`";
const LEGACY_OPAQUE_APPEARANCES =
  "l===`primary`||l===`secondary`||l===`hud`||l===`hotkeyWindowHome`||l===`hotkeyWindowThread`";
const LEGACY_VY_APPEARANCES =
  "t===`primary`||t===`secondary`||t===`hud`||t===`hotkeyWindowHome`||t===`hotkeyWindowThread`";

function opaqueAppearancesFor(name) {
  return `${name}===\`primary\`||${name}===\`secondary\`||${name}===\`hud\`||${name}===\`hotkeyWindowHome\`||${name}===\`hotkeyWindowThread\``;
}

const CSS_PATCH = [
  `/* ${CSS_V2_MARKER} */`,
  "[data-codex-window-type=electron][data-codex-os=linux]:not([data-codex-window-chrome=application-menu]){background-color:var(--color-background-surface-under);background-image:none}",
  "[data-codex-window-type=electron][data-codex-os=linux]:not([data-codex-window-chrome=application-menu]) body{background-color:var(--color-background-surface-under);background-image:none}",
  "[data-codex-window-type=electron][data-codex-os=linux]:not([data-codex-window-chrome=application-menu]) #root{background-color:var(--color-background-surface-under)}",
  "[data-codex-window-type=electron][data-codex-os=linux]:not([data-codex-window-chrome=application-menu]) .app-shell-left-panel{background:var(--color-token-side-bar-background,var(--color-token-editor-background))}",
  "[data-codex-window-type=electron][data-codex-os=linux]:not([data-codex-window-chrome=application-menu]) .app-shell-left-panel:after{display:none}",
  "",
].join("\n");

const PLATFORM_ARGS = [
  "linux",
  "linux-x64",
  "linux-arm64",
  "mac-arm64",
  "mac-x64",
  "win",
  "unix",
];

function patchCurrentMainSource(source) {
  if (source.includes(MAIN_MARKER)) {
    return { changed: false, source, reason: "already-patched-current" };
  }

  const oldSource =
    "shouldAlwaysUseOpaqueWindowSurface(e){return $8({appearance:e,opaqueWindowsEnabled:this.isOpaqueWindowsEnabled(),platform:process.platform})||!jM()&&!Z8(e)}";
  if (!source.includes(oldSource)) {
    return { changed: false, source, reason: "not-current-main" };
  }

  const replacement =
    `shouldAlwaysUseOpaqueWindowSurface(e){return process.platform===\`linux\`&&(${OPAQUE_APPEARANCES})/* ${MAIN_MARKER} */||` +
    "$8({appearance:e,opaqueWindowsEnabled:this.isOpaqueWindowsEnabled(),platform:process.platform})||!jM()&&!Z8(e)}";
  return {
    changed: true,
    source: source.replace(oldSource, replacement),
    reason: "patched-current-main",
  };
}

function patchModernMainSource(source) {
  if (source.includes(MAIN_MARKER)) {
    return { changed: false, source, reason: "already-patched-modern" };
  }

  const re =
    /shouldAlwaysUseOpaqueWindowSurface\(([A-Za-z_$][\w$]*)\)\{return ([A-Za-z_$][\w$]*)\(\{appearance:\1,opaqueWindowsEnabled:this\.isOpaqueWindowsEnabled\(\),platform:process\.platform\}\)\|\|!([A-Za-z_$][\w$]*)\(\)&&!([A-Za-z_$][\w$]*)\(\1\)\}/;
  const match = re.exec(source);
  if (!match) {
    return { changed: false, source, reason: "not-modern-main" };
  }

  const [oldSource, appearance, alwaysOpaqueFn, devModeFn, transparentAppearanceFn] = match;
  const replacement =
    `shouldAlwaysUseOpaqueWindowSurface(${appearance}){return process.platform===\`linux\`&&(${opaqueAppearancesFor(appearance)})/* ${MAIN_MARKER} */||` +
    `${alwaysOpaqueFn}({appearance:${appearance},opaqueWindowsEnabled:this.isOpaqueWindowsEnabled(),platform:process.platform})||!${devModeFn}()&&!${transparentAppearanceFn}(${appearance})}`;

  return {
    changed: true,
    source: source.replace(oldSource, replacement),
    reason: "patched-modern-main",
  };
}

function patchLegacyMainSource(source) {
  if (source.includes(LEGACY_MAIN_MARKER)) {
    return { changed: false, source, reason: "already-patched-legacy" };
  }

  const oldOpaqueFlag =
    "w=this.isOpaqueWindowsEnabled(),T=WY({appearance:l,opaqueWindowsEnabled:w,platform:process.platform})";
  const oldBackgroundCondition = "n&&!LY(t)&&(e===`darwin`||e===`win32`)?";

  if (!source.includes(oldOpaqueFlag) || !source.includes(oldBackgroundCondition)) {
    return { changed: false, source, reason: "not-legacy-main" };
  }

  const newOpaqueFlag =
    `w=this.isOpaqueWindowsEnabled()||process.platform===\`linux\`&&(${LEGACY_OPAQUE_APPEARANCES})/* ${LEGACY_MAIN_MARKER} */,` +
    "T=WY({appearance:l,opaqueWindowsEnabled:w,platform:process.platform})";
  const newBackgroundCondition =
    `n&&(!LY(t)&&(e===\`darwin\`||e===\`win32\`)||e===\`linux\`&&(${LEGACY_VY_APPEARANCES}))?`;

  return {
    changed: true,
    source: source.replace(oldOpaqueFlag, newOpaqueFlag).replace(oldBackgroundCondition, newBackgroundCondition),
    reason: "patched-legacy-main",
  };
}

function patchMainSource(source) {
  const current = patchCurrentMainSource(source);
  if (current.changed || current.reason === "already-patched-current") return current;
  const modern = patchModernMainSource(source);
  if (modern.changed || modern.reason === "already-patched-modern") return modern;
  return patchLegacyMainSource(source);
}

function isRendererTarget(source) {
  return (
    source.includes("[data-codex-window-type=electron]") &&
    source.includes(".app-shell-left-panel") &&
    source.includes(".app-shell-left-panel:after") &&
    (source.includes("background:0 0") || source.includes("background-color:#0000"))
  );
}

function patchRendererSource(source) {
  if (source.includes(CSS_V2_MARKER)) {
    return { changed: false, source, reason: "already-patched-renderer" };
  }
  if (!source.includes(CSS_V1_MARKER) && !isRendererTarget(source)) {
    return { changed: false, source, reason: "not-renderer" };
  }
  return {
    changed: true,
    source: source.replace(/\s*$/, "\n") + CSS_PATCH,
    reason: "patched-renderer",
  };
}

function addDir(dirs, platform, dir) {
  if (fs.existsSync(dir)) dirs.push({ platform, dir });
}

function assetDirsForPlatform(platform) {
  const dirs = [];
  if (!platform || platform === "linux" || platform.startsWith("linux-")) {
    addDir(dirs, "linux", path.join(SRC_DIR, "webview", "assets"));
  }
  if (!platform || platform === "mac-arm64" || platform === "unix") {
    addDir(dirs, "mac-arm64", path.join(SRC_DIR, "mac-arm64", "_asar", "webview", "assets"));
  }
  if (!platform || platform === "mac-x64" || platform === "unix") {
    addDir(dirs, "mac-x64", path.join(SRC_DIR, "mac-x64", "_asar", "webview", "assets"));
  }
  if (!platform || platform === "win") {
    addDir(dirs, "win", path.join(SRC_DIR, "win", "_asar", "webview", "assets"));
  }
  return dirs;
}

function locateRendererTargets(platform) {
  const targets = [];
  for (const entry of assetDirsForPlatform(platform)) {
    const files = fs.readdirSync(entry.dir).filter((file) => file.endsWith(".css"));
    for (const file of files) {
      const filePath = path.join(entry.dir, file);
      const source = fs.readFileSync(filePath, "utf8");
      if (source.includes(CSS_V2_MARKER) || source.includes(CSS_V1_MARKER) || isRendererTarget(source)) {
        targets.push({ kind: "renderer", platform: entry.platform, path: filePath });
      }
    }
  }
  return targets;
}

function locateMainTargets(platform) {
  return locateBundles({
    dir: "build",
    pattern: /^main(-[^.]+)?\.js$/,
    platform,
  }).map((target) => ({ kind: "main", ...target }));
}

function runSelfTest() {
  const currentMain =
    "shouldAlwaysUseOpaqueWindowSurface(e){return $8({appearance:e,opaqueWindowsEnabled:this.isOpaqueWindowsEnabled(),platform:process.platform})||!jM()&&!Z8(e)}";
  const currentPatched = patchMainSource(currentMain);
  if (!currentPatched.changed || !currentPatched.source.includes(MAIN_MARKER)) {
    throw new Error("current main-process sample was not patched");
  }
  if (patchMainSource(currentPatched.source).changed) {
    throw new Error("current main-process patch is not idempotent");
  }

  const modernMain =
    "shouldAlwaysUseOpaqueWindowSurface(e){return m5({appearance:e,opaqueWindowsEnabled:this.isOpaqueWindowsEnabled(),platform:process.platform})||!uP()&&!f5(e)}";
  const modernPatched = patchMainSource(modernMain);
  if (!modernPatched.changed || !modernPatched.source.includes(MAIN_MARKER)) {
    throw new Error("modern main-process sample was not patched");
  }
  if (!modernPatched.source.includes("process.platform===`linux`&&(e===`primary`")) {
    throw new Error("modern Linux opaque condition missing");
  }
  if (patchMainSource(modernPatched.source).changed) {
    throw new Error("modern main-process patch is not idempotent");
  }

  const legacyMain =
    "w=this.isOpaqueWindowsEnabled(),T=WY({appearance:l,opaqueWindowsEnabled:w,platform:process.platform});" +
    "function VY({platform:e,appearance:t,opaqueWindowsEnabled:n,prefersDarkColors:r}){return n&&!LY(t)&&(e===`darwin`||e===`win32`)?{backgroundColor:r?gY:_Y,backgroundMaterial:e===`win32`?`none`:null}:e===`win32`&&!LY(t)?{backgroundColor:hY,backgroundMaterial:`mica`}:{backgroundColor:hY,backgroundMaterial:null}}";
  const legacyPatched = patchMainSource(legacyMain);
  if (!legacyPatched.changed || !legacyPatched.source.includes(LEGACY_MAIN_MARKER)) {
    throw new Error("legacy main-process sample was not patched");
  }
  if (!legacyPatched.source.includes("e===`linux`&&(")) {
    throw new Error("legacy Linux background condition missing");
  }
  if (patchMainSource(legacyPatched.source).changed) {
    throw new Error("legacy main-process patch is not idempotent");
  }

  const renderer =
    "[data-codex-window-type=electron]{background:0 0;overflow:hidden}" +
    "[data-codex-window-type=electron]:not([data-codex-os=win32]) body{background:0 0}" +
    "[data-codex-window-type=electron]:not([data-codex-os=win32]) .app-shell-left-panel{background:color-mix(in srgb, var(--color-token-editor-background) 55%, transparent)}" +
    "[data-codex-window-type=electron]:not([data-codex-os=win32]) .app-shell-left-panel:after{background:inherit}";
  const rendererPatched = patchRendererSource(renderer);
  if (!rendererPatched.changed || !rendererPatched.source.includes(CSS_V2_MARKER)) {
    throw new Error("renderer sample was not patched");
  }
  if (patchRendererSource(rendererPatched.source).changed) {
    throw new Error("renderer patch is not idempotent");
  }

  console.log("[ok] linux opaque renderer patch self-test passed");
}

function applyTarget(target, isCheck) {
  const source = fs.readFileSync(target.path, "utf8");
  const patched =
    target.kind === "main" ? patchMainSource(source) : patchRendererSource(source);
  console.log(`\n-- [${target.platform}] ${relPath(target.path)}`);

  if (!patched.changed) {
    if (patched.reason.startsWith("already-patched")) {
      console.log(`   [ok] ${target.kind} already patched`);
      return true;
    }
    console.log(`   [!] ${target.kind} patch target not recognized (${patched.reason})`);
    return false;
  }

  if (isCheck) {
    console.log(`   [?] would patch Linux opaque ${target.kind}`);
  } else {
    fs.writeFileSync(target.path, patched.source, "utf8");
    console.log(`   [ok] Linux opaque ${target.kind} patched`);
  }
  return true;
}

function main() {
  const args = process.argv.slice(2);
  if (args.includes("--self-test")) {
    runSelfTest();
    return;
  }

  const isCheck = args.includes("--check");
  const platform = args.find((arg) => PLATFORM_ARGS.includes(arg));
  const targets = [...locateMainTargets(platform), ...locateRendererTargets(platform)];

  if (targets.length === 0) {
    console.error("[x] No Electron main or renderer bundle found for Linux opaque patch");
    process.exit(1);
  }

  let failed = 0;
  for (const target of targets) {
    if (!applyTarget(target, isCheck)) failed += 1;
  }
  if (failed > 0) process.exit(1);
}

main();
