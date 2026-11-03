import "./helpers/setup.mjs";
import test, { beforeEach } from "node:test";
import assert from "node:assert/strict";
import { mkdirSync, realpathSync } from "node:fs";
import { join } from "node:path";
import { makeRepo, scratch } from "./helpers/repo.mjs";

const { state, reset } = await import("./helpers/herdr-stub.mjs");
const W = await import("../mods/projects/workspace.js");
const { normalize, tabsForLaunch } = await import("../mods/projects/lib.js");

beforeEach(reset);

const spaceNews = () => state.runs.filter((r) => r.command === "space.new");

/** A project at `path`, from old-style overrides (they become tabs). */
const project = (path, over = {}) => normalize({ name: "Demo", path, ...over, worktree: { ...over.worktree } });

/** buildWorkspace for a project's own tabs, or for `layout` picked over them. */
const build = (p, folder, name, layout = null, prompt = undefined) => W.buildWorkspace({
  project: p, folder, name,
  tabs: layout ? tabsForLaunch(p, [layout], layout.name) : p.startup.tabs,
  prompt: prompt ?? p.startup.tabs[0]?.panes.find((x) => x.type === "agent")?.prompt ?? "",
  log: () => {},
});

const repo = () => realpathSync(makeRepo());

test("launch without an agent opens a bare space", async () => {
  const dir = repo();
  await build(project(dir), dir, "Demo");
  assert.deepEqual(spaceNews().map((r) => r.args), [{ name: "Demo", folder: dir, tab: "shell" }]);
});

test("launch in 'arg' mode hands the prompt to herdr as the task", async () => {
  const dir = repo();
  const p = project(dir, { startup: { agent: "claude", args: "--model opus", prompt: "fix it" } });
  await build(p, dir, "Demo");
  assert.deepEqual(spaceNews()[0].args, { name: "Demo", folder: dir, tab: "agent", argv: ["claude", "--model", "opus"], task: "fix it" });
  assert.deepEqual(state.sent, []);
});

test("launch opens one tab per extra command", async () => {
  const dir = repo();
  const p = project(dir, { startup: { tabs: ["npm run dev", "tail -f log"] } });
  await build(p, dir, "Demo");
  assert.deepEqual(state.tabsMade.map((t) => t.name), ["npm", "tail"]);
  assert.deepEqual(state.tabsMade[0], { space: "sp1", name: "npm", folder: dir, argv: ["sh", "-c", "npm run dev"] });
});

test("launch in 'send' mode starts the agent bare and types the prompt once it is idle", async () => {
  const dir = repo();
  const p = project(dir, { startup: { agent: "hermes", prompt: "review x", promptMode: "send" } });
  await build(p, dir, "Demo");
  assert.deepEqual(spaceNews()[0].args, { name: "Demo", folder: dir, tab: "agent", argv: ["hermes"] });
  assert.deepEqual(state.sent, [{ terminal: "t2", text: "review x" }]);
});

test("send mode leaves a blocked agent alone", async () => {
  state.agentStatus = "blocked";
  const dir = repo();
  const p = project(dir, { startup: { agent: "claude", prompt: "go", promptMode: "send" } });
  await build(p, dir, "Demo");
  assert.deepEqual(state.sent, []);
});

test("send mode reports a failed hc send without throwing", async () => {
  state.sendFails = true;
  const dir = repo();
  const p = project(dir, { startup: { agent: "claude", prompt: "go", promptMode: "send" } });
  await build(p, dir, "Demo");
  assert.equal(state.sent.length, 1);
});

test("send mode with an agent herdr has no status for waits for it to be the foreground program", async () => {
  state.agentStatus = null;
  state.foreground = "hermes";
  const dir = repo();
  const p = project(dir, { startup: { agent: "hermes", prompt: "hi", promptMode: "send" } });
  const started = Date.now();
  await build(p, dir, "Demo");
  assert.ok(Date.now() - started >= 6000, "waits about 6 s");
  assert.equal(state.sent.length, 1);
});

test("two simultaneous send-mode launches into one folder each prompt their own terminal", async () => {
  const dir = repo();
  const mk = (prompt) => project(dir, { startup: { agent: "claude", prompt, promptMode: "send" } });
  await Promise.all([build(mk("first"), dir, "A"), build(mk("second"), dir, "B")]);
  assert.equal(state.sent.length, 2);
  assert.notEqual(state.sent[0].terminal, state.sent[1].terminal);
  assert.deepEqual(state.sent.map((s) => s.text).sort(), ["first", "second"]);
});

test("a launch whose hc call hangs gives up its turn so later launches still run", async () => {
  W.lockSettings.seconds = 0.3;
  const dir = repo();
  const mk = (prompt) => project(dir, { startup: { agent: "claude", prompt, promptMode: "send" } });
  state.hangNextLs = true;
  build(mk("stuck"), dir, "A").catch(() => {});
  await build(mk("next"), dir, "B");
  assert.deepEqual(state.sent.map((s) => s.text), ["next"]);
  W.lockSettings.seconds = 25;
});

const DEV = { name: "dev", panes: [
  { type: "agent" },
  { name: "files", command: "yazi .", direction: "right" },
  { name: "term", type: "shell", direction: "down" },
  { name: "logs", type: "command", command: "tail -f log", direction: "down", from: "agent" },
] };

test("launch builds a layout in the new space's pane, not the window it was opened from, each split from the pane it comes from", async () => {
  const dir = repo();
  const p = project(dir, { startup: { agent: "claude" } });
  await build(p, dir, "Demo", DEV);
  const [files, term, logs] = state.splits;
  assert.ok(state.splits.every((x) => x.pane !== "picker-pane"), "never the window the picker was opened from");
  assert.deepEqual([files.direction, files.pane], ["right", "pane-of-sp1"]);
  assert.deepEqual([term.direction, term.pane], ["down", "pane-1"]);
  assert.deepEqual([logs.direction, logs.pane], ["down", "pane-of-sp1"]);
  assert.deepEqual(files.argv.slice(4), [dir, "sh", "-c", "yazi ."]);
  assert.deepEqual(term.argv.slice(4), [dir]);
  assert.deepEqual(state.runs.filter((r) => r.command === "pane.focus").map((r) => r.args), [{ pane: "pane-of-sp1" }]);
});

test("a launch without a layout, or a single-pane one, splits nothing", async () => {
  const dir = repo();
  await build(project(dir), dir, "Demo");
  await build(project(dir), dir, "Demo", { name: "solo", panes: [{ type: "agent" }] });
  assert.deepEqual(state.splits, []);
});

test("a failed split is logged, ends the layout, and the space still opens with its tabs", async () => {
  state.splitFails = true;
  const dir = repo();
  const p = project(dir, { startup: { agent: "claude", tabs: ["npm test"] } });
  await build(p, dir, "Demo", DEV);
  assert.equal(spaceNews().length, 1);
  assert.equal(state.tabsMade.length, 1);
  assert.deepEqual(state.splits, []);
});

test("send mode still prompts the agent's terminal when a layout adds terminals in the same folder", async () => {
  const dir = repo();
  const p = project(dir, { startup: { agent: "claude", prompt: "go", promptMode: "send" } });
  await build(p, dir, "Demo", DEV);
  assert.deepEqual(state.sent, [{ terminal: "t2", text: "go" }]);
  assert.equal(state.splits.length, 3);
});

test("a worktree launch opens the repo's space first when asked and it is not open", async () => {
  const dir = repo(); const wt = scratch("pp-wt");
  const p = project(dir, { worktree: { repoSpace: true } });
  await build(p, wt, "Demo · x");
  assert.deepEqual(spaceNews().map((r) => r.args.folder), [dir, wt]);
});

test("the repo's space is not reopened when it is already open, off, or the folder itself", async () => {
  const dir = repo(); const wt = scratch("pp-wt");
  state.spaces = [{ id: "s", folder: dir, machine: null }];
  await build(project(dir, { worktree: { repoSpace: true } }), wt, "x");
  assert.equal(spaceNews().length, 1);
  reset();
  await build(project(dir, { worktree: { repoSpace: false } }), wt, "x");
  assert.equal(spaceNews().length, 1);
  reset();
  await build(project(dir, { worktree: { repoSpace: true } }), dir, "x");
  assert.equal(spaceNews().length, 1);
});

test("a multi-tab project opens each later tab in its own folder with its command", async () => {
  const dir = realpathSync(makeRepo()); mkdirSync(join(dir, "web")); mkdirSync(join(dir, "api"));
  const p = normalize({ name: "Shop", path: dir, startup: { tabs: [{ name: "agent", panes: [{ type: "agent", agent: "claude" }] }, { name: "web", folder: "web", command: "npm run dev" }, { name: "api", folder: "api", panes: [{ command: "make run" }, { command: "psql", direction: "right" }] }] } });
  await W.buildWorkspace({ project: p, folder: dir, name: "Shop", tabs: p.startup.tabs, prompt: "", log: () => {} });
  assert.deepEqual(state.tabsMade.map((t) => [t.name, t.folder, t.argv]), [["web", `${dir}/web`, ["sh", "-c", "npm run dev"]], ["api", `${dir}/api`, ["sh", "-c", "make run"]]]);
  assert.equal(state.splits.length, 1);
  assert.equal(state.splits[0].argv[4], `${dir}/api`);
  assert.equal(state.runs.find((r) => r.command === "space.new").args.tab, "agent", "the first tab is named too");
});
test("a pane's folder is relative to its tab's folder", async () => {
  const dir = realpathSync(makeRepo()); mkdirSync(join(dir, "backend/db"), { recursive: true });
  const p = normalize({ name: "S", path: dir, startup: { tabs: [{ name: "api", folder: "backend", panes: [{ command: "a" }, { command: "b", direction: "right", folder: "db" }] }] } });
  await W.buildWorkspace({ project: p, folder: dir, name: "S", tabs: p.startup.tabs, prompt: "", log: () => {} });
  assert.equal(state.splits[0].argv[4], `${dir}/backend/db`);
});
test("a missing tab or pane folder stops the launch before any space is made, naming it", async () => {
  const dir = realpathSync(makeRepo());
  const p = normalize({ name: "S", path: dir, startup: { tabs: [{ name: "agent", command: "" }, { name: "web", folder: "nope", command: "x" }] } });
  await assert.rejects(W.buildWorkspace({ project: p, folder: dir, name: "S", tabs: p.startup.tabs, prompt: "", log: () => {} }), /Tab "web" pane 1: folder does not exist: .*nope/);
  assert.equal(state.runs.length, 0);
});
test("a prompt with no agent pane anywhere is reported, not sent", async () => {
  const dir = realpathSync(makeRepo()); const notes = [];
  const p = normalize({ name: "S", path: dir, startup: { tabs: [{ name: "s" }] } });
  await W.buildWorkspace({ project: p, folder: dir, name: "S", tabs: p.startup.tabs, prompt: "do it", log: (m) => notes.push(m) });
  assert.ok(notes.some((n) => /no agent pane to prompt/.test(n)));
  assert.equal(state.sent.length, 0);
  assert.equal(state.runs.find((r) => r.command === "space.new").args.task, undefined);
});
test("an agent in a later pane gets an arg prompt on its command line and a send prompt into its own terminal", async () => {
  const dir = realpathSync(makeRepo());
  const mk = (promptMode) => normalize({ name: "S", path: dir, startup: { tabs: [{ name: "t", panes: [{ type: "shell" }, { type: "agent", agent: "claude", promptMode, direction: "right" }] }] } });
  await W.buildWorkspace({ project: mk("arg"), folder: dir, name: "S", tabs: mk("arg").startup.tabs, prompt: "hi", log: () => {} });
  assert.deepEqual(state.splits[0].argv.slice(-2), ["claude", "hi"]);
  reset();
  await W.buildWorkspace({ project: mk("send"), folder: dir, name: "S", tabs: mk("send").startup.tabs, prompt: "hi", log: () => {} });
  assert.equal(state.sent[0].terminal, "t-pane-1");
});
test("folders expand ~ and $VAR", async () => {
  const dir = realpathSync(makeRepo()); mkdirSync(join(dir, "sub"));
  process.env.PJ_TEST_SUB = "sub";
  const p = normalize({ name: "S", path: dir, startup: { tabs: [{ name: "a" }, { name: "b", folder: "$PJ_TEST_SUB", command: "x" }] } });
  await W.buildWorkspace({ project: p, folder: dir, name: "S", tabs: p.startup.tabs, prompt: "", log: () => {} });
  assert.equal(state.tabsMade[0].folder, `${dir}/sub`);
});
