#!/usr/bin/env node

const fs = require("fs");
const path = require("path");
const { spawnSync } = require("child_process");

function parseArgs(argv) {
  const args = {};
  for (let i = 0; i < argv.length; i += 1) {
    const arg = argv[i];
    if (!arg.startsWith("--")) {
      throw new Error(`Unexpected argument: ${arg}`);
    }
    const key = arg.slice(2);
    const value = argv[i + 1];
    if (!value || value.startsWith("--")) {
      throw new Error(`Missing value for --${key}`);
    }
    args[key] = value;
    i += 1;
  }
  return args;
}

function run(command, args, options = {}) {
  console.log(`\n$ ${[command, ...args].join(" ")}`);
  const result = spawnSync(command, args, {
    stdio: "inherit",
    shell: false,
    env: process.env,
    ...options,
  });

  if (result.error) {
    throw result.error;
  }
  if (result.status !== 0) {
    throw new Error(`${command} ${args.join(" ")} exited with ${result.status}`);
  }
}

function collectFiles(root, predicate) {
  const files = [];
  if (!fs.existsSync(root)) {
    return files;
  }

  const stack = [root];
  while (stack.length > 0) {
    const current = stack.pop();
    for (const entry of fs.readdirSync(current, { withFileTypes: true })) {
      const fullPath = path.join(current, entry.name);
      if (entry.isDirectory()) {
        stack.push(fullPath);
      } else if (entry.isFile() && predicate(fullPath)) {
        files.push(fullPath);
      }
    }
  }
  return files.sort();
}

function printTree(root, limit = 160) {
  if (!fs.existsSync(root)) {
    console.error(`${root}/ does not exist.`);
    return;
  }

  console.error(`Files under ${root}/:`);
  const files = collectFiles(root, () => true);
  for (const file of files.slice(0, limit)) {
    const stat = fs.statSync(file);
    console.error(`  ${path.relative(root, file)} (${stat.size} bytes)`);
  }
  if (files.length > limit) {
    console.error(`  ... ${files.length - limit} more file(s) omitted`);
  }
}

function assertDebProduced() {
  const outDir = path.join(process.cwd(), "out");
  const debs = collectFiles(outDir, (file) => file.endsWith(".deb"));
  if (debs.length === 0) {
    console.error("\nNo .deb package was produced by the Linux build.");
    printTree(outDir);
    printTree(path.join(process.cwd(), "src"), 80);
    process.exit(1);
  }

  console.log("\nDeb packages produced:");
  for (const deb of debs) {
    console.log(`  ${deb}`);
  }
}

function main() {
  const args = parseArgs(process.argv.slice(2));
  const arch = args.arch;
  if (!["x64", "arm64"].includes(arch)) {
    throw new Error("Usage: build-linux-deb.js --arch <x64|arm64>");
  }

  const platform = `linux-${arch}`;
  console.log(`== build-linux-deb: ${platform} ==`);
  console.log(`node: ${process.version}`);
  run("npm", ["--version"]);

  run("node", ["scripts/prepare-src.js", "--platform", platform]);
  run("node", ["scripts/patch-all.js", "linux"]);
  run("node", ["scripts/patch-better-sqlite3-electron42.js"]);
  run("npm", ["run", "rebuild:native"]);
  run("node", ["scripts/sync-native-modules.js", "--platform", platform]);

  fs.rmSync(path.join(process.cwd(), "out"), { recursive: true, force: true });
  run("npx", ["--no-install", "electron-forge", "make", "--platform=linux", `--arch=${arch}`]);
  assertDebProduced();
}

try {
  main();
} catch (error) {
  console.error(error instanceof Error ? error.message : String(error));
  process.exit(1);
}
