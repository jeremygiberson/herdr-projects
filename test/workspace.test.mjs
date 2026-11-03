import "./helpers/setup.mjs";
import test, { beforeEach } from "node:test";
import assert from "node:assert/strict";
import { mkdirSync, readFileSync, realpathSync, existsSync } from "node:fs";
import { join } from "node:path";
import { makeRepo, scratch } from "./helpers/repo.mjs";

const { state, reset, shared, setShared } = await import("./helpers/herdr-stub.mjs");
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

test("the repo's space counts as open when its space shows a folder below the repo", async () => {
  const dir = repo(); const wt = scratch("pp-wt");
  state.spaces = [{ id: "s", folder: `${dir}/web`, machine: null }];
  await build(project(dir, { worktree: { repoSpace: true } }), wt, "x");
  assert.equal(spaceNews().length, 1);
});
test("when the new space can't be found, the later tabs are skipped rather than made in another space", async () => {
  state.appLsHidesSpaces = true;
  state.focused = { space: "picker-space", pane: "picker-pane" };
  const dir = repo();
  await build(project(dir, { startup: { agent: "claude", tabs: ["npm test", "lazygit"] } }), dir, "Demo");
  assert.equal(spaceNews().length, 1);
  assert.deepEqual(state.tabsMade, []);
  // with a setup chain beside the agent, the busy screen says setup did not start rather than that it runs
  reset(); state.appLsHidesSpaces = true;
  const p = normalize({ name: "S", path: dir, startup: { tabs: [{ name: "agent", panes: [{ type: "agent", agent: "claude" }] }] } });
  const notes = [];
  await W.buildWorkspace({ project: p, folder: dir, name: "S", tabs: p.startup.tabs, prompt: "", agentTiming: "with", chain: "true", log: (m) => notes.push(m) });
  assert.ok(notes.includes("setup did not start: couldn't find the new space"), notes.join(" | "));
  assert.ok(!notes.includes("setup runs in the setup tab"));
  assert.equal(state.hcRuns.length, 0);
});

test("after timing: the agent pane runs the chain and execs the agent with its arg prompt; no task is passed", async () => {
  const dir = realpathSync(makeRepo());
  const p = normalize({ name: "S", path: dir, startup: { tabs: [{ name: "agent", panes: [{ type: "agent", agent: "claude", args: "--model opus" }] }] } });
  const notes = [];
  await W.buildWorkspace({ project: p, folder: dir, name: "S", tabs: p.startup.tabs, prompt: "fix it", agentTiming: "after", chain: `cd '${dir}' && npm ci`, log: (m) => notes.push(m) });
  const sn = state.runs.find((r) => r.command === "space.new").args;
  assert.deepEqual(sn.argv.slice(0, 2), ["sh", "-c"]);
  assert.ok(sn.argv[2].endsWith(`npm ci && cd '${dir}' && exec 'claude' '--model' 'opus' 'fix it' || exec "$SHELL"`), sn.argv[2]);
  assert.equal(sn.task, undefined);
  assert.ok(notes.includes("setup continues in the agent pane"));
  assert.equal(state.hcRuns.length, 0);
});
test("after timing with a send prompt starts the detached helper and does not wait or send", async () => {
  const dir = realpathSync(makeRepo());
  const p = normalize({ name: "S", path: dir, startup: { tabs: [{ name: "agent", panes: [{ type: "agent", agent: "hermes", promptMode: "send" }] }] } });
  state.agentStatus = "working";
  await W.buildWorkspace({ project: p, folder: dir, name: "S", tabs: p.startup.tabs, prompt: "go", agentTiming: "after", chain: "true", log: () => {} });
  assert.equal(state.sent.length, 0);
  const run = state.hcRuns[0].args;
  assert.ok(run.includes("--bg") && run.some((a) => a.endsWith("bin/send-prompt.sh")), run.join(" "));
  const file = run[run.length - 2];
  assert.equal(readFileSync(file, "utf8"), "go");
  assert.deepEqual(run.slice(-2), [file, "hermes"]);
});
test("with timing runs the chain in a setup terminal beside the agent, which starts at once", async () => {
  const dir = realpathSync(makeRepo());
  const p = normalize({ name: "S", path: dir, startup: { tabs: [{ name: "agent", panes: [{ type: "agent", agent: "claude" }] }] } });
  const notes = [];
  await W.buildWorkspace({ project: p, folder: dir, name: "S", tabs: p.startup.tabs, prompt: "hi", agentTiming: "with", chain: "true", log: (m) => notes.push(m) });
  const sn = state.runs.find((r) => r.command === "space.new").args;
  assert.deepEqual([sn.argv, sn.task], [["claude"], "hi"]);
  assert.ok(notes.includes("setup runs in the setup tab"));
  // One of the two spike mechanisms: a labeled hc run, or a tab.new named setup; either way the chain ends in a shell fallback.
  const viaHc = state.hcRuns.find((r) => r.args.includes("run") && r.args.some((a) => a.startsWith("herdr.space=")));
  const viaTab = state.tabsMade.find((t) => t.name === "setup");
  const line = viaHc ? viaHc.args.at(-1) : viaTab?.argv?.[2];
  assert.match(line ?? "", /^true \|\| exec "\$SHELL"$/);
  const tabId = viaHc.args.find((a) => a.startsWith("herdr.tab=")).slice("herdr.tab=".length);
  assert.match(tabId, /^setup-\d+$/);
  assert.deepEqual(state.renames, [{ id: tabId, name: "setup" }]);
});
test("after timing with no chain behaves like with; no agent with a chain runs it in the setup terminal", async () => {
  const dir = realpathSync(makeRepo());
  const p = normalize({ name: "S", path: dir, startup: { tabs: [{ name: "agent", panes: [{ type: "agent", agent: "claude" }] }] } });
  await W.buildWorkspace({ project: p, folder: dir, name: "S", tabs: p.startup.tabs, prompt: "", agentTiming: "after", chain: "", log: () => {} });
  assert.deepEqual(state.runs.find((r) => r.command === "space.new").args.argv, ["claude"]);
  reset();
  const q = normalize({ name: "S", path: dir, startup: { tabs: [{ name: "s" }] } });
  const notes = [];
  await W.buildWorkspace({ project: q, folder: dir, name: "S", tabs: q.startup.tabs, prompt: "", agentTiming: "after", chain: "true", log: (m) => notes.push(m) });
  assert.ok(notes.includes("setup runs in the setup tab"));
});
test("a setup tab that never shows up is not renamed, and the launch still finishes", async () => {
  const dir = realpathSync(makeRepo());
  const p = normalize({ name: "S", path: dir, startup: { tabs: [{ name: "agent", panes: [{ type: "agent", agent: "claude" }] }] } });
  state.hcRunHidesTab = true;
  const notes = [];
  await W.buildWorkspace({ project: p, folder: dir, name: "S", tabs: p.startup.tabs, prompt: "", agentTiming: "with", chain: "true", log: (m) => notes.push(m) });
  assert.equal(state.hcRuns.length, 1);
  assert.deepEqual(state.renames, []);
  assert.ok(notes.includes("setup runs in the setup tab"));
});
test("with timing: an hc run that fails says setup did not start, with hc's error", async () => {
  const dir = realpathSync(makeRepo());
  const p = normalize({ name: "S", path: dir, startup: { tabs: [{ name: "agent", panes: [{ type: "agent", agent: "claude" }] }] } });
  state.hcRunFails = true;
  const notes = [];
  await W.buildWorkspace({ project: p, folder: dir, name: "S", tabs: p.startup.tabs, prompt: "", agentTiming: "with", chain: "true", log: (m) => notes.push(m) });
  assert.ok(notes.includes("setup did not start: no such space"), notes.join(" | "));
  assert.ok(!notes.includes("setup runs in the setup tab"));
});
test("after timing: the agent starts in its own pane's folder, not the chain's", async () => {
  const dir = realpathSync(makeRepo()); mkdirSync(join(dir, "backend"));
  const p = normalize({ name: "S", path: dir, startup: { tabs: [{ name: "agent", panes: [{ type: "agent", agent: "claude", folder: "backend" }] }] } });
  await W.buildWorkspace({ project: p, folder: dir, name: "S", tabs: p.startup.tabs, prompt: "", agentTiming: "after", chain: `cd '${dir}' && true`, log: () => {} });
  const line = state.runs.find((r) => r.command === "space.new").args.argv[2];
  assert.ok(line.includes(`cd '${dir}/backend' && exec 'claude'`), line);
});
test("send mode types a prompt starting with - after --", async () => {
  const dir = repo();
  await build(project(dir, { startup: { agent: "hermes", prompt: "-x foo", promptMode: "send" } }), dir, "Demo");
  assert.deepEqual(state.sent, [{ terminal: "t2", text: "-x foo" }]);
});
test("after timing with a send prompt removes the prompt file when the helper can't start", async () => {
  const dir = realpathSync(makeRepo());
  const p = normalize({ name: "S", path: dir, startup: { tabs: [{ name: "agent", panes: [{ type: "agent", agent: "hermes", promptMode: "send" }] }] } });
  state.hcRunFails = true;
  await W.buildWorkspace({ project: p, folder: dir, name: "S", tabs: p.startup.tabs, prompt: "go", agentTiming: "after", chain: "true", log: () => {} });
  const run = state.hcRuns[0].args;
  assert.equal(existsSync(run[run.length - 2]), false);
});

// ---- phase 3: the shared lock, the opening marker, and building into a space that already exists ----

test("the shared lock is taken for a build and released after it; a stale lock is ignored", async () => {
  const dir = repo();
  setShared("projects.lock", { since: Date.now() - 30000 });
  const started = Date.now();
  let done = false, seen = null;
  // send mode looks up terminals with hc inside the locked turn, which gives the loop below a turn mid-build
  const building = build(project(dir, { startup: { agent: "claude", prompt: "go", promptMode: "send" } }), dir, "Demo").finally(() => { done = true; });
  while (!done) {
    const l = shared("projects.lock");
    if (l && Date.now() - l.since < 5000) seen ??= l;
    await new Promise((r) => setImmediate(r)); // the stub's hc answers on setImmediate too, so this reads mid-build
  }
  await building;
  assert.ok(seen && seen.since >= started, "a recent lock is held during the build");
  assert.equal(shared("projects.lock"), null);
  assert.ok(Date.now() - started < 5000, "the stale lock was not waited on");
  // a second build in a row is not held up by the first
  await build(project(dir, { startup: { agent: "claude" } }), dir, "Demo");
  assert.equal(spaceNews().length, 2);
  assert.equal(shared("projects.lock"), null);
});
test("the shared lock is released when the build throws inside it", async () => {
  const dir = repo();
  const p = normalize({ name: "S", path: dir, startup: { tabs: [{ name: "a" }] } });
  // a project without its worktree settings fails inside the locked turn
  await assert.rejects(W.buildWorkspace({ project: { ...p, worktree: undefined }, folder: dir, name: "S", tabs: p.startup.tabs, prompt: "", log: () => {} }));
  assert.equal(shared("projects.lock"), null);
});
test("a fresh shared lock held by another copy is waited on", async () => {
  const dir = repo();
  setShared("projects.lock", { since: Date.now() });
  setTimeout(() => setShared("projects.lock", null), 600);
  const started = Date.now();
  await build(project(dir), dir, "Demo");
  assert.ok(Date.now() - started >= 500, "waited for the other copy");
  assert.equal(shared("projects.lock"), null);
});
test("buildWorkspace records the folder it is opening in projects.opening before space.new", async () => {
  const dir = repo();
  setShared("projects.opening", { "/old": Date.now() - 6 * 60000, "/recent": Date.now() - 1000 });
  const started = Date.now();
  await build(project(dir), dir, "Demo");
  const opening = shared("projects.opening");
  assert.ok(opening[dir] >= started && opening[dir] <= Date.now(), JSON.stringify(opening));
  assert.equal("/old" in opening, false, "entries older than 5 min are pruned");
  assert.ok("/recent" in opening);
});

const existingSpace = (dir) => { state.spaces.push({ id: "spX", name: "S", folder: dir, machine: null }); state.terminals.push({ address: "tX", cwd: dir, state: "live", status: null }); };
const existing = (dir, agent) => ({ space: "spX", tab: "tbX", pane: "paneX", terminal: "tX", folder: dir, agent });

test("existing shell space, after timing: the chain-then-agent line is typed into the shell once it is in front, no space.new", async () => {
  const dir = realpathSync(makeRepo()); state.foreground = "zsh";
  const p = normalize({ name: "S", path: dir, startup: { tabs: [{ name: "agent", panes: [{ type: "agent", agent: "claude" }, { type: "shell", direction: "down" }] }, { name: "git", command: "lazygit" }] } });
  existingSpace(dir);
  await W.buildWorkspace({ project: p, folder: dir, name: "S", tabs: p.startup.tabs, prompt: "", agentTiming: "after", chain: "true", log: () => {}, existing: existing(dir, false) });
  assert.equal(state.runs.some((r) => r.command === "space.new"), false);
  const sent = state.sent.find((s) => s.terminal === "tX");
  assert.match(sent.text, /^true && cd '.*' && exec 'claude' \|\| exec "\$SHELL"$/);
  assert.equal(state.splits[0].pane, "paneX");
  assert.deepEqual(state.tabsMade.map((t) => [t.space, t.name]), [["spX", "git"]]);
  assert.equal(state.hcRuns.length, 0, "the chain runs in the agent's pane, not a setup terminal");
  assert.deepEqual(state.runs.filter((r) => r.command === "pane.focus").map((r) => r.args), [{ pane: "paneX" }]);
  assert.equal(shared("projects.opening"), undefined, "the opening marker is only for space.new");
});
test("existing shell space, with timing: exec agent is typed and the chain goes to the setup terminal", async () => {
  const dir = realpathSync(makeRepo()); state.foreground = "bash";
  const p = normalize({ name: "S", path: dir, startup: { tabs: [{ name: "agent", panes: [{ type: "agent", agent: "claude" }] }] } });
  existingSpace(dir);
  const notes = [];
  await W.buildWorkspace({ project: p, folder: dir, name: "ignored", tabs: p.startup.tabs, prompt: "", agentTiming: "with", chain: "true", log: (m) => notes.push(m), existing: existing(dir, false) });
  assert.equal(spaceNews().length, 0);
  assert.deepEqual(state.sent, [{ terminal: "tX", text: "exec 'claude'" }]);
  const setup = state.hcRuns.find((r) => r.args.includes("herdr.space=spX"));
  assert.ok(setup, JSON.stringify(state.hcRuns));
  assert.match(setup.args.at(-1), /^true \|\| exec "\$SHELL"$/);
  assert.ok(notes.includes("setup runs in the setup tab"), notes.join(" | "));
});
test("existing shell space: a command pane types its command, a shell pane types nothing", async () => {
  const dir = realpathSync(makeRepo()); state.foreground = "zsh";
  const mk = (pane) => normalize({ name: "S", path: dir, startup: { tabs: [{ name: "t", panes: [pane] }] } });
  existingSpace(dir);
  const cmd = mk({ type: "command", command: "npm run dev" });
  await W.buildWorkspace({ project: cmd, folder: dir, name: "S", tabs: cmd.startup.tabs, prompt: "", log: () => {}, existing: existing(dir, false) });
  assert.deepEqual(state.sent, [{ terminal: "tX", text: "npm run dev" }]);
  reset(); state.foreground = "zsh"; existingSpace(dir);
  const sh = mk({ type: "shell" });
  await W.buildWorkspace({ project: sh, folder: dir, name: "S", tabs: sh.startup.tabs, prompt: "", log: () => {}, existing: existing(dir, false) });
  assert.deepEqual(state.sent, []);
  assert.equal(spaceNews().length, 0);
});
test("existing agent space: nothing is typed, timing is forced with, the plan's agent pane elsewhere becomes a shell", async () => {
  const dir = realpathSync(makeRepo()); state.foreground = "zsh";
  const p = normalize({ name: "S", path: dir, startup: { tabs: [{ name: "term", panes: [{ type: "shell" }] }, { name: "agent", panes: [{ type: "agent", agent: "claude" }] }] } });
  existingSpace(dir);
  await W.buildWorkspace({ project: p, folder: dir, name: "S", tabs: p.startup.tabs, prompt: "", agentTiming: "after", chain: "true", log: () => {}, existing: existing(dir, true) });
  assert.equal(spaceNews().length, 0);
  assert.deepEqual(state.sent, []);
  assert.ok(state.hcRuns.some((r) => r.args.includes("herdr.space=spX")), "the chain runs in a setup terminal");
  assert.deepEqual(state.tabsMade.map((t) => [t.name, t.argv]), [["agent", undefined]]);
  assert.deepEqual(state.runs.filter((r) => r.command === "pane.focus").map((r) => r.args), [{ pane: "paneX" }]);
});
test("existing agent space with the agent at the first pane: nothing typed, the rest still splits", async () => {
  const dir = realpathSync(makeRepo()); state.foreground = "zsh";
  const p = normalize({ name: "S", path: dir, startup: { tabs: [{ name: "agent", panes: [{ type: "agent", agent: "claude" }, { type: "command", command: "yazi .", direction: "right" }] }] } });
  existingSpace(dir);
  await W.buildWorkspace({ project: p, folder: dir, name: "S", tabs: p.startup.tabs, prompt: "", agentTiming: "after", chain: "", log: () => {}, existing: existing(dir, true) });
  assert.deepEqual(state.sent, []);
  assert.deepEqual([state.splits[0].pane, state.splits[0].argv.slice(-3)], ["paneX", ["sh", "-c", "yazi ."]]);
});
test("existing shell space whose shell never comes to the front: the line is skipped and logged, the rest still builds", async () => {
  const dir = realpathSync(makeRepo()); state.foreground = "claude";
  const p = normalize({ name: "S", path: dir, startup: { tabs: [{ name: "agent", panes: [{ type: "agent", agent: "claude" }, { type: "shell", direction: "down" }] }] } });
  existingSpace(dir);
  const errors = []; const origError = console.error; console.error = (m) => errors.push(String(m));
  try {
    await W.buildWorkspace({ project: p, folder: dir, name: "S", tabs: p.startup.tabs, prompt: "", log: () => {}, existing: existing(dir, false) });
  } finally { console.error = origError; }
  assert.deepEqual(state.sent, []);
  assert.equal(state.splits.length, 1);
  assert.equal(state.splits[0].pane, "paneX");
  assert.ok(errors.some((e) => /couldn't type into the new space's shell/.test(e)), errors.join(" | "));
});
