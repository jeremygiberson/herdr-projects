import "./helpers/setup.mjs";
import test, { beforeEach } from "node:test";
import assert from "node:assert/strict";
import { mkdirSync, writeFileSync, readFileSync, existsSync } from "node:fs";
import { join } from "node:path";
import { makeRepo, scratch, sh } from "./helpers/repo.mjs";

const { reset } = await import("./helpers/herdr-stub.mjs");
const { copyInto, isNewWorktree, markerPath, excludeMarker, prepareSetup } = await import("../mods/projects/setup.js");
const { normalize } = await import("../mods/projects/lib.js");

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
  const r = await copyInto({ main, dest, patterns: ["{branch}"], vars: { branch: "cfg" }, log: () => {} });
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
test("copyInto copies a file whose name has spaces, by a pattern with spaces", async () => {
  const main = makeRepo(); const dest = scratch("pp-dest");
  writeFileSync(join(main, "My Config.json"), "{}");
  const r = await copyInto({ main, dest, patterns: ["My Config.json"], vars: {}, log: () => {} });
  assert.deepEqual(r, { copied: ["My Config.json"], skipped: [], missing: [] });
  assert.equal(readFileSync(join(dest, "My Config.json"), "utf8"), "{}");
});
test("copyInto leaves a ${VAR} or an unknown {brace} in a pattern alone", async () => {
  const main = makeRepo(); const dest = scratch("pp-dest");
  const r = await copyInto({ main, dest, patterns: ["${PROJECTS_MAIN}/x", "{nope}"], vars: { main: "/m" }, log: () => {} });
  assert.deepEqual(r.missing, ["${PROJECTS_MAIN}/x", "{nope}"]);
});

const setupProject = (main, over = {}) => normalize({ name: "api", path: main, worktree: { copy: [".env"], setup: ["npm ci"], ...over.worktree }, startup: { setup: ["echo {branch}"], ...over.startup } });
test("prepareSetup on a new worktree copies, chains worktree then startup setup, touches and excludes the marker", async () => {
  const main = makeRepo(); writeFileSync(join(main, ".env"), "A=1\n");
  const wt = join(scratch("pp-wt"), "w"); sh(main, "worktree", "add", "-q", wt, "-b", "w");
  const notes = [];
  const r = await prepareSetup({ project: setupProject(main), folder: wt, isWorktree: true, branch: "w", repo: "r", home: "/h", log: (m) => notes.push(m) });
  assert.equal(readFileSync(join(wt, ".env"), "utf8"), "A=1\n");
  assert.equal(r.marker, markerPath(wt));
  assert.ok(r.chain.endsWith(`cd '${wt}' && sh -ec 'npm ci' && sh -ec 'echo w' && touch '${markerPath(wt)}'`), r.chain);
  assert.match(r.chain, /^export PROJECTS_MAIN=/);
  assert.deepEqual(r.steps, ["npm ci", "echo w"]);
  assert.equal(r.env.PROJECTS_FOLDER, wt);
  assert.deepEqual(notes, ["copied 1 file", "will run: npm ci", "will run: echo {branch}"]);
  writeFileSync(markerPath(wt), "");
  assert.doesNotMatch(sh(wt, "status", "--porcelain", "--untracked-files=all"), /projects-setup-done/, "the marker is excluded");
});
test("prepareSetup on a marked worktree or a checkout runs only startup setup, with no copy and no marker", async () => {
  const main = makeRepo(); writeFileSync(join(main, ".env"), "A=1\n");
  const wt = join(scratch("pp-wt"), "w"); sh(main, "worktree", "add", "-q", wt, "-b", "w"); writeFileSync(markerPath(wt), "");
  const a = await prepareSetup({ project: setupProject(main), folder: wt, isWorktree: true, branch: "w", repo: "r", home: "/h", log: () => {} });
  assert.deepEqual([a.marker, a.steps, existsSync(join(wt, ".env"))], [undefined, ["echo w"], false]);
  assert.doesNotMatch(a.chain, /touch|npm ci/);
  const b = await prepareSetup({ project: setupProject(main), folder: main, isWorktree: false, branch: "main", repo: "r", home: "/h", log: () => {} });
  assert.deepEqual([b.marker, b.steps], [undefined, ["echo main"]]);
  assert.doesNotMatch(b.chain, /touch|npm ci/);
});
test("prepareSetup with inline setup: no touch in the chain, no will-run notes, and the marker for the caller to touch", async () => {
  const main = makeRepo();
  const wt = join(scratch("pp-wt"), "w"); sh(main, "worktree", "add", "-q", wt, "-b", "w");
  const notes = [];
  const r = await prepareSetup({ project: setupProject(main, { worktree: { copy: [] }, startup: { quickSetup: true } }), folder: wt, isWorktree: true, branch: "w", repo: "r", home: "/h", log: (m) => notes.push(m) });
  assert.equal(r.marker, markerPath(wt));
  assert.doesNotMatch(r.chain, /touch/);
  assert.deepEqual(notes, []);
});
test("prepareSetup with no setup steps gives no chain and no marker", async () => {
  const main = makeRepo();
  const wt = join(scratch("pp-wt"), "w"); sh(main, "worktree", "add", "-q", wt, "-b", "w");
  const r = await prepareSetup({ project: normalize({ name: "api", path: main }), folder: wt, isWorktree: true, branch: "w", repo: "r", home: "/h", log: () => {} });
  assert.deepEqual([r.chain, r.marker, r.steps], ["", undefined, []]);
});
