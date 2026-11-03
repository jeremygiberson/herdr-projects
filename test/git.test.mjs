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

// ---------------------------------------------------------------- runSetup

test("runSetup runs commands in order in the folder", async () => {
  const dir = scratch();
  const p = normalize({ startup: { setup: ["echo one > out.txt", "echo two >> out.txt"] } });
  await G.runSetup(p, dir, note);
  const { readFileSync } = await import("node:fs");
  assert.equal(readFileSync(join(dir, "out.txt"), "utf8"), "one\ntwo\n");
});

test("runSetup stops at the first failure", async () => {
  const dir = scratch();
  msgs.length = 0;
  const p = normalize({ startup: { setup: ["exit 3", "touch after.txt"] } });
  await G.runSetup(p, dir, note);
  assert.ok(!existsSync(join(dir, "after.txt")));
  assert.ok(msgs.some((m) => m.startsWith("setup failed (3): exit 3")));
});

test("runSetup reports a command that cannot start", async () => {
  msgs.length = 0;
  await G.runSetup(normalize({ startup: { setup: ["true"] } }), "/no/such/folder", note);
  assert.ok(msgs.some((m) => m.startsWith("setup stopped")));
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

// ---------------------------------------------------------------- launch

const spaceNews = () => state.runs.filter((r) => r.command === "space.new");

test("launch without an agent opens a bare space", async () => {
  await G.launch(project("/r/api"), "/r/api", "Demo");
  assert.deepEqual(spaceNews().map((r) => r.args), [{ name: "Demo", folder: "/r/api" }]);
});

test("launch in 'arg' mode hands the prompt to herdr as the task", async () => {
  const p = project("/r/api", { startup: { agent: "claude", args: "--model opus", prompt: "fix it" } });
  await G.launch(p, "/r/api", "Demo");
  assert.deepEqual(spaceNews()[0].args, { name: "Demo", folder: "/r/api", argv: ["claude", "--model", "opus"], task: "fix it" });
  assert.deepEqual(state.sent, []);
});

test("launch opens one tab per extra command", async () => {
  const p = project("/r/api", { startup: { tabs: ["npm run dev", "tail -f log"] } });
  await G.launch(p, "/r/api", "Demo");
  const tabs = state.runs.filter((r) => r.command === "tab.new").map((r) => r.args);
  assert.deepEqual(tabs.map((t) => t.name), ["npm", "tail"]);
  assert.deepEqual(tabs[0], { space: "sp1", name: "npm", folder: "/r/api", argv: ["sh", "-c", "npm run dev"] });
});

test("launch in 'send' mode starts the agent bare and types the prompt once it is idle", async () => {
  const p = project("/r/api", { startup: { agent: "hermes", prompt: "review x", promptMode: "send" } });
  await G.launch(p, "/r/api", "Demo");
  assert.deepEqual(spaceNews()[0].args, { name: "Demo", folder: "/r/api", argv: ["hermes"] });
  assert.deepEqual(state.sent, [{ terminal: "t2", text: "review x" }]);
});

test("send mode leaves a blocked agent alone", async () => {
  state.agentStatus = "blocked";
  const p = project("/r/api", { startup: { agent: "claude", prompt: "go", promptMode: "send" } });
  await G.launch(p, "/r/api", "Demo");
  assert.deepEqual(state.sent, []);
});

test("send mode reports a failed hc send without throwing", async () => {
  state.sendFails = true;
  const p = project("/r/api", { startup: { agent: "claude", prompt: "go", promptMode: "send" } });
  await G.launch(p, "/r/api", "Demo");
  assert.equal(state.sent.length, 1);
});

test("send mode with an agent herdr has no status for waits for it to be the foreground program", async () => {
  state.agentStatus = null;
  state.foreground = "hermes";
  const p = project("/r/api", { startup: { agent: "hermes", prompt: "hi", promptMode: "send" } });
  const started = Date.now();
  await G.launch(p, "/r/api", "Demo");
  assert.ok(Date.now() - started >= 6000, "waits about 6 s");
  assert.equal(state.sent.length, 1);
});

test("two simultaneous send-mode launches into one folder each prompt their own terminal", async () => {
  const mk = (prompt) => project("/r/api", { startup: { agent: "claude", prompt, promptMode: "send" } });
  await Promise.all([G.launch(mk("first"), "/r/api", "A"), G.launch(mk("second"), "/r/api", "B")]);
  assert.equal(state.sent.length, 2);
  assert.notEqual(state.sent[0].terminal, state.sent[1].terminal);
  assert.deepEqual(state.sent.map((s) => s.text).sort(), ["first", "second"]);
});

test("a launch whose hc call hangs gives up its turn so later launches still run", async () => {
  G.lockSettings.seconds = 0.3;
  const mk = (prompt) => project("/r/api", { startup: { agent: "claude", prompt, promptMode: "send" } });
  state.hangNextLs = true;
  G.launch(mk("stuck"), "/r/api", "A").catch(() => {});
  await G.launch(mk("next"), "/r/api", "B");
  assert.deepEqual(state.sent.map((s) => s.text), ["next"]);
  G.lockSettings.seconds = 25;
});

const DEV = { name: "dev", panes: [
  { type: "agent" },
  { name: "files", command: "yazi .", direction: "right" },
  { name: "term", type: "shell", direction: "down" },
  { name: "logs", type: "command", command: "tail -f log", direction: "down", from: "agent" },
] };

test("launch builds a layout in the new space's pane, not the window it was opened from, each split from the pane it comes from", async () => {
  const p = project("/r/api", { startup: { agent: "claude" } });
  await G.launch(p, "/r/api", "Demo", DEV);
  const [files, term, logs] = state.splits;
  assert.ok(state.splits.every((x) => x.pane !== "picker-pane"), "never the window the picker was opened from");
  assert.deepEqual([files.direction, files.pane], ["right", "pane-of-sp1"]);
  assert.deepEqual([term.direction, term.pane], ["down", "pane-1"]);
  assert.deepEqual([logs.direction, logs.pane], ["down", "pane-of-sp1"]);
  assert.deepEqual(files.argv.slice(4), ["/r/api", "sh", "-c", "yazi ."]);
  assert.deepEqual(term.argv.slice(4), ["/r/api"]);
  assert.deepEqual(state.runs.filter((r) => r.command === "pane.focus").map((r) => r.args), [{ pane: "pane-of-sp1" }]);
});

test("a launch without a layout, or a single-pane one, splits nothing", async () => {
  await G.launch(project("/r/api"), "/r/api", "Demo");
  await G.launch(project("/r/api"), "/r/api", "Demo", { name: "solo", panes: [{ type: "agent" }] });
  assert.deepEqual(state.splits, []);
});

test("a failed split is logged, ends the layout, and the space still opens with its tabs", async () => {
  state.splitFails = true;
  const p = project("/r/api", { startup: { tabs: ["npm test"] } });
  await G.launch(p, "/r/api", "Demo", DEV);
  assert.equal(spaceNews().length, 1);
  assert.equal(state.runs.filter((r) => r.command === "tab.new").length, 1);
  assert.deepEqual(state.splits, []);
});

test("send mode still prompts the agent's terminal when a layout adds terminals in the same folder", async () => {
  const p = project("/r/api", { startup: { agent: "claude", prompt: "go", promptMode: "send" } });
  await G.launch(p, "/r/api", "Demo", DEV);
  assert.deepEqual(state.sent, [{ terminal: "t2", text: "go" }]);
  assert.equal(state.splits.length, 3);
});

test("a worktree launch opens the repo's space first when asked and it is not open", async () => {
  const p = project("/r/api", { worktree: { repoSpace: true } });
  await G.launch(p, "/wt/api", "Demo · x");
  assert.deepEqual(spaceNews().map((r) => r.args.folder), ["/r/api", "/wt/api"]);
});

test("the repo's space is not reopened when it is already open, off, or the folder itself", async () => {
  state.spaces = [{ id: "s", folder: "/r/api", machine: null }];
  await G.launch(project("/r/api", { worktree: { repoSpace: true } }), "/wt/api", "x");
  assert.equal(spaceNews().length, 1);
  reset();
  await G.launch(project("/r/api", { worktree: { repoSpace: false } }), "/wt/api", "x");
  assert.equal(spaceNews().length, 1);
  reset();
  await G.launch(project("/r/api", { worktree: { repoSpace: true } }), "/r/api", "x");
  assert.equal(spaceNews().length, 1);
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
