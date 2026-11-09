import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdirSync, mkdtempSync, readFileSync, readdirSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { lint } from "../src/lint.mjs";
import { discover } from "../src/discover.mjs";
import { SPECS } from "../src/util.mjs";

const brand = { bg: "#000000", ink: "#ffffff", accent: "#6ff2c8" };
const shot = (id, title) => ({ id, raw: id, layout: "hero", title });
function app(titles, extra = {}) {
  const dir = mkdtempSync(join(tmpdir(), "lobby-"));
  return { dir, out: join(dir, "out"), raw: { iphone: [], ipad: [], duo: [] }, m: { slug: "x", name: "X", stores: ["web"], brand, shots: titles.map((t, i) => shot(`s${i}`, t)), ...extra } };
}
const titles = ["Clear the row", "Stick the landing", "Beat your score"];

test("a clean manifest has no claim errors", async () => {
  const r = await lint(app(titles));
  assert.equal(r.errors.filter((e) => /claim|proof|best/i.test(e)).length, 0);
});
test("unprovable claims fail lint", async () => {
  const base = (await lint(app(titles))).errors.length;
  for (const claim of ["The best remote", "#1 in sports", "Rated 5 stars"]) {
    const r = await lint(app([claim, titles[1], titles[2]]));
    assert.ok(r.errors.length > base, `"${claim}" should add an error`);
  }
});
test("low contrast fails lint", async () => {
  const r = await lint(app(titles, { brand: { ...brand, ink: "#111111" } }));
  assert.ok(r.errors.some((e) => /contrast/.test(e)));
});
test("nothing in the engine can submit an app for review", () => {
  const dirs = ["src", "bin"];
  for (const d of dirs) for (const f of readdirSync(d)) {
    const s = readFileSync(join(d, f), "utf8");
    assert.ok(!/reviewSubmission/i.test(s.replace(/^\s*\/\/.*$/gm, "")), `${d}/${f} mentions review submissions`);
  }
});
test("iPad targets need an iPad app", () => {
  for (const [k, t] of Object.entries(SPECS.appstore.targets)) if (/ipad/i.test(k)) assert.equal(t.required, "ipad", k);
});
test("discovery finds a real checkout and skips a linked worktree", () => {
  const root = mkdtempSync(join(tmpdir(), "projects-"));
  mkdirSync(join(root, "real", ".git"), { recursive: true });
  writeFileSync(join(root, "real", "project.yml"), "PRODUCT_BUNDLE_IDENTIFIER: com.example.real\n");
  mkdirSync(join(root, "copy"));
  writeFileSync(join(root, "copy", ".git"), "gitdir: ../real/.git/worktrees/copy\n");
  writeFileSync(join(root, "copy", "project.yml"), "PRODUCT_BUNDLE_IDENTIFIER: com.example.copy\n");
  assert.deepEqual(discover(root).map((a) => a.slug), ["real"]);
});
test("a UI-test target is not the app's bundle id", () => {
  const root = mkdtempSync(join(tmpdir(), "projects-"));
  mkdirSync(join(root, "app", ".git"), { recursive: true });
  writeFileSync(join(root, "app", "project.yml"), "PRODUCT_BUNDLE_IDENTIFIER: com.example.AppUITests\nPRODUCT_BUNDLE_IDENTIFIER: com.example.app\n");
  assert.deepEqual(discover(root)[0].ios, ["com.example.app"]);
});

