import "./helpers/setup.mjs";
import test, { beforeEach } from "node:test";
import assert from "node:assert/strict";
import { existsSync, mkdirSync, writeFileSync, realpathSync } from "node:fs";
import { join } from "node:path";
import { makeRepo, makeClone, commit, scratch, sh, symlinkTo } from "./helpers/repo.mjs";

const { state, reset } = await import("./helpers/herdr-stub.mjs");
const G = await import("../mods/projects/git.js");
const { normalize } = await import("../mods/projects/lib.js");

beforeEach(reset);

const msgs = [];
const note = (m) => msgs.push(m);

/** A project for a repo, with a fixed branch template and worktrees under a scratch folder. */
function project(path, over = {}) {
  const root = scratch("pp-wt");
  return normalize({
    name: "Demo", path,
    ...over,
    worktree: { branchTemplate: "{user}/{slug}", root: `${root}/{branch}`, ...over.worktree },
    git: { fetch: false, ...over.git },
  });
}

// ---------------------------------------------------------------- inspect, gitUser, templateVars

test("inspect returns the top folder and branch", async () => {
  const dir = realpathSync(makeRepo());
  assert.deepEqual(await G.inspect(dir), { top: dir, branch: "main" });
});

test("inspect explains a folder that is not a checkout or does not exist", async () => {
  await assert.rejects(G.inspect(scratch()), /is not a git checkout/);
  await assert.rejects(G.inspect("/no/such/folder/at/all"), /Can't open/);
});

test("gitUser: name, then email's local part, then 'user'", async () => {
  assert.equal(await G.gitUser(makeRepo({ name: "Ada Lovelace" })), "ada-lovelace");
  const noName = makeRepo({ name: null });
  sh(noName, "config", "user.email", "grace.h@example.com");
  // a global user.name on this machine would win; only assert when none is set
  const global = (() => { try { return sh(noName, "config", "--global", "user.name"); } catch { return ""; } })();
  if (!global) assert.equal(await G.gitUser(noName), "grace-h");
});

test("templateVars fills user, repo, project and slug (timestamp when the slug is empty)", async () => {
  const dir = realpathSync(makeRepo({ name: "Ada" }));
  const p = project(dir, { name: "My API" });
  const v = await G.templateVars(p, "Fix Login!");
  assert.equal(v.user, "ada");
  assert.equal(v.slug, "fix-login");
  assert.equal(v.project, "my-api");
  assert.equal(v.name, "My API");
  assert.match(v.date, /^\d{4}-\d\d-\d\d$/);
  assert.equal(v.repo, dir.split("/").pop());
  assert.match((await G.templateVars(p, "")).slug, /^\d{6}$/);
});

test("projectFolder expands ~ against herdr's home", () => {
  assert.equal(G.projectFolder({ path: "~/code/api/" }), `${state.home}/code/api`);
});

test("previewBranch shows the branch before collisions", async () => {
  const p = project(makeRepo({ name: "Ada" }));
  assert.equal(await G.previewBranch(p, "Add search"), "ada/add-search");
});

// ---------------------------------------------------------------- baseRef

test("baseRef prefers remote/base, then base, then fails", async () => {
  const { dir } = makeClone();
  assert.equal(await G.baseRef(dir, { remote: "origin", base: "main" }), "origin/main");
  const local = makeRepo();
  assert.equal(await G.baseRef(local, { remote: "origin", base: "main" }), "main");
  await assert.rejects(G.baseRef(local, { remote: "origin", base: "nope" }), /No base branch origin\/nope or nope/);
});

// ---------------------------------------------------------------- createWorktree

test("createWorktree makes a branch and folder from the base", async () => {
  const dir = makeRepo({ name: "Ada" });
  const p = project(dir);
  const wt = await G.createWorktree(p, "add search", note);
  assert.equal(wt.branch, "ada/add-search");
  assert.ok(existsSync(join(wt.folder, "a.txt")));
  assert.equal(sh(wt.folder, "rev-parse", "--abbrev-ref", "HEAD"), "ada/add-search");
  assert.equal(wt.vars.slug, "add-search");
  // no upstream is set: pushing must be deliberate
  assert.throws(() => sh(wt.folder, "rev-parse", "--abbrev-ref", "@{upstream}"));
});

test("createWorktree adds -2, -3 when the branch is taken", async () => {
  const p = project(makeRepo({ name: "Ada" }));
  const a = await G.createWorktree(p, "same", note);
  const b = await G.createWorktree(p, "same", note);
  const c = await G.createWorktree(p, "same", note);
  assert.deepEqual([a.branch, b.branch, c.branch], ["ada/same", "ada/same-2", "ada/same-3"]);
});

test("createWorktree skips a branch name whose folder already exists", async () => {
  const p = project(makeRepo({ name: "Ada" }));
  const root = p.worktree.root.replace("{branch}", "ada/busy");
  mkdirSync(root, { recursive: true });
  writeFileSync(join(root, "x"), "x");
  const wt = await G.createWorktree(p, "busy", note);
  assert.equal(wt.branch, "ada/busy-2");
});

test("two simultaneous creates for the same name both succeed with different branches", async () => {
  const p = project(makeRepo({ name: "Ada" }));
  const [a, b] = await Promise.all([G.createWorktree(p, "race", note), G.createWorktree(p, "race", note)]);
  assert.notEqual(a.branch, b.branch);
  assert.notEqual(a.folder, b.folder);
  assert.ok(existsSync(a.folder) && existsSync(b.folder));
});

test("createWorktree tries up to -21 and then gives up", async () => {
  const dir = makeRepo({ name: "Ada" });
  sh(dir, "branch", "ada/full");
  for (let i = 2; i <= 20; i++) sh(dir, "branch", `ada/full-${i}`);
  const wt = await G.createWorktree(project(dir), "full", note);
  assert.equal(wt.branch, "ada/full-21");
  await assert.rejects(G.createWorktree(project(dir), "full", note), /all taken/);
});

test("createWorktree rejects an empty or invalid branch name", async () => {
  const dir = makeRepo();
  await assert.rejects(G.createWorktree(project(dir, { worktree: { branchTemplate: "{nothing}" } }), "x", note), /empty name/);
  await assert.rejects(G.createWorktree(project(dir, { worktree: { branchTemplate: "a..b" } }), "x", note), /not a valid branch name/);
});

test("existing: a local branch is checked out, no suffixing", async () => {
  const dir = realpathSync(makeRepo()); sh(dir, "branch", "feat/one");
  const p = project(dir);
  const wt = await G.createWorktree(p, "feat/one", note, { existing: true });
  assert.equal(wt.branch, "feat/one"); assert.equal(wt.reused, false);
  assert.equal(sh(wt.folder, "rev-parse", "--abbrev-ref", "HEAD"), "feat/one");
});
test("existing: remote-only branch is tracked", async () => {
  const { dir: clone, bare } = makeClone(); sh(bare, "branch", "feat/remote", "main");
  const dir = realpathSync(clone);
  const wt = await G.createWorktree(project(dir, { git: { fetch: true, remote: "origin" } }), "feat/remote", note, { existing: true });
  assert.equal(sh(wt.folder, "rev-parse", "--abbrev-ref", "feat/remote@{upstream}"), "origin/feat/remote");
  const off = project(realpathSync(makeClone().dir), { git: { fetch: false } });
  // The launcher offers to create such a branch: the error names its kind.
  await assert.rejects(G.createWorktree(off, "feat/none", note, { existing: true }), (e) => /branch "feat\/none" not found locally or on origin/.test(e.message) && e.code === "missing-branch");
});
test("existing: a worktree already on that branch is reused", async () => {
  const dir = realpathSync(makeRepo()); sh(dir, "branch", "feat/two");
  const p = project(dir);
  const first = await G.createWorktree(p, "feat/two", note, { existing: true });
  const again = await G.createWorktree(p, "feat/two", note, { existing: true });
  assert.deepEqual([again.folder, again.reused], [first.folder, true]);
});
test("existing: a worktree on that branch somewhere else (another root) is reused, not refused", async () => {
  const dir = realpathSync(makeRepo()); sh(dir, "branch", "feat/elsewhere");
  const other = `${scratch("pp-other")}/hand-made`;
  sh(dir, "worktree", "add", other, "feat/elsewhere");
  const wt = await G.createWorktree(project(dir), "feat/elsewhere", note, { existing: true });
  assert.deepEqual([wt.folder, wt.branch, wt.reused], [other, "feat/elsewhere", true]);
  assert.equal(wt.vars.repo, dir.split("/").pop());
});
test("existing: the branch of the main checkout fails with a clear message", async () => {
  const dir = realpathSync(makeRepo());
  await assert.rejects(G.createWorktree(project(dir), "main", note, { existing: true }), /branch "main" is checked out in the main checkout/);
});
test("verbatim: a slash-free name is the branch itself, in the preview and when created", async () => {
  const dir = realpathSync(makeRepo());
  const p = project(dir);
  assert.equal(await G.previewBranch(p, "sc-1234-fix"), "test-user/sc-1234-fix");
  assert.equal(await G.previewBranch(p, "sc-1234-fix", { verbatim: true }), "sc-1234-fix");
  const wt = await G.createWorktree(p, "sc-1234-fix", note, { verbatim: true });
  assert.equal(wt.branch, "sc-1234-fix");
  assert.equal(sh(wt.folder, "rev-parse", "--abbrev-ref", "HEAD"), "sc-1234-fix");
  assert.equal((await G.createWorktree(p, "sc-1234-fix", note, { verbatim: true })).branch, "sc-1234-fix-2", "verbatim still suffixes a taken name");
});
test("existing: a taken path on another branch fails rather than suffixing", async () => {
  const dir = realpathSync(makeRepo()); sh(dir, "branch", "a"); sh(dir, "branch", "b");
  const p = project(dir, { worktree: { root: `${scratch("pp-wt")}/same` } });
  await G.createWorktree(p, "a", note, { existing: true });
  await assert.rejects(G.createWorktree(p, "b", note, { existing: true }), /already holds a worktree on a/);
});
test("existing: a taken path that is not a worktree fails", async () => {
  const dir = realpathSync(makeRepo()); sh(dir, "branch", "c");
  const root = `${scratch("pp-wt")}/plain`;
  mkdirSync(root, { recursive: true });
  await assert.rejects(G.createWorktree(project(dir, { worktree: { root } }), "c", note, { existing: true }), /already holds a worktree on an unknown checkout/);
});

test("createWorktree fails clearly without a base branch or outside a repo", async () => {
  await assert.rejects(G.createWorktree(project(makeRepo(), { git: { base: "nope" } }), "x", note), /No base branch/);
  await assert.rejects(G.createWorktree(project(scratch()), "x", note), /not a git checkout/);
});

test("createWorktree fetches first and branches from the remote's tip", async () => {
  const { dir, upstream, bare } = makeClone();
  commit(upstream, "new.txt");
  sh(upstream, "push", "-q", bare, "main");
  msgs.length = 0;
  const wt = await G.createWorktree(project(dir, { git: { fetch: true } }), "fresh", note);
  assert.ok(existsSync(join(wt.folder, "new.txt")), "branched from origin/main after the fetch");
  assert.ok(msgs.some((m) => m.startsWith("git fetch origin")));
});

test("a failing fetch is tolerated and the local base is used", async () => {
  const dir = makeRepo({ name: "Ada" });
  sh(dir, "remote", "add", "origin", "/no/such/remote");
  msgs.length = 0;
  const wt = await G.createWorktree(project(dir, { git: { fetch: true } }), "offline", note);
  assert.equal(wt.branch, "ada/offline");
  assert.ok(msgs.some((m) => m.startsWith("fetch failed, using local refs")));
});

// ---------------------------------------------------------------- prepareMain

test("prepareMain fast-forwards a clean checkout on the base branch", async () => {
  const { dir, upstream, bare } = makeClone();
  commit(upstream, "new.txt");
  sh(upstream, "push", "-q", bare, "main");
  msgs.length = 0;
  await G.prepareMain(project(dir, { git: { fetch: true, fastForward: true } }), note);
  assert.ok(existsSync(join(dir, "new.txt")));
  assert.ok(msgs.includes("fast-forwarded main"));
});

test("prepareMain does nothing when fast-forward is off", async () => {
  const { dir, upstream, bare } = makeClone();
  commit(upstream, "new.txt");
  sh(upstream, "push", "-q", bare, "main");
  await G.prepareMain(project(dir, { git: { fetch: true, fastForward: false } }), note);
  assert.ok(!existsSync(join(dir, "new.txt")));
});

test("prepareMain leaves other branches, dirty trees and diverged history alone", async () => {
  const { dir, upstream, bare } = makeClone();
  commit(upstream, "new.txt");
  sh(upstream, "push", "-q", bare, "main");
  const p = project(dir, { git: { fetch: true, fastForward: true } });

  sh(dir, "checkout", "-q", "-b", "topic");
  msgs.length = 0;
  await G.prepareMain(p, note);
  assert.ok(msgs.some((m) => m.includes("on topic, not main")));
  sh(dir, "checkout", "-q", "main");

  writeFileSync(join(dir, "a.txt"), "dirty\n");
  msgs.length = 0;
  await G.prepareMain(p, note);
  assert.ok(msgs.includes("not fast-forwarding: uncommitted changes"));
  sh(dir, "checkout", "-q", "--", "a.txt");

  commit(dir, "local.txt");
  msgs.length = 0;
  await G.prepareMain(p, note);
  assert.ok(msgs.includes("not fast-forwarding: local commits"));
  assert.ok(!existsSync(join(dir, "new.txt")));
});

// ---------------------------------------------------------------- findSpace, worktreeSpaceName

test("findSpace matches a local space by the project's folder", () => {
  state.spaces = [{ id: "a", folder: "/r/x", machine: null }, { id: "b", folder: "/r/api", machine: "vps" }, { id: "c", folder: "/r/api", machine: null }];
  assert.equal(G.findSpace({ path: "/r/api" }).id, "c");
  assert.equal(G.findSpace({ path: "/r/none" }), undefined);
});

test("worktreeSpaceName uses the template and falls back to '<name> · <branch>'", () => {
  const wt = { branch: "ada/x", vars: { slug: "x", name: "Demo" } };
  assert.equal(G.worktreeSpaceName(normalize({ name: "Demo" }), wt), "Demo · ada/x");
  assert.equal(G.worktreeSpaceName(normalize({ name: "Demo", worktree: { spaceName: "{slug}" } }), wt), "x");
  assert.equal(G.worktreeSpaceName(normalize({ name: "Demo", worktree: { spaceName: "{nothing}" } }), wt), "Demo · ada/x");
});

// ---------------------------------------------------------------- listWorktrees, removeWorktree

test("listWorktrees reports branch, dirty, merged and the open space", async () => {
  const dir = makeRepo({ name: "Ada" });
  const p = project(dir);
  const clean = await G.createWorktree(p, "clean", note);
  const dirty = await G.createWorktree(p, "dirty", note);
  const ahead = await G.createWorktree(p, "ahead", note);
  writeFileSync(join(dirty.folder, "a.txt"), "changed\n");
  commit(ahead.folder, "feature.txt");
  state.spaces = [{ id: "sp-clean", folder: clean.folder, machine: null }];

  const list = await G.listWorktrees(p);
  const by = Object.fromEntries(list.map((w) => [w.branch, w]));
  assert.equal(list.length, 3, "the main checkout is not listed");
  assert.equal(by["ada/clean"].dirty, false);
  assert.equal(by["ada/clean"].merged, true);
  assert.equal(by["ada/clean"].space.id, "sp-clean");
  assert.equal(by["ada/dirty"].dirty, true);
  assert.equal(by["ada/ahead"].merged, false);
  assert.equal(by["ada/ahead"].locked, false);
});

test("listWorktrees finds the open space even when it was opened through a symlink", async () => {
  const p = project(makeRepo({ name: "Ada" }));
  const wt = await G.createWorktree(p, "linked", note);
  state.spaces = [{ id: "sp-link", folder: symlinkTo(wt.folder), machine: null }];
  const [item] = await G.listWorktrees(p);
  assert.equal(item.space?.id, "sp-link");
});

test("gitSummary reports branch, changed files and linked worktrees", async () => {
  const dir = makeRepo({ name: "Ada" });
  assert.deepEqual(await G.gitSummary(dir), { branch: "main", dirty: 0, worktrees: 0 });
  writeFileSync(join(dir, "a.txt"), "changed\n");
  writeFileSync(join(dir, "new.txt"), "new\n");
  await G.createWorktree(project(dir), "one", note);
  await G.createWorktree(project(dir), "two", note);
  assert.deepEqual(await G.gitSummary(dir), { branch: "main", dirty: 2, worktrees: 2 });
  sh(dir, "checkout", "-q", "-b", "topic");
  assert.equal((await G.gitSummary(dir)).branch, "topic");
  sh(dir, "commit", "-aq", "-m", "wip");
  sh(dir, "checkout", "-q", "--detach");
  assert.equal((await G.gitSummary(dir)).branch, "HEAD (no branch)");
});

test("gitSummary: a repo with no commits yet, and a branch with an upstream", async () => {
  const empty = scratch("pp-empty");
  sh(empty, "init", "-q", "-b", "trunk");
  assert.deepEqual(await G.gitSummary(empty), { branch: "trunk", dirty: 0, worktrees: 0 });
  const { dir } = makeClone();
  assert.equal((await G.gitSummary(dir)).branch, "main", "no '...origin/main' in the name");
  commit(dir, "ahead.txt");
  assert.equal((await G.gitSummary(dir)).branch, "main", "no [ahead 1] either");
});

test("gitSummary is null for a folder that is not a checkout or is gone", async () => {
  assert.equal(await G.gitSummary(scratch()), null);
  assert.equal(await G.gitSummary("/no/such/folder/at/all"), null);
});

test("listWorktrees skips prunable worktrees whose folder is gone", async () => {
  const p = project(makeRepo({ name: "Ada" }));
  const wt = await G.createWorktree(p, "gone", note);
  const { rmSync } = await import("node:fs");
  rmSync(wt.folder, { recursive: true });
  assert.deepEqual(await G.listWorktrees(p), []);
});

test("listWorktrees marks locked worktrees", async () => {
  const dir = makeRepo({ name: "Ada" });
  const p = project(dir);
  const wt = await G.createWorktree(p, "held", note);
  sh(dir, "worktree", "lock", wt.folder);
  assert.equal((await G.listWorktrees(p))[0].locked, true);
});

test("listWorktrees handles non-ASCII, newline and quote characters in folder names, and removes them", async () => {
  const dir = makeRepo({ name: "Ada" });
  for (const name of ["café", "line\nbreak", 'say "hi"']) {
    const path = join(scratch("pp-q"), name);
    sh(dir, "worktree", "add", "-q", "-b", `b-${Buffer.from(name).toString("hex")}`, path);
    const p = project(dir);
    const found = (await G.listWorktrees(p)).find((w) => w.path.endsWith(name));
    assert.ok(found, `found ${JSON.stringify(name)}`);
    assert.ok(existsSync(found.path));
    await G.removeWorktree(p, found);
    assert.ok(!existsSync(path));
  }
});

test("listWorktrees fails when the folder is not a repo", async () => {
  await assert.rejects(G.listWorktrees(project(scratch())));
});

test("removeWorktree deletes a merged branch and closes its space", async () => {
  const dir = makeRepo({ name: "Ada" });
  const p = project(dir);
  const wt = await G.createWorktree(p, "done", note);
  state.spaces = [{ id: "sp9", folder: wt.folder, machine: null }];
  const [item] = await G.listWorktrees(p);
  await G.removeWorktree(p, item);
  assert.ok(!existsSync(wt.folder));
  assert.equal(sh(dir, "branch", "--list", "ada/done"), "");
  assert.deepEqual(state.runs.filter((r) => r.command === "space.close").map((r) => r.args), [{ id: "sp9" }]);
});

test("removeWorktree keeps an unmerged branch", async () => {
  const dir = makeRepo({ name: "Ada" });
  const p = project(dir);
  const wt = await G.createWorktree(p, "wip", note);
  commit(wt.folder, "wip.txt");
  const [item] = await G.listWorktrees(p);
  await G.removeWorktree(p, item);
  assert.ok(!existsSync(wt.folder));
  assert.match(sh(dir, "branch", "--list", "ada/wip"), /ada\/wip/);
});

test("removeWorktree refuses a worktree with uncommitted changes", async () => {
  const p = project(makeRepo({ name: "Ada" }));
  const wt = await G.createWorktree(p, "edits", note);
  writeFileSync(join(wt.folder, "a.txt"), "changed\n");
  const [item] = await G.listWorktrees(p);
  await assert.rejects(G.removeWorktree(p, item), /ada\/edits/);
  assert.ok(existsSync(wt.folder));
  assert.deepEqual(state.runs.filter((r) => r.command === "space.close"), []);
});

test("a branch typed with a slash is used verbatim, else the template applies", async () => {
  const dir = realpathSync(makeRepo({ name: "Ada" }));
  const p = project(dir);
  assert.equal(await G.previewBranch(p, "feat/login"), "feat/login");
  assert.equal(await G.previewBranch(p, "login"), "ada/login");
  const wt = await G.createWorktree(p, "feat/login", note);
  assert.equal(wt.branch, "feat/login");
});
test("an invalid verbatim branch is refused with git's reason", async () => {
  const p = project(realpathSync(makeRepo()));
  await assert.rejects(G.createWorktree(p, "a//b", note), /is not a valid branch name/);
  await assert.rejects(G.createWorktree(p, "x/y.lock", note), /is not a valid branch name/);
});

// ---------------------------------------------------------------- repoKey, branchOf

test("repoKey is the same for a checkout and its linked worktree, and null outside a repo", async () => {
  const dir = makeRepo();
  const wt = join(scratch("pp-wt"), "feat");
  sh(dir, "worktree", "add", "-q", "-b", "feat", wt);
  const key = await G.repoKey(dir);
  assert.ok(key);
  assert.equal(await G.repoKey(wt), key);
  assert.equal(await G.repoKey(join(dir, ".git", "..")), key);
  assert.equal(await G.repoKey(scratch()), null);
});

test("branchOf reports the checked-out branch", async () => {
  const dir = makeRepo();
  const wt = join(scratch("pp-wt"), "feat");
  sh(dir, "worktree", "add", "-q", "-b", "feat", wt);
  assert.equal(await G.branchOf(dir), "main");
  assert.equal(await G.branchOf(wt), "feat");
  assert.equal(await G.branchOf(scratch()), null);
});
