import "./helpers/setup.mjs";
import test, { beforeEach } from "node:test";
import assert from "node:assert/strict";
import { mkdirSync, writeFileSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { makeRepo, scratch, sh } from "./helpers/repo.mjs";

const { reset } = await import("./helpers/herdr-stub.mjs");
const { copyInto, isNewWorktree, markerPath, excludeMarker } = await import("../mods/projects/setup.js");

beforeEach(reset);

test("copyInto copies matches by relative path, creates folders, skips existing files and reports misses", async () => {
  const main = makeRepo(); const dest = scratch("pp-dest"); const notes = [];
  mkdirSync(join(main, ".claude"), { recursive: true });
  writeFileSync(join(main, ".env"), "A=1\n"); writeFileSync(join(main, ".env.local"), "B=2\n"); writeFileSync(join(main, ".claude", "settings.local.json"), "{}");
  mkdirSync(join(dest, ".claude"), { recursive: true }); writeFileSync(join(dest, ".claude", "settings.local.json"), "mine");
  const r = await copyInto({ main, dest, patterns: [".env*", ".claude/settings.local.json", "nope/*"], vars: {}, log: (m) => notes.push(m) });
  assert.deepEqual(r, { copied: [".env", ".env.local"], skipped: [".claude/settings.local.json"], missing: ["nope/*"] });
  assert.equal(readFileSync(join(dest, ".env"), "utf8"), "A=1\n");
  assert.equal(readFileSync(join(dest, ".claude", "settings.local.json"), "utf8"), "mine");
  assert.match(notes[0], /copied 2 files, skipped 1 existing, 1 pattern matched nothing/);
});
test("copyInto expands {var}s in patterns and copies a folder", async () => {
  const main = makeRepo(); const dest = scratch("pp-dest");
  mkdirSync(join(main, "cfg", "b"), { recursive: true }); writeFileSync(join(main, "cfg", "b", "x"), "x");
  const r = await copyInto({ main, dest, patterns: ["{d}"], vars: { d: "cfg" }, log: () => {} });
  assert.deepEqual(r.copied, ["cfg"]);
  assert.equal(readFileSync(join(dest, "cfg", "b", "x"), "utf8"), "x");
});
test("copyInto summary wording: singular, plural, nothing", async () => {
  const main = makeRepo(); const dest = scratch("pp-dest"); const notes = [];
  writeFileSync(join(main, ".env"), "A=1\n");
  await copyInto({ main, dest, patterns: [".env"], vars: {}, log: (m) => notes.push(m) });
  await copyInto({ main, dest, patterns: [".env", "zz*", "yy*"], vars: {}, log: (m) => notes.push(m) });
  await copyInto({ main, dest, patterns: [], vars: {}, log: (m) => notes.push(m) });
  assert.deepEqual(notes, ["copied 1 file", "skipped 1 existing, 2 patterns matched nothing", "copied nothing"]);
});
test("isNewWorktree, markerPath and excludeMarker", async () => {
  const repo = makeRepo();
  assert.equal(await isNewWorktree(repo), true);
  writeFileSync(markerPath(repo), "");
  assert.equal(await isNewWorktree(repo), false);
  const file = await excludeMarker(repo);
  assert.match(readFileSync(file, "utf8"), /\.projects-setup-done\n/);
  await excludeMarker(repo);
  assert.equal(readFileSync(file, "utf8").split(".projects-setup-done").length, 2);
});
test("excludeMarker on a linked worktree writes the exclude file git reads for it (shared with the main checkout)", async () => {
  const repo = makeRepo(); const wt = join(scratch("pp-wt"), "w");
  sh(repo, "worktree", "add", "-q", wt, "-b", "w");
  const file = await excludeMarker(wt);
  writeFileSync(markerPath(wt), "");
  assert.equal(sh(wt, "status", "--porcelain").trim(), "", file);
});
