#!/usr/bin/env node
/**
 * Webview patch: expose the Codex mobile UI entry in wrapper builds.
 *
 * Upstream ships the /codex-mobile route and setup page, but the sidebar entry
 * and announcement are guarded by internal feature gates. This wrapper enables
 * remote_control by default, which also hides the announcement. Keep the route
 * logic intact and only relax the entry-point gates.
 */
const fs = require("fs");
const path = require("path");
const os = require("os");
const { locateBundles, relPath, SRC_DIR } = require("./patch-util");

const MARKER = "codex-rebuild-codex-mobile-ui-entry";
const ANNOUNCEMENT_MARKER = "codex-rebuild-codex-mobile-announcement-enabled";

const SIDEBAR_GATE_RE =
  /function\s+([A-Za-z_$][\w$]*)\(\{enabled:e,hasCompletedCodexMobileSetup:t,remoteControlFeaturesVisible:n,remoteControlOnboardingEnabled:r\}\)\{return e&&n&&r&&!t\}/;

const ANNOUNCEMENT_GATE = "u=t&&i&&a&&!l&&!r&&!n&&!s";
const ANNOUNCEMENT_REPLACEMENT =
  `u=t&&i&&!r&&!n&&!s/* ${ANNOUNCEMENT_MARKER} */`;

function patchSource(source) {
  let next = source;
  let changed = false;

  if (!next.includes(MARKER)) {
    next = next.replace(SIDEBAR_GATE_RE, (match, fnName) => {
      changed = true;
      return `function ${fnName}({enabled:e,hasCompletedCodexMobileSetup:t,remoteControlFeaturesVisible:n,remoteControlOnboardingEnabled:r}){return e}/* ${MARKER} */`;
    });
  }

  if (!source.includes(MARKER) && !changed) {
    throw new Error("Codex mobile sidebar gate was not recognized");
  }

  if (!next.includes(ANNOUNCEMENT_MARKER)) {
    if (!next.includes(ANNOUNCEMENT_GATE)) {
      throw new Error("Codex mobile announcement gate was not recognized");
    }
    next = next.replace(ANNOUNCEMENT_GATE, ANNOUNCEMENT_REPLACEMENT);
    changed = true;
  }

  return { source: next, changed };
}

function locateTargets(platform) {
  const platformList =
    platform === "unix"
      ? ["mac-arm64", "mac-x64"]
      : platform
        ? [platform]
        : ["mac-arm64", "mac-x64", "win"].filter((p) =>
            fs.existsSync(path.join(SRC_DIR, p, "_asar", "webview", "assets")),
          );

  const targets = [];
  for (const plat of platformList) {
    targets.push(
      ...locateBundles({
        dir: "assets",
        pattern: /^app-main-.*\.js$/,
        platform: plat,
      }),
    );
  }

  const legacyDir = path.join(SRC_DIR, "webview", "assets");
  if (fs.existsSync(legacyDir)) {
    for (const file of fs.readdirSync(legacyDir)) {
      if (/^app-main-.*\.js$/.test(file)) {
        targets.push({ platform: "legacy", path: path.join(legacyDir, file) });
      }
    }
  }

  const seen = new Set();
  return targets.filter((target) => {
    if (seen.has(target.path)) return false;
    seen.add(target.path);
    return true;
  });
}

function runSelfTest() {
  const sample = [
    "function Yy({enabled:e,hasCompletedCodexMobileSetup:t,remoteControlFeaturesVisible:n,remoteControlOnboardingEnabled:r}){return e&&n&&r&&!t}",
    "function m_(){let e,t=Pg(),i=Ql(),a=ec(`2798711298`),l=o?.remote_control??!1,u=t&&i&&a&&!l&&!r&&!n&&!s,f;}",
  ].join("");
  const patched = patchSource(sample);
  if (!patched.changed) throw new Error("self-test did not patch");
  if (!patched.source.includes(`return e}/* ${MARKER} */`)) {
    throw new Error("sidebar gate was not relaxed");
  }
  if (!patched.source.includes(ANNOUNCEMENT_REPLACEMENT)) {
    throw new Error("announcement gate was not relaxed");
  }
  const again = patchSource(patched.source);
  if (again.changed) throw new Error("patch is not idempotent");
  const tmp = fs.mkdtempSync(path.join(os.tmpdir(), "codex-mobile-ui-"));
  fs.rmSync(tmp, { recursive: true, force: true });
  console.log("[ok] codex mobile UI patch self-test passed");
}

function main() {
  const args = process.argv.slice(2);
  if (args.includes("--self-test")) {
    runSelfTest();
    return;
  }

  const isCheck = args.includes("--check");
  const fileIndex = args.indexOf("--file");
  const explicitFile = fileIndex === -1 ? null : args[fileIndex + 1];
  if (fileIndex !== -1 && !explicitFile) {
    console.error("[x] Usage: patch-codex-mobile-ui.js --file <app-main-*.js>");
    process.exit(1);
  }
  if (explicitFile) {
    const source = fs.readFileSync(explicitFile, "utf8");
    const patched = patchSource(source);
    console.log(`\n-- [file] ${explicitFile}`);
    if (!patched.changed) {
      console.log("   [ok] Codex mobile UI entry already exposed");
    } else if (isCheck) {
      console.log("   [?] would expose Codex mobile UI entry");
    } else {
      fs.writeFileSync(explicitFile, patched.source, "utf8");
      console.log("   [ok] Codex mobile UI entry exposed");
    }
    return;
  }

  const platform = args.find((a) =>
    ["mac-arm64", "mac-x64", "win", "unix"].includes(a),
  );
  const targets = locateTargets(platform);
  if (targets.length === 0) {
    console.log("[ok] No app-main webview bundles found for Codex mobile UI patch");
    return;
  }

  for (const target of targets) {
    const source = fs.readFileSync(target.path, "utf8");
    const patched = patchSource(source);
    console.log(`\n-- [${target.platform}] ${relPath(target.path)}`);
    if (!patched.changed) {
      console.log("   [ok] Codex mobile UI entry already exposed");
      continue;
    }
    if (isCheck) {
      console.log("   [?] would expose Codex mobile UI entry");
    } else {
      fs.writeFileSync(target.path, patched.source, "utf8");
      console.log("   [ok] Codex mobile UI entry exposed");
    }
  }
}

main();
