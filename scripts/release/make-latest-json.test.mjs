import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, writeFileSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { spawnSync } from "node:child_process";
import { fileURLToPath } from "node:url";

function fixture(run) {
  const dir = mkdtempSync(join(tmpdir(), "stardeskbox-manifest-"));
  const installer = "StarDeskBox_0.1.1_x64-setup.exe";
  const signature = Buffer.from("untrusted comment: signature\nfixture\ntrusted comment: version:0.1.1\nfixture\n").toString("base64");
  writeFileSync(join(dir, installer), "installer");
  writeFileSync(join(dir, installer + ".sig"), signature);
  const generate = (extra = []) => spawnSync(process.execPath, [
    fileURLToPath(new URL("./make-latest-json.mjs", import.meta.url)),
    "--version", "0.1.1", ...(extra.includes("--base-url") ? [] : ["--base-url", "https://github.com/liulewis67-ops/StarDeskBox/releases/download/v0.1.1"]),
    "--bundle-dir", dir, "--out", join(dir, "latest.json"), ...extra,
  ], { encoding: "utf8" });
  try { run({ dir, installer, signature, generate }); }
  finally { rmSync(dir, { recursive: true, force: true }); }
}

test("publishes the exact installer URL, signature and release notes", () => fixture(({ dir, signature, generate }) => {
  writeFileSync(join(dir, "notes.md"), "修复更新\n");
  assert.equal(generate(["--notes-file", join(dir, "notes.md")]).status, 0);
  const manifest = JSON.parse(readFileSync(join(dir, "latest.json"), "utf8"));
  assert.equal(manifest.version, "0.1.1");
  assert.equal(manifest.notes, "修复更新");
  assert.deepEqual(manifest.platforms["windows-x86_64"], {
    signature, url: "https://github.com/liulewis67-ops/StarDeskBox/releases/download/v0.1.1/StarDeskBox_0.1.1_x64-setup.exe",
  });
}));

test("rejects a missing signature", () => fixture(({ dir, installer, generate }) => {
  rmSync(join(dir, installer + ".sig"));
  assert.notEqual(generate().status, 0);
}));
test("rejects an empty signature", () => fixture(({ dir, installer, generate }) => {
  writeFileSync(join(dir, installer + ".sig"), "\n");
  assert.notEqual(generate().status, 0);
}));
test("rejects ambiguous installers", () => fixture(({ dir, generate }) => {
  writeFileSync(join(dir, "Other_0.1.1_x64-setup.exe"), "other");
  assert.notEqual(generate().status, 0);
}));
test("rejects insecure download URLs", () => fixture(({ generate }) => {
  assert.notEqual(generate(["--base-url", "http://example.com"]).status, 0);
}));
