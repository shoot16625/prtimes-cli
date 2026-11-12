import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { test } from "bun:test";

const root = join(import.meta.dir, "..");
const readJson = (path: string) => JSON.parse(readFileSync(join(root, path), "utf8"));

const manifests = [
  ".claude-plugin/plugin.json",
  ".codex-plugin/plugin.json",
  ".cursor-plugin/plugin.json",
  ".devin-plugin/plugin.json",
  ".kimi-plugin/plugin.json",
  ".antigravity-plugin/plugin.json",
  "gemini-extension.json",
];

test("every harness manifest matches package.json name and version", () => {
  const pkg = readJson("package.json");
  for (const path of manifests) {
    const m = readJson(path);
    assert.equal(m.name, pkg.name, path);
    assert.equal(m.version, pkg.version, path);
  }
});

test("every published manifest is included in package files", () => {
  const files: string[] = readJson("package.json").files;
  for (const path of manifests) {
    const top = path.split("/")[0]!;
    assert.ok(files.includes(top), `${top} missing from package.json files`);
  }
  assert.ok(files.includes("GEMINI.md"));
});
