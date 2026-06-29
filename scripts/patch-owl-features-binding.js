#!/usr/bin/env node
/**
 * Guard Electron's private owl feature binding lookup.
 *
 * Some Linux Electron builds do not link electron_common_owl_features. The
 * upstream bundle calls process._linkedBinding directly during bootstrap, which
 * aborts the desktop app before the main window can start. Treat a missing
 * binding as "all owl features disabled" instead.
 */
const fs = require("fs");
const path = require("path");
const { locateBundles, relPath } = require("./patch-util");

const FEATURE_BINDING = "electron_common_owl_features";

function patchSource(source) {
  if (
    source.includes(`process._linkedBinding;if(typeof`) &&
    source.includes(FEATURE_BINDING)
  ) {
    return { source, changed: false };
  }

  const patterns = [
    /function ([A-Za-z_$][\w$]*)\(\)\{return ([A-Za-z_$][\w$]*)\.parse\(process\._linkedBinding\(`electron_common_owl_features`\)\)\}/,
    /function ([A-Za-z_$][\w$]*)\(\)\{return ([A-Za-z_$][\w$]*)\.parse\(process\._linkedBinding\("electron_common_owl_features"\)\)\}/,
    /function ([A-Za-z_$][\w$]*)\(\)\{return ([A-Za-z_$][\w$]*)\.parse\(process\._linkedBinding\('electron_common_owl_features'\)\)\}/,
  ];

  for (const pattern of patterns) {
    const match = source.match(pattern);
    if (!match) continue;

    const [, functionName, schemaName] = match;
    const replacement =
      `function ${functionName}(){let e=process._linkedBinding;` +
      `if(typeof e!=\`function\`)return {isOwlFeatureEnabled:()=>!1};` +
      `try{return ${schemaName}.parse(e.call(process,\`${FEATURE_BINDING}\`))}` +
      `catch{return {isOwlFeatureEnabled:()=>!1}}}`;

    return { source: source.replace(pattern, replacement), changed: true };
  }

  throw new Error("owl feature binding pattern not found");
}

function selfTest() {
  const input =
    "const Ge=t.pc({isOwlFeatureEnabled:t.sc(e=>typeof e==`function`)});" +
    "function Ze(e){return Qe().isOwlFeatureEnabled(e)}" +
    "function Qe(){return Ge.parse(process._linkedBinding(`electron_common_owl_features`))}" +
    "function $e(){return true}";
  const patched = patchSource(input);
  if (!patched.changed) throw new Error("self-test did not patch");
  if (!patched.source.includes("try{return Ge.parse(e.call(process,`electron_common_owl_features`))}")) {
    throw new Error("self-test missing guarded linkedBinding call");
  }
  const second = patchSource(patched.source);
  if (second.changed) throw new Error("self-test patch is not idempotent");
  console.log("[ok] owl features binding patch self-test passed");
}

function main() {
  const args = process.argv.slice(2);
  if (args.includes("--self-test")) {
    selfTest();
    return;
  }

  const platform = args.find((a) =>
    ["linux", "linux-x64", "linux-arm64", "mac-arm64", "mac-x64", "win", "unix"].includes(a),
  );

  const platforms = platform === "unix" ? ["mac-arm64", "mac-x64", "linux"] : [platform].filter(Boolean);
  const bundles = (platforms.length > 0 ? platforms : [undefined]).flatMap((target) =>
    locateBundles({
      dir: "build",
      pattern: /^workspace-root-drop-handler-.*\.js$/,
      platform: target,
    }),
  );

  if (bundles.length === 0) {
    console.log("[ok] No workspace root drop handler bundles found for owl features binding patch");
    return;
  }

  let changed = 0;
  for (const bundle of bundles) {
    const source = fs.readFileSync(bundle.path, "utf-8");
    const result = patchSource(source);
    if (!result.changed) {
      console.log(`  [ok] ${relPath(bundle.path)}: already patched`);
      continue;
    }
    fs.writeFileSync(bundle.path, result.source);
    console.log(`  [ok] ${relPath(bundle.path)}: guarded missing ${FEATURE_BINDING}`);
    changed++;
  }

  console.log(`  [done] ${changed} file(s) patched`);
}

if (require.main === module) {
  try {
    main();
  } catch (error) {
    console.error(error instanceof Error ? error.message : String(error));
    process.exit(1);
  }
}

module.exports = { patchSource };
