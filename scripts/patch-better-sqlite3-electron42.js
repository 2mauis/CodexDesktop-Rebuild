#!/usr/bin/env node
/**
 * Build-time patch: make better-sqlite3 compile against Electron 42 headers.
 *
 * Electron 42 enables newer V8 external pointer APIs. Current better-sqlite3
 * releases still call v8::External::Value() without a tag and pass `0` as the
 * SetNativeDataProperty setter, which becomes ambiguous with the Electron 42
 * headers used by electron-rebuild.
 */
const fs = require("fs");
const path = require("path");

const PROJECT_ROOT = path.join(__dirname, "..");
const MODULE_ROOT = path.join(PROJECT_ROOT, "node_modules", "better-sqlite3");
const MACROS_FILE = path.join(MODULE_ROOT, "src", "util", "macros.cpp");
const HELPERS_FILE = path.join(MODULE_ROOT, "src", "util", "helpers.cpp");

const VALUE_MARKER = "BETTER_SQLITE3_EXTERNAL_VALUE";

function patchText(file, patcher) {
  if (!fs.existsSync(file)) {
    console.log(`[skip] ${path.relative(PROJECT_ROOT, file)} not found`);
    return false;
  }

  const before = fs.readFileSync(file, "utf8");
  const after = patcher(before);
  if (after === before) {
    console.log(`[ok] ${path.relative(PROJECT_ROOT, file)} already compatible`);
    return false;
  }

  fs.writeFileSync(file, after, "utf8");
  console.log(`[ok] patched ${path.relative(PROJECT_ROOT, file)}`);
  return true;
}

function patchMacros(source) {
  const newBlock = [
    "#define BETTER_SQLITE3_EXTERNAL_VALUE(external) ((external)->Value(v8::kExternalPointerTypeTagDefault))",
    "#define OnlyAddon static_cast<Addon*>(BETTER_SQLITE3_EXTERNAL_VALUE(info.Data().As<v8::External>()))",
  ].join("\n");

  if (source.includes(newBlock)) return source;

  const oldConditionalBlock = [
    "#if defined(V8_ENABLE_SANDBOX)",
    "#define BETTER_SQLITE3_EXTERNAL_VALUE(external) ((external)->Value(v8::kExternalPointerTypeTagDefault))",
    "#else",
    "#define BETTER_SQLITE3_EXTERNAL_VALUE(external) ((external)->Value())",
    "#endif",
    "#define OnlyAddon static_cast<Addon*>(BETTER_SQLITE3_EXTERNAL_VALUE(info.Data().As<v8::External>()))",
  ].join("\n");

  if (source.includes(oldConditionalBlock)) {
    return source.replace(oldConditionalBlock, newBlock);
  }

  if (source.includes(VALUE_MARKER)) {
    throw new Error("Found an unexpected better-sqlite3 external-value patch");
  }

  const oldLine =
    "#define OnlyAddon static_cast<Addon*>(info.Data().As<v8::External>()->Value())";

  if (!source.includes(oldLine)) {
    throw new Error("Unable to find better-sqlite3 OnlyAddon macro to patch");
  }
  return source.replace(oldLine, newBlock);
}

function patchHelpers(source) {
  const patched = source.replace(
    /(\bSetNativeDataProperty\(\s*[\s\S]*?\n\s*func,\n\s*)0(\s*,\n\s*data\s*\))/,
    "$1nullptr$2",
  );

  if (patched !== source) return patched;

  if (
    /\bSetNativeDataProperty\(\s*[\s\S]*?\n\s*func,\n\s*nullptr\s*,\n\s*data\s*\)/.test(
      source,
    )
  ) {
    return source;
  }

  throw new Error("Unable to find better-sqlite3 SetNativeDataProperty setter to patch");
}

function runSelfTest() {
  const macros = patchMacros(
    [
      "#define OnlyContext isolate->GetCurrentContext()",
      "#define OnlyAddon static_cast<Addon*>(info.Data().As<v8::External>()->Value())",
      "#define UseIsolate v8::Isolate* isolate = OnlyIsolate",
    ].join("\n"),
  );
  if (!macros.includes("kExternalPointerTypeTagDefault")) {
    throw new Error("macro self-test did not add external pointer tag");
  }

  const helpers = patchHelpers(
    [
      "recv->InstanceTemplate()->SetNativeDataProperty(",
      "\tInternalizedFromLatin1(isolate, name),",
      "\tfunc,",
      "\t0,",
      "\tdata",
      ");",
    ].join("\n"),
  );
  if (!helpers.includes("\tnullptr,")) {
    throw new Error("helper self-test did not disambiguate setter");
  }

  console.log("[ok] better-sqlite3 Electron 42 patch self-test passed");
}

function main() {
  if (process.argv.includes("--self-test")) {
    runSelfTest();
    return;
  }

  patchText(MACROS_FILE, patchMacros);
  patchText(HELPERS_FILE, patchHelpers);
}

main();
