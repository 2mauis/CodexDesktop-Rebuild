#!/usr/bin/env node
/**
 * Main-process patch: enable remote features in Codex config by default.
 *
 * At app startup, ensure the user's Codex config contains:
 *
 *   CODEX_HOME/config.toml, or ~/.codex/config.toml by default on Linux/Unix
 *
 *   [features]
 *   remote_connections = true
 *   remote_control = true
 *
 * This mirrors `codex features enable remote_connections` and
 * `codex features enable remote_control`, but makes rebuilt desktop apps work
 * out of the box for remote mobile connections.
 */
const fs = require("fs");
const path = require("path");
const os = require("os");
const { execFileSync } = require("child_process");
const { SRC_DIR, relPath } = require("./patch-util");

const MARKER = "codex-rebuild-remote-config-defaults";
const CLEANUP_MARKER = "codex-rebuild-remote-control-cleanup-disabled";

const INJECTION =
  [
    `/* ${MARKER} */`,
    ";(()=>{try{",
    'const fs=require("fs"),path=require("path"),os=require("os");',
    'const dir=process.env.CODEX_HOME||path.join(os.homedir(),".codex");',
    'const file=path.join(dir,"config.toml");',
    "function ensureFlag(text,key){",
    "  const body=text.replace(/\\r?\\n$/,'');",
    "  const lines=body.length?body.split(/\\r?\\n/):[];",
    "  let start=-1,end=lines.length;",
    "  for(let i=0;i<lines.length;i++){",
    "    if(/^\\s*\\[features\\]\\s*(?:#.*)?$/.test(lines[i])){start=i;break;}",
    "  }",
    "  if(start===-1){",
    "    if(lines.length&&lines[lines.length-1]!==\"\")lines.push(\"\");",
    '    lines.push("[features]",`${key} = true`);',
    '    return `${lines.join("\\n")}\\n`;',
    "  }",
    "  for(let i=start+1;i<lines.length;i++){",
    "    if(/^\\s*\\[[^\\]]+\\]\\s*(?:#.*)?$/.test(lines[i])){end=i;break;}",
    "  }",
    '  const keyRe=new RegExp("^\\\\s*"+key+"\\\\s*=");',
    "  for(let i=start+1;i<end;i++){",
    '    if(keyRe.test(lines[i])){lines[i]=`${key} = true`;return `${lines.join("\\n")}\\n`; }',
    "  }",
    '  lines.splice(end,0,`${key} = true`);',
    '  return `${lines.join("\\n")}\\n`;',
    "}",
    "fs.mkdirSync(dir,{recursive:true});",
    "let text='';",
    "try{text=fs.readFileSync(file,'utf8');}catch(e){if(!e||e.code!=='ENOENT')return;}",
    "let next=text;",
    "for(const key of ['remote_connections','remote_control'])next=ensureFlag(next,key);",
    "if(next!==text)fs.writeFileSync(file,next,'utf8');",
    "}catch{}})();",
    "",
  ].join("\n");

const IDENT = "[A-Za-z_$][\\w$]*";
const REMOTE_CONTROL_LITERAL = "(?:`remote_control`|\"remote_control\"|'remote_control')";
const REMOTE_CONTROL_DETECTOR_RE = new RegExp(
  `function\\s+(${IDENT})\\(e\\)\\{return Object\\.hasOwn\\(e,${REMOTE_CONTROL_LITERAL}\\)\\|\\|(${IDENT})\\(e\\.features\\)&&Object\\.hasOwn\\(e\\.features,${REMOTE_CONTROL_LITERAL}\\)\\}`,
);

function disableRemoteControlCleanup(source) {
  if (source.includes(CLEANUP_MARKER)) {
    return { source, changed: false, status: "already-disabled" };
  }

  if (!source.includes("Removed remote_control from config before app-server start")) {
    return { source, changed: false, status: "not-present" };
  }

  let patched = false;
  const next = source.replace(REMOTE_CONTROL_DETECTOR_RE, (match, fnName) => {
    patched = true;
    return `function ${fnName}(e){return !1}/* ${CLEANUP_MARKER} */`;
  });

  if (!patched) {
    throw new Error("remote_control cleanup marker found, but detector function was not recognized");
  }

  return { source: next, changed: true, status: "disabled" };
}

function locateTargets(platform) {
  const isLinux = platform === "linux" || platform?.startsWith("linux-");
  const platforms = platform
    ? [platform]
    : ["mac-arm64", "mac-x64", "win"].filter((p) =>
        fs.existsSync(path.join(SRC_DIR, p, "_asar", ".vite", "build")),
      );

  const targets = [];
  for (const plat of platforms) {
    const buildDir = isLinux
      ? path.join(SRC_DIR, ".vite", "build")
      : path.join(SRC_DIR, plat, "_asar", ".vite", "build");
    if (!fs.existsSync(buildDir)) continue;
    for (const file of fs.readdirSync(buildDir)) {
      if (file.startsWith("main-") && file.endsWith(".js")) {
        targets.push({ platform: plat, path: path.join(buildDir, file) });
      }
    }
  }
  return targets;
}

function runSelfTest() {
  const tmp = fs.mkdtempSync(path.join(os.tmpdir(), "codex-remote-config-"));
  const configPath = path.join(tmp, "config.toml");
  const runInjection = () =>
    execFileSync(process.execPath, ["-e", INJECTION], {
      env: { ...process.env, CODEX_HOME: tmp },
      stdio: "pipe",
    });

  runInjection();
  let text = fs.readFileSync(configPath, "utf8");
  if (!text.includes("[features]")) throw new Error("missing [features]");
  if (!text.includes("remote_connections = true"))
    throw new Error("missing remote_connections");
  if (!text.includes("remote_control = true")) throw new Error("missing remote_control");

  fs.writeFileSync(
    configPath,
    ["model = \"gpt-5\"", "", "[features]", "remote_control = false", "", "[other]", "x = 1", ""].join("\n"),
    "utf8",
  );
  runInjection();
  text = fs.readFileSync(configPath, "utf8");
  if (!text.includes("remote_control = true"))
    throw new Error("remote_control was not forced true");
  if (!text.includes("remote_connections = true"))
    throw new Error("remote_connections was not inserted");
  if (text.indexOf("remote_connections = true") > text.indexOf("[other]"))
    throw new Error("remote_connections inserted outside [features]");

  const cleanupSource = [
    "async function vV({codexHome:e,hostConfig:n,logger:r=t.Jr()}){",
    "if(n.kind===`local`)try{",
    "await yV(i.default.join(e??t.Rr({hostConfig:n,preferWsl:t.Kr(n)}),_V))&&r.info(`Removed remote_control from config before app-server start`)",
    "}catch(e){r.warning(`Failed to remove remote_control before app-server start`)}",
    "}",
    "function xV(e){return Object.hasOwn(e,`remote_control`)||SV(e.features)&&Object.hasOwn(e.features,`remote_control`)}",
  ].join("");
  const cleanup = disableRemoteControlCleanup(cleanupSource);
  if (!cleanup.changed) throw new Error("remote_control cleanup was not disabled");
  if (!cleanup.source.includes(CLEANUP_MARKER))
    throw new Error("missing remote_control cleanup marker");
  if (!cleanup.source.includes("function xV(e){return !1}"))
    throw new Error("remote_control detector was not patched to return false");
  const cleanupAgain = disableRemoteControlCleanup(cleanup.source);
  if (cleanupAgain.changed || cleanupAgain.status !== "already-disabled")
    throw new Error("remote_control cleanup patch is not idempotent");

  fs.rmSync(tmp, { recursive: true, force: true });
  console.log("[ok] remote config injection self-test passed");
}

function main() {
  const args = process.argv.slice(2);
  if (args.includes("--self-test")) {
    runSelfTest();
    return;
  }

  const isCheck = args.includes("--check");
  const platform = args.find((a) =>
    ["linux", "mac-arm64", "mac-x64", "win"].includes(a),
  );
  const targets = locateTargets(platform);

  if (targets.length === 0) {
    console.log("[ok] No main process bundles found for remote config defaults");
    return;
  }

  for (const target of targets) {
    const source = fs.readFileSync(target.path, "utf8");
    let next = source;
    let changed = false;
    console.log(`\n-- [${target.platform}] ${relPath(target.path)}`);

    if (next.includes(MARKER)) {
      console.log("   [ok] remote config defaults already injected");
    } else if (isCheck) {
      console.log("   [?] would inject remote config defaults");
      changed = true;
    } else {
      next = INJECTION + next;
      changed = true;
      console.log("   [ok] remote config defaults injected");
    }

    const cleanup = disableRemoteControlCleanup(next);
    if (cleanup.status === "already-disabled") {
      console.log("   [ok] remote_control cleanup already disabled");
    } else if (cleanup.status === "not-present") {
      console.log("   [ok] remote_control cleanup not present");
    } else if (cleanup.changed) {
      if (isCheck) {
        console.log("   [?] would disable remote_control cleanup");
      } else {
        console.log("   [ok] remote_control cleanup disabled");
      }
      next = cleanup.source;
      changed = true;
    }

    if (!isCheck && changed) {
      fs.writeFileSync(target.path, next, "utf8");
    }
  }
}

main();
