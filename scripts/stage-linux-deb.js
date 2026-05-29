#!/usr/bin/env node

const fs = require("fs");
const path = require("path");

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

const SKIP_DIRS = new Set([
  ".git",
  "node_modules",
  "release-assets",
]);

function walkFiles(root) {
  const results = [];
  if (!fs.existsSync(root)) {
    return results;
  }

  const stack = [root];
  while (stack.length > 0) {
    const current = stack.pop();
    for (const entry of fs.readdirSync(current, { withFileTypes: true })) {
      const fullPath = path.join(current, entry.name);
      if (entry.isDirectory()) {
        if (SKIP_DIRS.has(entry.name)) {
          continue;
        }
        stack.push(fullPath);
      } else if (entry.isFile()) {
        results.push(fullPath);
      }
    }
  }
  return results.sort();
}

function printOutTree(root) {
  if (!fs.existsSync(root)) {
    console.error(`${root}/ does not exist.`);
    return;
  }

  console.error(`Files under ${root}/:`);
  for (const file of walkFiles(root).slice(0, 200)) {
    const relative = path.relative(root, file);
    const size = fs.statSync(file).size;
    console.error(`  ${relative} (${size} bytes)`);
  }
}

function debArchFor(arch) {
  switch (arch) {
    case "x64":
      return "amd64";
    case "arm64":
      return "arm64";
    default:
      throw new Error(`Unsupported arch: ${arch}`);
  }
}

function main() {
  const args = parseArgs(process.argv.slice(2));
  const arch = args.arch;
  const ubuntu = args.ubuntu;
  if (!arch) {
    throw new Error("Missing --arch");
  }
  if (!ubuntu) {
    throw new Error("Missing --ubuntu");
  }

  const debArch = debArchFor(arch);
  const version = require("../package.json").version;
  const searchRoots = [
    path.join(process.cwd(), "out"),
    path.join(process.cwd(), "src", "out"),
    process.cwd(),
  ];
  const seen = new Set();
  const debs = [];
  for (const root of searchRoots) {
    for (const file of walkFiles(root)) {
      if (!file.endsWith(".deb")) continue;
      const real = fs.realpathSync(file);
      if (seen.has(real)) continue;
      seen.add(real);
      debs.push(file);
    }
  }
  const matchingDebs = debs.filter((file) => path.basename(file).includes(`_${debArch}.deb`));
  const selected = matchingDebs[0] || debs[0];

  if (!selected) {
    console.error("No deb package found.");
    for (const root of searchRoots) {
      printOutTree(root);
    }
    process.exit(1);
  }

  console.log("Deb candidates:");
  for (const deb of debs) {
    console.log(`  ${deb}`);
  }

  fs.mkdirSync("release-assets", { recursive: true });
  const destination = path.join("release-assets", `codex_${version}_ubuntu${ubuntu}_${debArch}.deb`);
  fs.copyFileSync(selected, destination);
  console.log(`Staged ${selected} -> ${destination}`);
}

try {
  main();
} catch (error) {
  console.error(error instanceof Error ? error.message : String(error));
  process.exit(1);
}
