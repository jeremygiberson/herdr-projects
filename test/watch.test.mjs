import "./helpers/setup.mjs";
import test, { beforeEach } from "node:test";
import assert from "node:assert/strict";
import { join } from "node:path";
import { mkdirSync } from "node:fs";
import { makeRepo, scratch, sh } from "./helpers/repo.mjs";

const { state, reset, setShared } = await import("./helpers/herdr-stub.mjs");
const { Watcher } = await import("../mods/projects/watch.js");
const G = await import("../mods/projects/git.js");
const { normalize, blankProject, blankPane, basename } = await import("../mods/projects/lib.js");

beforeEach(reset);

const SHELL = { key: "shell", shell: true, agent: false };
const TOP = { key: "program", shell: false, agent: false };
const CLAUDE = { key: "claude", shell: false, agent: true };

/** A space the app shows, with its one pane running `program` (one tab, one pane, local unless `over` says otherwise). */
function addSpace(id, folder, program = SHELL, over = {}) {
  state.spaces.push({ id, name: basename(folder), folder, ...over });
  state.panes.push({ pane: `p-${id}`, terminal: `t-${id}`, tab: `tb-${id}`, cwd: folder, program });
}

/** A Watcher with recording fakes for its injected functions (real git underneath repoKey, branchOf, realPath),
 *  and a fake cx whose timer is captured and whose spawn runs at once. */
function harness({ projects = [], layouts = [], autoLayouts = [], defaultAgent = null, build = null, loadConfig = null, active = undefined, result = {} } = {}) {
  const rec = { builds: [], setups: [], repoKeys: [], logs: [], order: [], timer: null };
  const tasks = [];
  const cx = { timer: { every: (ms, fn) => { rec.timer = { ms, fn }; } }, spawn: (fn) => { tasks.push(fn(cx)); } };
  const w = new Watcher({
    loadConfig: loadConfig ?? (async () => ({ projects, layouts, autoLayouts, defaultAgent, gitInfo: true, hideTemplate: false, raw: "{}" })),
    prepareSetup: async ({ log, ...a }) => { rec.setups.push(a); return { chain: `chain:${a.folder}`, marker: undefined, steps: [], env: {} }; },
    buildWorkspace: async ({ log, ...a }) => {
      rec.builds.push(a);
      if (build) await build(a);
      return { space: a.existing.space, agentTerminal: null, problems: 0, ...result };
    },
    repoKey: async (f) => { rec.repoKeys.push(f); return G.repoKey(f); },
    branchOf: G.branchOf,
    realPath: G.realPath,
    log: (level, message, data) => rec.logs.push({ level, message, data }),
    ...(active ? { active } : {}),
  });
  const settle = async () => { while (tasks.length) await tasks.shift(); };
  const tick = async () => { w.tick(cx); await settle(); };
  return { w, cx, rec, tick };
}

/** An auto-layout project on `dir`: an agent tab and a dev tab, "after" timing, one setup step. */
const apiProject = (dir, over = {}) => normalize({
  name: "Api", path: dir,
  worktree: { autoLayout: true, copy: [".env"], setup: ["npm ci"] },
  startup: {
    agentTiming: "after", setup: ["make db"],
    tabs: [{ name: "agent", panes: [{ name: "agent", type: "agent", agent: "claude" }] }, { name: "dev", command: "npm run dev" }],
  },
  ...over,
});

const existingOf = (id, folder, agent = false) => ({ space: id, tab: `tb-${id}`, pane: `p-${id}`, terminal: `t-${id}`, folder, agent });

test("spaces present at start are seen and never built", async () => {
  const dir = makeRepo();
  addSpace("s1", dir);
  const { w, cx, rec, tick } = harness({ projects: [apiProject(dir)] });
  w.start(cx);
  assert.equal(rec.timer.ms, 2000);
  rec.timer.fn(cx);
  await tick();
  assert.deepEqual(rec.builds, []);
  assert.deepEqual(rec.repoKeys, []);
  // One opened after the start is built, by the timer's tick.
  const wt = join(scratch("pp-wt"), "feat");
  sh(dir, "worktree", "add", "-q", "-b", "feat", wt);
  addSpace("s2", wt);
  rec.timer.fn(cx);
  await tick();
  assert.deepEqual(rec.builds.map((b) => b.existing.space), ["s2"]);
});

test("a new one-pane shell space on an autoLayout project's checkout is built with the project's tabs, no prompt, the project's timing", async () => {
  const dir = makeRepo();
  const p = apiProject(dir);
  const { w, cx, rec, tick } = harness({ projects: [normalize({ name: "Other", path: scratch() }), p] });
  w.start(cx);
  addSpace("s1", dir);
  await tick();
  assert.deepEqual(rec.setups, [{ project: p, folder: dir, isWorktree: false, branch: "main", repo: basename(dir), home: state.home }]);
  assert.deepEqual(rec.builds, [{
    project: p, folder: dir, name: basename(dir), tabs: p.startup.tabs, prompt: "", agentTiming: "after",
    chain: `chain:${dir}`, existing: existingOf("s1", dir),
  }]);
  assert.deepEqual(state.notified, [{ title: "Projects", body: `Api set up in ${basename(dir)}` }]);
});

test("an inactive watcher marks new spaces seen but never builds them, even once it turns active", async () => {
  const dir = makeRepo();
  let on = false;
  const { w, cx, rec, tick } = harness({ projects: [apiProject(dir)], active: () => on });
  w.start(cx);
  addSpace("s1", dir);
  await tick();
  assert.ok(w.seen.has("s1"), "seen while inactive");
  assert.deepEqual(rec.builds, []);
  on = true;
  await tick();
  assert.deepEqual(rec.builds, [], "it appeared while another copy was the active one");
  addSpace("s2", dir);
  await tick();
  assert.deepEqual(rec.builds.map((b) => b.existing.space), ["s2"], "active now: a later space is built");
});

test("a new space on a linked worktree of the project matches too, and prepareSetup gets isWorktree true", async () => {
  const dir = makeRepo();
  const wt = join(scratch("pp-wt"), "feat");
  sh(dir, "worktree", "add", "-q", "-b", "feat", wt);
  const p = apiProject(dir);
  const { w, cx, rec, tick } = harness({ projects: [p] });
  w.start(cx);
  addSpace("s1", wt);
  await tick();
  assert.deepEqual(rec.setups, [{ project: p, folder: wt, isWorktree: true, branch: "feat", repo: basename(dir), home: state.home }]);
  assert.deepEqual(rec.builds, [{
    project: p, folder: wt, name: "feat", tabs: p.startup.tabs, prompt: "", agentTiming: "after",
    chain: `chain:${wt}`, existing: existingOf("s1", wt),
  }]);
});

test("a space whose folder moved before the tick does not match", async () => {
  // Opened in the checkout, but its terminal cd'd elsewhere before the watcher saw it: the folder at appearance counts.
  const dir = makeRepo();
  const elsewhere = scratch("pp-elsewhere");
  const { w, cx, rec, tick } = harness({ projects: [apiProject(dir)] });
  w.start(cx);
  addSpace("s1", elsewhere);
  w.tick(cx);
  // Back in the checkout before the check runs, and on the next tick: neither is looked at.
  state.spaces[0].folder = dir;
  await tick();
  assert.deepEqual(rec.repoKeys, [elsewhere]);
  assert.deepEqual(rec.builds, []);
  assert.deepEqual(state.notified, []);
});

test("two spaces in one tick are both considered, one after the other", async () => {
  const dir = makeRepo();
  const wt = join(scratch("pp-wt"), "feat");
  sh(dir, "worktree", "add", "-q", "-b", "feat", wt);
  const p = apiProject(dir);
  const { w, cx, rec, tick } = harness({
    projects: [p],
    build: async (a) => {
      rec.order.push(`start ${a.existing.space}`);
      await new Promise((r) => setTimeout(r, 30));
      rec.order.push(`end ${a.existing.space}`);
    },
  });
  w.start(cx);
  addSpace("s1", dir);
  addSpace("s2", wt);
  await tick();
  assert.deepEqual(rec.order, ["start s1", "end s1", "start s2", "end s2"]);
  assert.deepEqual(rec.builds.map((b) => b.existing), [existingOf("s1", dir), existingOf("s2", wt)]);
});

test("a pane running neither a shell nor an agent is left alone and never revisited", async () => {
  const dir = makeRepo();
  const { w, cx, rec, tick } = harness({ projects: [apiProject(dir)] });
  w.start(cx);
  addSpace("s1", dir, TOP);
  await tick();
  // `top` quit and the shell is back: the space was already considered.
  state.panes[0].program = SHELL;
  await tick();
  await tick();
  assert.deepEqual(rec.builds, []);
  assert.deepEqual(rec.repoKeys, []);
  assert.equal(rec.logs.filter((l) => l.level === "debug" && l.data?.space === "s1").length, 1);
});

test("a space the picker is opening is skipped", async () => {
  const dir = makeRepo();
  const wt = join(scratch("pp-wt"), "feat");
  sh(dir, "worktree", "add", "-q", "-b", "feat", wt);
  const { w, cx, rec, tick } = harness({ projects: [apiProject(dir)] });
  w.start(cx);
  // The picker marked the checkout just now; the worktree's mark is from a launch over a minute ago.
  setShared("projects.opening", { [dir]: Date.now(), [wt]: Date.now() - 61000 });
  addSpace("s1", dir);
  addSpace("s2", wt);
  await tick();
  assert.deepEqual(rec.builds.map((b) => b.existing.space), ["s2"]);
});

test("a space with two tabs, or a remote space, is skipped", async () => {
  const dir = makeRepo();
  const { w, cx, rec, tick } = harness({ projects: [apiProject(dir)] });
  w.start(cx);
  addSpace("s1", dir, SHELL, { tabs: [{ id: "tb-s1", name: "1", panes: 1 }, { id: "tb-s1b", name: "2", panes: 1 }] });
  addSpace("s2", dir, SHELL, { tabs: [{ id: "tb-s2", name: "1", panes: 2 }] });
  addSpace("s3", dir, SHELL, { machine: "box" });
  await tick();
  assert.deepEqual(rec.builds, []);
  assert.deepEqual(rec.repoKeys, []);
  assert.deepEqual(rec.logs.filter((l) => l.message.startsWith("watcher: left alone")).map((l) => l.data.space), ["s1", "s2", "s3"]);
});

test("an agent already running is adopted: existing.agent true", async () => {
  const dir = makeRepo();
  const p = apiProject(dir);
  const { w, cx, rec, tick } = harness({ projects: [p] });
  w.start(cx);
  addSpace("s1", dir, CLAUDE);
  state.agents.push({ address: "t-s1", pane: "p-s1", space: "s1", tab: "tb-s1" });
  await tick();
  assert.deepEqual(rec.builds, [{
    project: p, folder: dir, name: basename(dir), tabs: p.startup.tabs, prompt: "", agentTiming: "after",
    chain: `chain:${dir}`, existing: existingOf("s1", dir, true),
  }]);
});

test("a repo that is not a project falls back to autoLayouts and defaultAgent", async () => {
  const dir = makeRepo();
  const wt = join(scratch("pp-wt"), "release");
  sh(dir, "worktree", "add", "-q", "-b", "release", wt);
  // A template on the repo doesn't claim it.
  const projects = [{ ...apiProject(dir), name: "Template", template: true }];
  const layouts = [
    { name: "pair", panes: [{ name: "agent", type: "agent" }, { name: "shell", type: "shell", direction: "right" }] },
    { name: "deploy", tabs: [{ name: "deploy", command: "make deploy" }] },
  ];
  const autoLayouts = [{ repo: "*", branch: "", layout: "none" }, { repo: basename(dir), branch: "", layout: "pair" }, { repo: basename(dir).toUpperCase(), branch: "release", layout: "deploy" }];
  const { w, cx, rec, tick } = harness({ projects, layouts, autoLayouts, defaultAgent: { agent: "codex", args: "--fast" } });
  w.start(cx);
  addSpace("s1", dir);
  addSpace("s2", wt);
  await tick();
  assert.deepEqual(rec.setups, [
    { project: blankProject(dir), folder: dir, isWorktree: false, branch: "main", repo: basename(dir), home: state.home },
    { project: blankProject(wt), folder: wt, isWorktree: true, branch: "release", repo: basename(dir), home: state.home },
  ]);
  assert.deepEqual(rec.builds, [
    {
      project: blankProject(dir), folder: dir, name: basename(dir), prompt: "", agentTiming: "with", chain: `chain:${dir}`,
      tabs: [{ name: "agent", folder: "", command: "", panes: [
        blankPane({ name: "agent", type: "agent", agent: "codex", args: "--fast" }),
        blankPane({ name: "shell", type: "shell", direction: "right" }),
      ] }],
      existing: existingOf("s1", dir),
    },
    {
      project: blankProject(wt), folder: wt, name: "release", prompt: "", agentTiming: "with", chain: `chain:${wt}`,
      tabs: [{ name: "deploy", folder: "", command: "make deploy", panes: [] }],
      existing: existingOf("s2", wt),
    },
  ]);
  assert.deepEqual(state.notified.map((n) => n.body), [`pair set up in ${basename(dir)}`, "deploy set up in release"]);
});

test("a build failure is logged and toasted, and the space is not retried", async () => {
  const dir = makeRepo();
  const { w, cx, rec, tick } = harness({ projects: [apiProject(dir)], build: async () => { throw new Error("boom"); } });
  w.start(cx);
  addSpace("s1", dir);
  await tick();
  await tick();
  assert.equal(rec.builds.length, 1);
  assert.equal(rec.logs.filter((l) => l.level === "error").length, 1);
  assert.match(rec.logs.find((l) => l.level === "error").message, /boom/);
  assert.deepEqual(state.notified, [{ title: "Projects", body: `couldn't set up ${basename(dir)}: boom`, level: "error" }]);
});

test("a space in a subfolder of the checkout is the checkout: isWorktree false, built at the checkout", async () => {
  const dir = makeRepo();
  const sub = join(dir, "sub");
  mkdirSync(sub);
  const p = apiProject(dir);
  const { w, cx, rec, tick } = harness({ projects: [p] });
  w.start(cx);
  addSpace("s1", sub);
  await tick();
  assert.deepEqual(rec.setups, [{ project: p, folder: dir, isWorktree: false, branch: "main", repo: basename(dir), home: state.home }]);
  assert.deepEqual(rec.builds, [{
    project: p, folder: dir, name: "sub", tabs: p.startup.tabs, prompt: "", agentTiming: "after",
    chain: `chain:${dir}`, existing: existingOf("s1", sub),
  }]);
});

test("an unreadable projects file is toasted once and logged every time", async () => {
  const dir = makeRepo();
  const wt = join(scratch("pp-wt"), "feat");
  sh(dir, "worktree", "add", "-q", "-b", "feat", wt);
  const { w, cx, rec, tick } = harness({ loadConfig: async () => { throw new Error("projects.json is not valid JSON"); } });
  w.start(cx);
  addSpace("s1", dir);
  addSpace("s2", wt);
  await tick();
  assert.deepEqual(rec.builds, []);
  assert.equal(rec.logs.filter((l) => l.level === "error").length, 2);
  assert.equal(state.notified.length, 1);
  assert.equal(state.notified[0].level, "error");
  assert.match(state.notified[0].body, /not valid JSON/);
});

test("a quickSetup project's steps go to the chain: prepareSetup gets quickSetup false, its chain reaches the build", async () => {
  const dir = makeRepo();
  const p = apiProject(dir, { worktree: { autoLayout: true, setup: ["x"] }, startup: { ...apiProject(dir).startup, quickSetup: true } });
  assert.equal(p.startup.quickSetup, true);
  const { w, cx, rec, tick } = harness({ projects: [p] });
  w.start(cx);
  addSpace("s1", dir);
  await tick();
  assert.equal(rec.setups.length, 1);
  assert.equal(rec.setups[0].project.startup.quickSetup, false);
  assert.deepEqual(rec.setups[0].project, { ...p, startup: { ...p.startup, quickSetup: false } });
  assert.equal(rec.builds.length, 1);
  assert.equal(rec.builds[0].chain, `chain:${dir}`);
  assert.equal(rec.builds[0].project, p);
});

test("a throw while reading the app is logged and toasted", async () => {
  const dir = makeRepo();
  const { w, cx, rec, tick } = harness({ projects: [apiProject(dir)] });
  w.start(cx);
  addSpace("s1", dir);
  state.panes = null; // panes().find throws
  await tick();
  assert.deepEqual(rec.builds, []);
  assert.equal(rec.logs.filter((l) => l.level === "error").length, 1);
  assert.equal(state.notified.length, 1);
  assert.equal(state.notified[0].level, "error");
});

test("a repo whose project has auto-layout off is left alone, even when an autoLayouts entry names it", async () => {
  const dir = makeRepo();
  const layouts = [{ name: "pair", panes: [{ name: "agent", type: "agent" }, { name: "shell", type: "shell", direction: "right" }] }];
  const { w, cx, rec, tick } = harness({ projects: [apiProject(dir, { worktree: { autoLayout: false } })], layouts, autoLayouts: [{ repo: "*", branch: "", layout: "pair" }] });
  w.start(cx);
  addSpace("s1", dir);
  await tick();
  assert.deepEqual(rec.builds, []);
  assert.deepEqual(state.notified, []);
  assert.ok(rec.logs.some((l) => l.message.startsWith("watcher: left alone") && l.data?.space === "s1"));
});

test("a project in a subfolder of its repo: a space there is the checkout, a space in a worktree is built in the worktree's subfolder", async () => {
  const dir = makeRepo();
  const pkg = join(dir, "pkg");
  mkdirSync(pkg);
  const wt = join(scratch("pp-wt"), "feat");
  sh(dir, "worktree", "add", "-q", "-b", "feat", wt);
  mkdirSync(join(wt, "pkg"));
  const p = apiProject(pkg);
  const { w, cx, rec, tick } = harness({ projects: [p] });
  w.start(cx);
  addSpace("s1", pkg);
  await tick();
  addSpace("s2", wt);
  await tick();
  assert.deepEqual(rec.setups.map((s) => [s.folder, s.isWorktree]), [[pkg, false], [join(wt, "pkg"), true]]);
  assert.deepEqual(rec.builds.map((b) => b.folder), [pkg, join(wt, "pkg")]);
});

test("while this computer's layout is still loading, new spaces are only marked seen", async () => {
  const dir = makeRepo();
  state.machines = [{ name: "box", layout: "ready" }, { name: null, layout: "loading" }];
  const { w, cx, rec, tick } = harness({ projects: [apiProject(dir)] });
  w.start(cx);
  addSpace("s1", dir);
  await tick();
  assert.ok(w.seen.has("s1"));
  assert.deepEqual(rec.builds, []);
  state.machines = [{ name: null, layout: "ready" }];
  await tick();
  assert.deepEqual(rec.builds, [], "a space restored while loading stays seen");
  addSpace("s2", dir);
  await tick();
  assert.deepEqual(rec.builds.map((b) => b.existing.space), ["s2"]);
});

test("an agent at its trust prompt (no agent record, the pane's program is an agent) is adopted", async () => {
  const dir = makeRepo();
  const { w, cx, rec, tick } = harness({ projects: [apiProject(dir)] });
  w.start(cx);
  addSpace("s1", dir, CLAUDE);
  await tick();
  assert.equal(rec.builds.length, 1);
  assert.equal(rec.builds[0].existing.agent, true);
  assert.equal(rec.builds[0].existing.terminal, "t-s1");
});

test("a build with problems says so in its toast; a build skipped under the lock toasts nothing", async () => {
  const dir = makeRepo();
  const one = harness({ projects: [apiProject(dir)], result: { problems: 2 } });
  one.w.start(one.cx);
  addSpace("s1", dir);
  await one.tick();
  assert.deepEqual(state.notified.map((n) => n.body), [`Api set up in ${basename(dir)} with 2 problems (see the log)`]);
  reset();
  const two = harness({ projects: [apiProject(dir)], result: { problems: 1, skipped: true } });
  two.w.start(two.cx);
  addSpace("s2", dir);
  await two.tick();
  assert.equal(two.rec.builds.length, 1);
  assert.deepEqual(state.notified, []);
});

test("with no entry for this computer in machines(), new spaces are built", async () => {
  const dir = makeRepo();
  state.machines = [];
  const { w, cx, rec, tick } = harness({ projects: [apiProject(dir)] });
  w.start(cx);
  addSpace("s1", dir);
  await tick();
  assert.deepEqual(rec.builds.map((b) => b.existing.space), ["s1"]);
});
