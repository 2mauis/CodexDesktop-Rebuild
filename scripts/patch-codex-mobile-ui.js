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
const { parse } = require("acorn");
const { locateBundles, relPath, SRC_DIR } = require("./patch-util");

const MARKER = "codex-rebuild-codex-mobile-ui-entry";
const ANNOUNCEMENT_MARKER = "codex-rebuild-codex-mobile-announcement-enabled";

const SIDEBAR_GATE_RE =
  /function\s+([A-Za-z_$][\w$]*)\(\{enabled:e,hasCompletedCodexMobileSetup:t,remoteControlFeaturesVisible:n,remoteControlOnboardingEnabled:r\}\)\{return e&&n&&r&&!t\}/;

const ANNOUNCEMENT_GATE = "u=t&&i&&a&&!l&&!r&&!n&&!s";
const ANNOUNCEMENT_REPLACEMENT =
  `u=t&&i&&!r&&!n&&!s/* ${ANNOUNCEMENT_MARKER} */`;

function walk(node, visitor) {
  if (!node || typeof node !== "object") return;
  if (node.type) visitor(node);
  for (const key of Object.keys(node)) {
    const child = node[key];
    if (Array.isArray(child)) {
      for (const item of child) {
        if (item && typeof item === "object" && item.type) walk(item, visitor);
      }
    } else if (child && typeof child === "object" && child.type) {
      walk(child, visitor);
    }
  }
}

function getLiteralValue(node) {
  if (!node) return null;
  if (node.type === "Literal") return node.value;
  if (
    node.type === "TemplateLiteral" &&
    node.expressions.length === 0 &&
    node.quasis.length === 1
  ) {
    return node.quasis[0].value.cooked;
  }
  return null;
}

function isStatsigGateCall(node) {
  if (!node || node.type !== "CallExpression") return false;
  if (node.callee?.type !== "Identifier") return false;
  if (node.arguments?.length !== 1) return false;
  const value = getLiteralValue(node.arguments[0]);
  return typeof value === "string" && /^\d{6,}$/.test(value);
}

function flattenLogicalAnd(node) {
  if (node?.type === "LogicalExpression" && node.operator === "&&") {
    return [...flattenLogicalAnd(node.left), ...flattenLogicalAnd(node.right)];
  }
  return [node];
}

function isFunctionNode(node) {
  return (
    node.type === "FunctionDeclaration" ||
    node.type === "FunctionExpression" ||
    node.type === "ArrowFunctionExpression"
  );
}

function identifiersFromPattern(pattern) {
  if (!pattern || typeof pattern !== "object") return [];
  if (pattern.type === "Identifier") return [pattern.name];
  if (pattern.type === "RestElement") return identifiersFromPattern(pattern.argument);
  if (pattern.type === "AssignmentPattern") return identifiersFromPattern(pattern.left);
  if (pattern.type === "ArrayPattern") {
    return pattern.elements.flatMap((element) => identifiersFromPattern(element));
  }
  if (pattern.type === "ObjectPattern") {
    return pattern.properties.flatMap((property) => {
      if (!property) return [];
      if (property.type === "RestElement") return identifiersFromPattern(property.argument);
      return identifiersFromPattern(property.value);
    });
  }
  return [];
}

function sourceFor(source, node) {
  return source.slice(node.start, node.end);
}

function isRemoteControlInit(source, node) {
  return sourceFor(source, node).includes("remote_control");
}

function isRemoteControlNegation(source, node, remoteVars) {
  if (node.type !== "UnaryExpression" || node.operator !== "!") return false;
  if (node.argument?.type === "Identifier" && remoteVars.has(node.argument.name)) {
    return true;
  }
  return isRemoteControlInit(source, node.argument);
}

function isStatsigGateTerm(node, statsigVars) {
  if (node.type === "Identifier" && statsigVars.has(node.name)) return true;
  return isStatsigGateCall(node);
}

function hasCodexMobileContext(source) {
  return (
    source.includes("codex-mobile") ||
    source.includes("codex_mobile") ||
    source.includes("CodexMobile") ||
    source.includes("Codex mobile") ||
    source.includes("CODEX_MOBILE_SETUP_COMPLETED")
  );
}

function findAnnouncementGatePatch(source) {
  const ast = parse(source, { ecmaVersion: "latest", sourceType: "module" });
  let best = null;

  walk(ast, (fn) => {
    if (!isFunctionNode(fn)) return;
    const fnSource = sourceFor(source, fn);
    const isCodexMobileAnnouncement = hasCodexMobileContext(fnSource);
    if (!fnSource.includes("remote_control") && !isCodexMobileAnnouncement) {
      return;
    }

    const remoteVars = new Set();
    const statsigVars = new Set();
    const protectedNegatedVars = new Set();

    walk(fn, (node) => {
      if (node.type !== "VariableDeclarator") return;
      if (!node.init) return;
      const initSource = sourceFor(source, node.init);

      if (node.id?.type === "Identifier" && isRemoteControlInit(source, node.init)) {
        remoteVars.add(node.id.name);
      }
      if (node.id?.type === "Identifier" && isStatsigGateCall(node.init)) {
        statsigVars.add(node.id.name);
      }
      if (initSource.includes("CODEX_MOBILE_SETUP_COMPLETED")) {
        for (const name of identifiersFromPattern(node.id)) {
          protectedNegatedVars.add(name);
        }
      }
      if (
        isCodexMobileAnnouncement &&
        node.id?.type === "ArrayPattern" &&
        node.init?.type === "CallExpression"
      ) {
        for (const name of identifiersFromPattern(node.id.elements[0])) {
          protectedNegatedVars.add(name);
        }
      }
    });

    if (remoteVars.size === 0 && !isCodexMobileAnnouncement) return;

    walk(fn, (node) => {
      if (node.type !== "VariableDeclarator" || !node.init) return;
      if (node.init.type !== "LogicalExpression" || node.init.operator !== "&&") {
        return;
      }

      const terms = flattenLogicalAnd(node.init);
      const kept = [];
      let removedRemote = false;
      let removedStatsig = false;
      let removedAnnouncementRemote = false;

      for (const term of terms) {
        if (isRemoteControlNegation(source, term, remoteVars)) {
          removedRemote = true;
          continue;
        }
        if (
          isCodexMobileAnnouncement &&
          remoteVars.size === 0 &&
          !removedAnnouncementRemote &&
          term.type === "UnaryExpression" &&
          term.operator === "!" &&
          term.argument?.type === "Identifier" &&
          !protectedNegatedVars.has(term.argument.name)
        ) {
          removedRemote = true;
          removedAnnouncementRemote = true;
          continue;
        }
        if (isStatsigGateTerm(term, statsigVars)) {
          removedStatsig = true;
          continue;
        }
        kept.push(term);
      }

      if (!removedRemote) return;
      if (!removedStatsig && !hasCodexMobileContext(fnSource)) return;
      if (kept.length === terms.length || kept.length === 0) return;

      const replacement =
        kept.map((term) => sourceFor(source, term)).join("&&") +
        `/* ${ANNOUNCEMENT_MARKER} */`;
      const score = (removedStatsig ? 2 : 0) + (hasCodexMobileContext(fnSource) ? 1 : 0);
      if (!best || score > best.score) {
        best = {
          start: node.init.start,
          end: node.init.end,
          replacement,
          score,
        };
      }
    });
  });

  return best;
}

function patchAnnouncementGate(source) {
  if (source.includes(ANNOUNCEMENT_MARKER)) {
    return { source, changed: false };
  }

  if (source.includes(ANNOUNCEMENT_GATE)) {
    return {
      source: source.replace(ANNOUNCEMENT_GATE, ANNOUNCEMENT_REPLACEMENT),
      changed: true,
    };
  }

  const patch = findAnnouncementGatePatch(source);
  if (!patch) {
    return { source, changed: false, skipped: true };
  }

  return {
    source:
      source.slice(0, patch.start) +
      patch.replacement +
      source.slice(patch.end),
    changed: true,
  };
}

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
    const patched = patchAnnouncementGate(next);
    next = patched.source;
    changed = changed || patched.changed;
    if (patched.skipped) {
      console.warn(
        "   [!] Codex mobile announcement gate was not recognized; sidebar entry remains exposed",
      );
    }
  }

  return { source: next, changed };
}

function locateTargets(platform) {
  const legacyDir = path.join(SRC_DIR, "webview", "assets");
  const legacyTargets = [];
  if (fs.existsSync(legacyDir)) {
    for (const file of fs.readdirSync(legacyDir)) {
      if (/^app-main-.*\.js$/.test(file)) {
        legacyTargets.push({
          platform: "linux",
          path: path.join(legacyDir, file),
        });
      }
    }
  }
  if (platform === "linux" || platform?.startsWith("linux-")) {
    return legacyTargets;
  }

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

  targets.push(...legacyTargets);

  const seen = new Set();
  return targets.filter((target) => {
    if (seen.has(target.path)) return false;
    seen.add(target.path);
    return true;
  });
}

function runSelfTest() {
  const oldSample = [
    "function Yy({enabled:e,hasCompletedCodexMobileSetup:t,remoteControlFeaturesVisible:n,remoteControlOnboardingEnabled:r}){return e&&n&&r&&!t}",
    "function m_(){let e,t=Pg(),i=Ql(),a=ec(`2798711298`),l=o?.remote_control??!1,u=t&&i&&a&&!l&&!r&&!n&&!s,f;}",
  ].join("");
  const patched = patchSource(oldSample);
  if (!patched.changed) throw new Error("self-test did not patch");
  if (!patched.source.includes(`return e}/* ${MARKER} */`)) {
    throw new Error("sidebar gate was not relaxed");
  }
  if (!patched.source.includes(ANNOUNCEMENT_REPLACEMENT)) {
    throw new Error("announcement gate was not relaxed");
  }
  const again = patchSource(patched.source);
  if (again.changed) throw new Error("patch is not idempotent");

  const reorderedSample = [
    "function Yy({enabled:e,hasCompletedCodexMobileSetup:t,remoteControlFeaturesVisible:n,remoteControlOnboardingEnabled:r}){return e&&n&&r&&!t}",
    "function q_(){let e,t=Pg(),i=Ql(),r=o?.remote_control??!1,a=ec(\"2798711298\"),u=t&&i&&!n&&a&&!r&&!s,f=\"codex-mobile\";}",
  ].join("");
  const reordered = patchSource(reorderedSample);
  if (!reordered.changed) throw new Error("reordered self-test did not patch");
  if (!reordered.source.includes(`u=t&&i&&!n&&!s/* ${ANNOUNCEMENT_MARKER} */`)) {
    throw new Error("reordered announcement gate was not relaxed");
  }

  const noStatsigSample = [
    "function Yy({enabled:e,hasCompletedCodexMobileSetup:t,remoteControlFeaturesVisible:n,remoteControlOnboardingEnabled:r}){return e&&n&&r&&!t}",
    "function z_(){let e,t=Pg(),i=Ql(),l=o?.remote_control??!1,u=t&&i&&!l&&!r&&!n&&!s,f=\"codex-mobile\";}",
  ].join("");
  const noStatsig = patchSource(noStatsigSample);
  if (!noStatsig.changed) throw new Error("no-statsig self-test did not patch");
  if (!noStatsig.source.includes(`u=t&&i&&!r&&!n&&!s/* ${ANNOUNCEMENT_MARKER} */`)) {
    throw new Error("no-statsig announcement gate was not relaxed");
  }

  const completedSetupSample = [
    "function Yy({enabled:e,hasCompletedCodexMobileSetup:t,remoteControlFeaturesVisible:n,remoteControlOnboardingEnabled:r}){return e&&n&&r&&!t}",
    "function T_(){let e=(0,Z.c)(14),t=Gg(),{data:n,isLoading:r}=qi(z.CODEX_MOBILE_SETUP_COMPLETED),i=wc(),a=Li(`2798711298`),o=K(tt,Tt),[s,c]=pn(Qg),l=t&&i&&a&&!o&&!r&&!n&&!s,u;}",
  ].join("");
  const completedSetup = patchSource(completedSetupSample);
  if (!completedSetup.changed) {
    throw new Error("completed-setup self-test did not patch");
  }
  if (!completedSetup.source.includes(`l=t&&i&&!r&&!n&&!s/* ${ANNOUNCEMENT_MARKER} */`)) {
    throw new Error("completed-setup announcement gate was not relaxed");
  }

  const missingAnnouncementSample = [
    "function Yy({enabled:e,hasCompletedCodexMobileSetup:t,remoteControlFeaturesVisible:n,remoteControlOnboardingEnabled:r}){return e&&n&&r&&!t}",
    "function A_(){let e=\"codex-mobile\";return e}",
  ].join("");
  const missingAnnouncement = patchSource(missingAnnouncementSample);
  if (!missingAnnouncement.changed) {
    throw new Error("missing-announcement self-test did not patch sidebar");
  }
  if (!missingAnnouncement.source.includes(`return e}/* ${MARKER} */`)) {
    throw new Error("missing-announcement sidebar gate was not relaxed");
  }

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
    console.error("[x] Usage: patch-codex-mobile-ui.js [linux|mac-arm64|mac-x64|win|unix] --file <app-main-*.js>");
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
    ["linux", "linux-x64", "linux-arm64", "mac-arm64", "mac-x64", "win", "unix"].includes(a),
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
