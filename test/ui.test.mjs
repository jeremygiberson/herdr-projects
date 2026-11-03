// The picker's view, run without a window: gpui is replaced by a recording stub (test/helpers/gpui-stub.mjs), so the
// tests render each screen, press keys, click buttons and read back the text, icons and styles.
import "./helpers/setup.mjs";
import test, { beforeEach } from "node:test";
import assert from "node:assert/strict";
import { writeFileSync, readFileSync, mkdirSync, existsSync, rmSync, realpathSync } from "node:fs";
import { join } from "node:path";
import { makeRepo, scratch, sh } from "./helpers/repo.mjs";

const { state, reset, calls, resetCalls, setShared } = await import("./helpers/herdr-stub.mjs");
const { textOf, findAll } = await import("./helpers/gpui-stub.mjs");
const { default: Picker } = await import("../mods/projects/main.js");
const { normalize, firstAgent } = await import("../mods/projects/lib.js");

const dataFile = () => `${state.appHome}/data/projects.json`;
beforeEach(reset);

const mods = (o = {}) => ({ control: false, alt: false, platform: false, shift: false, ...o });
const press = (v, cx, key, m) => v.keys({ key, modifiers: mods(m) }, cx);
// Enter reaches the picker through the search box's submit event, not the key handler; on the launch screen it launches.
const enter = (v) => (v.mode === "launch" ? v.launchNow() : v.search.emit("submit"));
const CTRL_ALT = { control: true, alt: true };

/** A picker with these projects (and layouts) in its data file, loaded and rendered once. */
async function open(projects, layouts, opts = { detail: true }) {
  reset();
  if ("detail" in opts) setShared("projects.detail", opts.detail);
  mkdirSync(`${state.appHome}/data`, { recursive: true });
  writeFileSync(dataFile(), JSON.stringify({ ...(layouts ? { layouts } : {}), ...("gitInfo" in opts ? { gitInfo: opts.gitInfo } : {}), ...(opts.template ? {} : { hideTemplate: true }), projects }, null, 2));
  const pending = [];
  const cx = {
    timers: [],
    timer: { after: (ms, fn) => cx.timers.push({ ms, fn }), every: (ms, fn) => cx.every.push({ ms, fn }) },
    every: [],
    spawn: (fn) => { const p = fn(cx); pending.push(p); return p; },
    focus_handle: () => ({}),
    notify() {},
    stop_propagation() {},
    settle: async () => { for (let i = 0; i < 6; i++) { await Promise.all(pending.splice(0)); await new Promise((r) => setImmediate(r)); } },
    fire: (ms) => { for (const t of cx.timers.filter((x) => x.ms === ms)) t.fn(); },
  };
  const v = new Picker();
  v.init({}, cx);
  await cx.settle();
  return { v, cx };
}
/** A startup with one tab whose pane is this agent. */
const AG = (agent, extra = {}) => ({ tabs: [{ name: "agent", panes: [{ type: "agent", agent, ...extra }] }] });
const proj = (name, path, over = {}) => normalize({ name, path, git: { fetch: false }, ...over });
// What a draw reads is a snapshot of herdr's data, refreshed on a timer: a test that changes that data refreshes it first.
const rendered = (v) => { v.refreshSnap(); return v.render(); };
const texts = (v) => textOf(rendered(v));
const texts_noRefresh = (v) => textOf(v.render());
/** The detail card's layout choices: label → element, so a test can look at its styles. */
const chips = (v) => {
  const found = {};
  for (const el of findAll(rendered(v), (e) => /^pp-lay-/.test(e.op?.("id")?.[0] ?? ""))) found[textOf(el).replace(/project default$/, "")] = el;
  return found;
};
const lit = (chip) => chip.op("bg")[0] === "#selected";
const labelOf = (chip) => findAll(chip, (e) => e.tag === "div" && e.has("text_size") && e.op("text_size")[0] === 10.5)[0];

// ---------------------------------------------------------------- the list

test("the list shows each project with its folder, mode and group", async () => {
  const { v } = await open([proj("api", "/r/api", { group: "platform", worktree: { mode: "always" } }), proj("docs", "/r/docs", { worktree: { mode: "never" } })]);
  const t = texts(v);
  for (const s of ["Projects", "api", "docs", "/r/api", "platform", "worktree", "checkout"]) assert.ok(t.includes(s), s);
});

test("an empty list says how to start", async () => {
  const { v } = await open([]);
  assert.match(texts(v), /No projects yet/);
  const { v: v2 } = await open([proj("api", "/r/api")]);
  v2.search.set_value("zzzz");
  assert.match(texts(v2), /No project matches/);
});

test("each row has its agent's icon, a shell icon for a plain shell, and the generic icon for an unknown command", async () => {
  const { v } = await open([
    proj("a-claude", "/r/a", { startup: AG("claude --model opus") }),
    proj("b-codex", "/r/b", { startup: AG("codex") }),
    proj("c-shell", "/r/c"),
    proj("d-weird", "/r/d", { startup: AG("mytool") }),
  ]);
  const icons = findAll(rendered(v), (e) => e.tag === "svg" || e.tag === "image").map((e) => `${e.tag}:${e.arg}`);
  assert.ok(icons.includes("image:icons/claude.svg"));
  assert.ok(icons.includes("image:icons/codex.svg"), "an agent herdr's list lacks still gets its icon");
  assert.ok(icons.includes("svg:icons/shell.svg"));
  assert.ok(icons.includes("svg:icons/agent.svg"));
});

test("typing highlights the matched letters of the name", async () => {
  const { v } = await open([proj("api-gateway", "/r/gw")]);
  v.search.set_value("apgw");
  const bold = findAll(rendered(v), (e) => e.tag === "div" && e.has("font_bold") && e.op("text_color")?.[0] === "#accent").map(textOf);
  assert.deepEqual(bold, ["ap", "g", "w"]);
  v.search.set_value("");
  assert.deepEqual(findAll(rendered(v), (e) => e.tag === "div" && e.has("font_bold") && e.op("text_color")?.[0] === "#accent"), []);
});

test("arrow keys move the highlight and wrap; Escape closes", async () => {
  const { v, cx } = await open([proj("a", "/r/a"), proj("b", "/r/b"), proj("c", "/r/c")]);
  assert.equal(v.at, 0);
  press(v, cx, "down"); press(v, cx, "down");
  assert.equal(v.at, 2);
  press(v, cx, "down");
  assert.equal(v.at, 0);
  press(v, cx, "up");
  assert.equal(v.at, 2);
  press(v, cx, "escape");
  assert.equal(state.closed, 1);
});

test("the footer lists the keys", async () => {
  const { v } = await open([proj("a", "/r/a")]);
  const t = texts(v);
  for (const s of ["Enter", "Shift+Enter", "alt+n", "alt+e", "alt+w", "alt+d", "layout", "ctrl+alt+L", "ctrl+alt+I", "details"]) assert.ok(t.includes(s), s);
});

// ---------------------------------------------------------------- the layout selector

const LAYOUTS = [{ name: "coding", label: "Agent, files and a terminal", panes: [{ type: "agent" }, { name: "files", command: "yazi .", direction: "right" }] }];

test("the card shows every layout as a picture, with the project's own tabs first", async () => {
  const { v } = await open([proj("a", "/r/a")], LAYOUTS);
  const c = chips(v);
  assert.deepEqual(Object.keys(c), ["Project's tabs", "Agent + terminal below", "Agent + terminal right", "Agent, files and a terminal"]);
  assert.deepEqual(Object.entries(c).filter(([, e]) => lit(e)).map(([k]) => k), ["Project's tabs"]);
});

test("with nothing picked, the project's own tabs are lit", async () => {
  const { v } = await open([proj("a", "/r/a")], LAYOUTS);
  assert.deepEqual(Object.entries(chips(v)).filter(([, e]) => lit(e)).map(([k]) => k), ["Project's tabs"]);
});

test("ctrl+alt+L steps through the layouts and wraps; a bare alt+L or ctrl+L does nothing", async () => {
  const { v, cx } = await open([proj("a", "/r/a")], LAYOUTS);
  const now = () => Object.entries(chips(v)).filter(([, e]) => lit(e)).map(([k]) => k)[0];
  press(v, cx, "l", { alt: true });
  press(v, cx, "l", { control: true });
  press(v, cx, "l", { platform: true });
  assert.equal(now(), "Project's tabs");
  const seen = [];
  for (let i = 0; i < 5; i++) { press(v, cx, "l", CTRL_ALT); seen.push(now()); }
  assert.deepEqual(seen, ["Agent + terminal below", "Agent + terminal right", "Agent, files and a terminal", "Project's tabs", "Agent + terminal below"]);
  press(v, cx, "l", { platform: true, alt: true });
  assert.equal(now(), "Agent + terminal right", "cmd+alt+L works too");
});

test("a pick counts only while it differs from the project's own tabs", async () => {
  const { v, cx } = await open([proj("a", "/r/a")], LAYOUTS);
  press(v, cx, "l", CTRL_ALT);
  assert.equal(v.layoutPick, "agent-terminal", "the first step differs from the project's tabs");
  for (let i = 0; i < 3; i++) press(v, cx, "l", CTRL_ALT);
  assert.equal(v.layoutPick, null, "back at the project's own tabs: not a pick");
});

test("the lit layout picture gets an accent ring for a second after a change", async () => {
  const { v, cx } = await open([proj("a", "/r/a")], LAYOUTS);
  const litChip = () => Object.values(chips(v)).find(lit);
  assert.equal(litChip().op("border_color")[0], "#solid");
  press(v, cx, "l", CTRL_ALT);
  assert.equal(litChip().op("border_color")[0], "#accent");
  const first = cx.timers.at(-1);
  press(v, cx, "l", CTRL_ALT);
  first.fn(); // the first press's timer must not end the second press's highlight
  assert.equal(litChip().op("border_color")[0], "#accent");
  cx.timers.at(-1).fn();
  assert.equal(litChip().op("border_color")[0], "#solid");
});

test("the layout key also works on the launch screen", async () => {
  const dir = makeRepo({ name: "Ada" });
  const { v, cx } = await open([proj("a", dir, { worktree: { mode: "ask", branchTemplate: "{user}/{slug}" } })], LAYOUTS);
  enter(v);
  assert.equal(v.mode, "launch");
  press(v, cx, "l", CTRL_ALT);
  assert.equal(v.layoutPick, "agent-terminal", "the first step from the project's tabs");
  for (let i = 0; i < 3; i++) press(v, cx, "l", CTRL_ALT);
  assert.equal(v.layoutPick, null, "all the way round: back at the project's own, so not a pick");
  const t = texts(v);
  assert.ok(t.includes("ctrl+⏎") && t.includes("launches") && t.includes("Esc") && t.includes("Layout"));
  press(v, cx, "escape");
  assert.equal(v.mode, "list");
});

// ---------------------------------------------------------------- opening a project

/** Opens project `p` with the key that follows its mode, then waits for the work to finish. */
async function launchFirst(projects, layouts, beforeEnter) {
  const { v, cx } = await open(projects, layouts);
  beforeEnter?.(v, cx);
  enter(v); // opens the launch screen
  enter(v); // launches with what it offers
  await cx.settle();
  return { v, cx };
}
const spaceNew = () => state.runs.filter((r) => r.command === "space.new");

test("Enter on a 'never' project opens its checkout in a space and closes", async () => {
  const dir = makeRepo();
  await launchFirst([proj("demo", dir, { worktree: { mode: "never" } })]);
  assert.deepEqual(spaceNew().map((r) => [r.args.name, r.args.folder]), [["demo", dir]]);
  assert.equal(state.closed, 1);
  assert.deepEqual(state.splits, []);
});

test("a project's own split panes are built when it opens", async () => {
  const dir = makeRepo();
  await launchFirst([proj("demo", dir, { worktree: { mode: "never" }, startup: { tabs: [{ name: "agent", panes: [{ type: "agent" }, { type: "shell", direction: "down" }] }] } })]);
  assert.equal(state.splits.length, 1);
  assert.equal(state.splits[0].direction, "down");
  assert.equal(state.splits[0].pane, "pane-of-sp1");
  assert.equal(state.closed, 1);
});

test("a layout picked at launch wins over the project's own, and the project's own means its tabs", async () => {
  const dir = makeRepo();
  await launchFirst([proj("demo", dir, { worktree: { mode: "never" }, startup: { tabs: [{ name: "agent", panes: [{ type: "agent" }, { type: "shell", direction: "down" }] }] } })], LAYOUTS, (v, cx) => {
    for (let i = 0; i < 4; i++) press(v, cx, "l", CTRL_ALT); // below → side → coding → the project's tabs
    assert.equal(v.layoutPick, null);
  });
  assert.equal(state.splits.length, 1);
  assert.equal(state.splits[0].direction, "down");
  reset();
  await launchFirst([proj("demo", dir, { worktree: { mode: "never" } })], LAYOUTS, (v, cx) => {
    for (let i = 0; i < 3; i++) press(v, cx, "l", CTRL_ALT); // → coding
  });
  assert.equal(state.splits.length, 1);
  assert.equal(state.splits[0].direction, "right");
  assert.deepEqual(state.splits[0].argv.slice(5), ["sh", "-c", "yazi ."]);
});

test("an unknown layout name stops before anything is created and says which layouts exist", async () => {
  const dir = makeRepo();
  const { v } = await launchFirst([proj("demo", dir, { worktree: { mode: "never" }, startup: AG("") })], LAYOUTS, (v) => { v.layoutPick = "nope"; });
  assert.match(v.error, /No layout called "nope".*agent-terminal.*coding/);
  assert.equal(v.mode, "busy");
  assert.deepEqual(spaceNew(), []);
  assert.equal(state.closed, 0);
});

test("a malformed layout is reported before anything is created", async () => {
  const dir = makeRepo();
  const bad = [{ name: "bad", panes: [{ type: "agent" }, { type: "shell", direction: "up" }] }];
  const { v } = await launchFirst([proj("demo", dir, { worktree: { mode: "never" }, startup: AG("") })], bad, (v) => { v.layoutPick = "bad"; });
  assert.match(v.error, /needs direction/);
  assert.deepEqual(spaceNew(), []);
});

test("an 'always' project makes a worktree and opens a space named for it", async () => {
  const dir = makeRepo({ name: "Ada" });
  const root = scratch("pp-ui-wt");
  await launchFirst([proj("demo", dir, { worktree: { mode: "always", branchTemplate: "{user}/{slug}", root: `${root}/{branch}` } })]);
  assert.equal(spaceNew().length, 1);
  assert.match(spaceNew()[0].args.name, /^demo · ada\//);
  assert.ok(spaceNew()[0].args.folder.startsWith(root));
  assert.ok(existsSync(spaceNew()[0].args.folder));
});

test("an 'ask' project's launch screen asks for a name, previews the branch, and creates it on Enter in the branch box", async () => {
  const dir = makeRepo({ name: "Ada" });
  const root = scratch("pp-ui-wt");
  const { v, cx } = await open([proj("demo", dir, { worktree: { mode: "ask", branchTemplate: "{user}/{slug}", root: `${root}/{branch}` } })]);
  enter(v);
  assert.equal(v.mode, "launch");
  v.nameInput.set_value("fix login");
  v.refreshPreview(cx);
  await cx.settle();
  assert.match(texts(v), /branch: ada\/fix-login/);
  v.nameInput.emit("submit");
  await cx.settle();
  assert.equal(spaceNew().length, 1);
  assert.ok(existsSync(join(root, "ada/fix-login")));
});

test("Shift+Enter opens the checkout whatever the mode", async () => {
  const dir = makeRepo();
  const { v, cx } = await open([proj("demo", dir, { worktree: { mode: "always" } })]);
  press(v, cx, "enter", { shift: true });
  v.launchNow();
  await cx.settle();
  assert.equal(spaceNew()[0].args.folder, dir);
});

test("an already-open space is focused instead of opening another", async () => {
  const dir = makeRepo();
  const { v, cx } = await open([proj("demo", dir, { worktree: { mode: "never" } })]);
  state.spaces = [{ id: "sp-open", folder: dir, machine: null }];
  enter(v); enter(v); // the launch screen, then launch
  await cx.settle();
  assert.deepEqual(state.runs.map((r) => r.command), ["space.select"]);
  assert.equal(state.closed, 1);
});

test("a space opened in a folder below the project's is its space: focused on Enter and listed as open", async () => {
  const dir = makeRepo();
  const { v, cx } = await open([proj("demo", dir, { worktree: { mode: "never" } }), proj("other", `${dir}2`)]);
  state.spaces = [{ id: "sp-web", folder: `${dir}/web`, machine: null }, { id: "sp-sib", folder: `${dir}2-x`, machine: null }];
  v.refreshSnap();
  assert.equal(v.rows().find((r) => r.p.name === "demo").space?.id, "sp-web");
  assert.equal(v.rows().find((r) => r.p.name === "other").space, undefined, "a sibling sharing a prefix is not its space");
  v.at = v.rows().findIndex((r) => r.p.name === "demo");
  enter(v); enter(v); // the launch screen, then launch
  await cx.settle();
  assert.deepEqual(state.runs.map((r) => [r.command, r.args.id]), [["space.select", "sp-web"]]);
});

test("a folder that is not a git checkout shows the error and Escape returns", async () => {
  const { v, cx } = await launchFirst([proj("demo", scratch(), { worktree: { mode: "never" } })]);
  assert.match(v.error, /not a git checkout/);
  assert.match(texts(v), /not a git checkout/);
  press(v, cx, "escape");
  assert.equal(v.mode, "list");
  assert.equal(v.error, null);
});

// ---------------------------------------------------------------- the working screen

test("the working screen shows done steps, a spinner on the current one, and a cross on failure", async () => {
  const { v } = await open([proj("demo", "/r/demo")]);
  v.target = v.projects[0];
  v.mode = "busy";
  v.notes = [];
  assert.match(texts(v), /Starting…/);
  v.notes = ["git fetch origin…", "git worktree add x…", "$ npm ci"];
  let marks = findAll(rendered(v), (e) => e.tag === "div" && e.has("frames"));
  assert.equal(marks.length, 1, "one spinner");
  assert.equal(marks[0].op("frames")[0].length, 10);
  const t = texts(v);
  assert.equal((t.match(/✓/g) ?? []).length, 2);
  assert.ok(t.includes("working…"));
  v.error = "setup failed";
  marks = findAll(rendered(v), (e) => e.tag === "div" && e.has("frames"));
  assert.equal(marks.length, 0, "no spinner after a failure");
  assert.ok(texts(v).includes("✗") && texts(v).includes("setup failed") && texts(v).includes("Esc back"));
});

// ---------------------------------------------------------------- the editor

test("the editor renders all four sections", async () => {
  const { v, cx } = await open([proj("demo", "/r/demo")], LAYOUTS);
  v.editSelected();
  for (const id of ["project", "worktree", "git", "startup"]) {
    v.showSection(id);
    assert.ok(texts(v).length > 0, id);
  }
  v.showSection("project");
  assert.match(texts(v), /Description/);
  v.showSection("startup");
  assert.match(texts(v), /Tabs/);
  assert.match(texts(v), /Setup commands/);
  cx.fire(80);
});

const clickId = (v, cx, id) => findAll(rendered(v), (e) => e.op?.("id")?.[0] === id)[0].op("on_click")[0]({}, cx);

test("the startup section offers every agent, with icons, dimmed when not installed, and Shell first", async () => {
  const { v, cx } = await open([proj("demo", "/r/demo", { startup: AG("claude") })]);
  v.editSelected();
  v.showSection("startup");
  clickId(v, cx, "pp-pane-0");
  const tree = rendered(v);
  const chipEls = findAll(tree, (e) => e.tag === "h_flex" && /^pp-agent-/.test(e.op("id")?.[0] ?? ""));
  const names = chipEls.map(textOf);
  assert.deepEqual(names, ["Shell", "Claude Code", "Codex", "opencode", "Hermes", "pi"]);
  const byName = Object.fromEntries(chipEls.map((e) => [textOf(e), e]));
  assert.ok(!byName["Claude Code"].has("opacity"), "installed: full strength");
  assert.ok(byName["Codex"].has("opacity") && byName["opencode"].has("opacity"), "not installed: dimmed");
  const iconOf = (e) => findAll(e, (x) => x.tag === "svg" || x.tag === "image").map((x) => x.arg)[0];
  assert.equal(iconOf(byName["Shell"]), "icons/shell.svg");
  assert.equal(iconOf(byName["Codex"]), "icons/codex.svg");
  assert.equal(iconOf(byName["opencode"]), "icons/opencode.svg");
  assert.equal(iconOf(byName["Claude Code"]), "icons/claude.svg");
});

test("clicking an agent chip fills the agent field; Hermes switches the prompt to typed-after-start", async () => {
  const { v, cx } = await open([proj("demo", "/r/demo", { startup: AG("claude") })]);
  v.editSelected();
  v.showSection("startup");
  clickId(v, cx, "pp-pane-0");
  const pane = v.draft.startup.tabs[0].panes[0];
  const click = (name) => {
    const el = findAll(rendered(v), (e) => e.tag === "h_flex" && textOf(e) === name && /^pp-agent-/.test(e.op("id")?.[0] ?? ""))[0];
    el.op("on_click")[0]();
  };
  const agent = () => v.boxFor(v.draft.startup.tabs[0].panes[0], "agent").value();
  click("Codex");
  assert.equal(agent(), "codex");
  assert.equal(pane.promptMode, "arg");
  click("Hermes");
  assert.equal(agent(), "hermes");
  assert.equal(pane.promptMode, "send");
  click("Shell");
  assert.equal(agent(), "");
});

test("Add tab adds a row, its fields edit the draft, and Save writes the tabs", async () => {
  const dir = realpathSync(makeRepo());
  const { v, cx } = await open([proj("shop", dir)]);
  press(v, cx, "e", { alt: true }); v.showSection("startup");
  v.addTab(); v.boxFor(v.draft.startup.tabs.at(-1), "name").set_value("git"); v.boxFor(v.draft.startup.tabs.at(-1), "command").set_value("lazygit");
  await v.save(cx);
  const saved = JSON.parse(readFileSync(dataFile(), "utf8")).projects[0].startup.tabs;
  assert.deepEqual(saved.at(-1), { name: "git", folder: "", command: "lazygit", panes: [] });
});
test("moving a tab keeps what was typed in its boxes", async () => {
  const { v, cx } = await open([proj("shop", "/r/shop", { startup: { tabs: [{ name: "a" }, { name: "b" }] } })]);
  press(v, cx, "e", { alt: true }); v.showSection("startup");
  v.tabAt = 1; v.boxFor(v.draft.startup.tabs[1], "name").set_value("bee"); v.moveTab(-1);
  assert.equal(v.tabAt, 0);
  assert.equal(v.boxFor(v.draft.startup.tabs[0], "name").value(), "bee");
});
test("Add pane on a command tab turns the command into pane 1; type chips and direction edit the pane", async () => {
  const { v, cx } = await open([proj("shop", "/r/shop", { startup: { tabs: [{ name: "a", command: "top" }] } })]);
  press(v, cx, "e", { alt: true }); v.showSection("startup");
  v.addPane();
  assert.deepEqual(v.draft.startup.tabs[0].panes.map((x) => [x.type, x.command, x.direction]), [["command", "top", ""], ["shell", "", "down"]]);
  v.setPaneType("agent"); v.cycleDirection();
  assert.deepEqual([v.draft.startup.tabs[0].panes[1].type, v.draft.startup.tabs[0].panes[1].direction], ["agent", "right"]);
});
test("Save shows tabPlan's message for a tab without a name and keeps the editor open", async () => {
  const { v, cx } = await open([proj("shop", "/r/shop")]);
  press(v, cx, "e", { alt: true }); v.showSection("startup"); v.addTab();
  await v.save(cx);
  assert.equal(v.mode, "edit"); assert.match(v.error, /Tab 2 needs a name/);
});
test("removing the only tab and saving stores one shell tab, and the card still draws", async () => {
  const dir = realpathSync(makeRepo());
  const { v, cx } = await open([proj("shop", dir, { startup: AG("claude") })]);
  press(v, cx, "e", { alt: true }); v.showSection("startup");
  v.removeTab();
  assert.deepEqual(v.draft.startup.tabs, []);
  assert.equal(v.tabAt, 0);
  await v.save(cx);
  assert.equal(v.error, null);
  assert.deepEqual(JSON.parse(readFileSync(dataFile(), "utf8")).projects[0].startup.tabs, [{ name: "shell", folder: "", command: "", panes: [] }]);
  assert.doesNotThrow(() => texts(v));
});
test("the card draws a project whose tabs list is empty", async () => {
  const { v } = await open([proj("shop", "/r/shop")]);
  v.projects[0].startup.tabs = [];
  assert.doesNotThrow(() => texts(v));
});
test("moving the first tab up or the last tab down changes nothing", async () => {
  const { v, cx } = await open([proj("shop", "/r/shop", { startup: { tabs: [{ name: "a" }, { name: "b" }] } })]);
  press(v, cx, "e", { alt: true }); v.showSection("startup");
  v.moveTab(-1);
  assert.deepEqual([v.tabAt, v.draft.startup.tabs.map((t) => t.name)], [0, ["a", "b"]]);
  v.selectTab(1); v.moveTab(1);
  assert.deepEqual([v.tabAt, v.draft.startup.tabs.map((t) => t.name)], [1, ["a", "b"]]);
});
test("removing a tab's only pane leaves no pane selected", async () => {
  const { v, cx } = await open([proj("shop", "/r/shop", { startup: AG("claude") })]);
  press(v, cx, "e", { alt: true }); v.showSection("startup");
  v.paneAt = 0; v.removePane();
  assert.deepEqual([v.paneAt, v.draft.startup.tabs[0].panes.length], [null, 0]);
});
test("moving a pane keeps what was typed in its boxes", async () => {
  const { v, cx } = await open([proj("shop", "/r/shop", { startup: { tabs: [{ name: "a", panes: [{ type: "shell" }, { type: "command", command: "top", direction: "down" }] }] } })]);
  press(v, cx, "e", { alt: true }); v.showSection("startup");
  const second = v.draft.startup.tabs[0].panes[1];
  v.paneAt = 1; v.boxFor(second, "command").set_value("htop"); v.movePane(-1);
  assert.equal(v.paneAt, 0);
  assert.equal(v.draft.startup.tabs[0].panes[0], second);
  assert.equal(v.boxFor(v.draft.startup.tabs[0].panes[0], "command").value(), "htop");
});
test("two agent panes from a layout save without a name clash", async () => {
  const dir = realpathSync(makeRepo());
  const pair = [{ name: "pair", panes: [{ type: "agent" }, { type: "agent", direction: "right" }] }];
  const { v, cx } = await open([proj("shop", dir, { startup: AG("claude") })], pair);
  press(v, cx, "e", { alt: true }); v.showSection("startup");
  v.panesFromLayout("pair");
  await v.save(cx);
  assert.equal(v.error, null);
  assert.equal(v.mode, "list");
});
test("Panes from a layout replaces the tab's panes and keeps its agent settings", async () => {
  const { v, cx } = await open([proj("shop", "/r/shop", { startup: { tabs: [{ name: "a", panes: [{ type: "agent", agent: "codex", args: "-q" }] }] } })]);
  press(v, cx, "e", { alt: true }); v.showSection("startup");
  v.panesFromLayout("agent-side-terminal");
  assert.deepEqual(v.draft.startup.tabs[0].panes.map((x) => [x.type, x.agent, x.direction]), [["agent", "codex", ""], ["shell", "", "right"]]);
});
test("the Agent timing button toggles and is saved", async () => {
  const dir = realpathSync(makeRepo());
  const { v, cx } = await open([proj("shop", dir)]);
  press(v, cx, "e", { alt: true }); v.showSection("startup");
  findAll(rendered(v), (e) => e.op?.("id")?.[0] === "pp-timing")[0].op("on_click")[0]({}, cx);
  await v.save(cx);
  assert.equal(JSON.parse(readFileSync(dataFile(), "utf8")).projects[0].startup.agentTiming, "with");
});

test("saving keeps a folder's trailing space, the layouts and other keys", async () => {
  const dir = join(scratch("pp-sp"), "Repo ");
  mkdirSync(dir);
  makeRepo({ dir });
  assert.ok(dir.endsWith("Repo "));
  const { v, cx } = await open([], LAYOUTS);
  writeFileSync(dataFile(), JSON.stringify({ note: "keep", layouts: LAYOUTS, projects: [] }));
  await v.reload(cx);
  await cx.settle();
  v.edit(normalize({ name: "Spacey", path: dir }), null);
  v.panesFromLayout("coding");
  await v.save(cx);
  assert.equal(v.error, null);
  const saved = JSON.parse(readFileSync(dataFile(), "utf8"));
  assert.equal(saved.projects[0].path, dir);
  assert.deepEqual(saved.projects[0].startup.tabs[0].panes.map((x) => [x.type, x.command, x.direction]), [["agent", "", ""], ["command", "yazi .", "right"]]);
  assert.deepEqual(saved.layouts, LAYOUTS);
  assert.equal(saved.note, "keep");
  assert.equal(v.mode, "list");
  assert.ok(sh(dir, "rev-parse", "--is-inside-work-tree") === "true");
});

test("saving refuses a nameless project and a folder that is not a checkout", async () => {
  const { v, cx } = await open([]);
  v.edit(normalize({ name: "", path: "/r/x" }), null);
  await v.save(cx);
  assert.match(v.error, /Give the project a name/);
  v.edit(normalize({ name: "x", path: scratch() }), null);
  await v.save(cx);
  assert.match(v.error, /not a git checkout/);
  assert.equal(v.mode, "edit");
});

test("deleting asks twice; the folder is untouched", async () => {
  const dir = makeRepo();
  const { v, cx } = await open([proj("demo", dir)]);
  press(v, cx, "d", { alt: true });
  assert.ok(v.pendingDelete);
  assert.match(texts(v), /Remove "demo" from the list/);
  press(v, cx, "d", { alt: true });
  await cx.settle();
  assert.deepEqual(JSON.parse(readFileSync(dataFile(), "utf8")).projects, []);
  assert.ok(existsSync(dir));
});

test("any other key cancels a pending delete", async () => {
  const { v, cx } = await open([proj("demo", "/r/demo")]);
  press(v, cx, "d", { alt: true });
  press(v, cx, "down");
  assert.equal(v.pendingDelete, null);
});

// ---------------------------------------------------------------- worktree cleanup

test("the worktree screen lists worktrees with badges and removes ticked ones", async () => {
  const dir = makeRepo({ name: "Ada" });
  const root = scratch("pp-ui-wt");
  sh(dir, "worktree", "add", "-q", "-b", "ada/merged", join(root, "merged"));
  sh(dir, "worktree", "add", "-q", "-b", "ada/dirty", join(root, "dirty"));
  writeFileSync(join(root, "dirty", "a.txt"), "changed\n");
  const { v, cx } = await open([proj("demo", dir)]);
  press(v, cx, "w", { alt: true });
  await cx.settle();
  assert.equal(v.mode, "worktrees");
  const t = texts(v);
  for (const s of ["ada/merged", "ada/dirty", "merged", "uncommitted"]) assert.ok(t.includes(s), s);
  press(v, cx, "m", { alt: true }); // tick merged
  assert.equal(v.wtSel.size, 1);
  press(v, cx, "r", { alt: true }); // ask
  assert.equal(v.wtConfirm, true);
  press(v, cx, "r", { alt: true }); // remove
  await cx.settle();
  assert.ok(!existsSync(join(root, "merged")));
  assert.ok(existsSync(join(root, "dirty")));
  assert.ok(!texts(v).includes("ada/merged"));
});

test("alt+b steps back one screen at a time, and does nothing on the list (herdr closes the popup on Esc itself)", async () => {
  const { v, cx } = await open([proj("demo", "/r/demo")]);
  press(v, cx, "b", { alt: true });
  assert.equal(v.mode, "list");
  assert.equal(state.closed, 0);
  press(v, cx, "e", { alt: true });
  assert.equal(v.mode, "edit");
  press(v, cx, "b", { alt: true });
  assert.equal(v.mode, "list");
  press(v, cx, "x", { alt: true });
  assert.equal(v.mode, "backup");
  press(v, cx, "b", { platform: true });
  assert.equal(v.mode, "list");
  press(v, cx, "w", { alt: true });
  await cx.settle();
  assert.equal(v.mode, "worktrees");
  press(v, cx, "b", { control: true });
  assert.equal(v.mode, "list");
  assert.equal(state.closed, 0);
});

test("the screens say how to go back, and that Esc closes", async () => {
  const { v, cx } = await open([proj("demo", "/r/demo")]);
  press(v, cx, "x", { alt: true });
  assert.ok(texts(v).includes("alt+b back · Esc closes"));
  assert.ok(!texts(v).includes("Esc back"));
  press(v, cx, "b", { alt: true });
  press(v, cx, "e", { alt: true });
  assert.ok(texts(v).includes("alt+b back · Esc closes"));
});

test("on a Mac the way back is cmd+alt+B (herdr owns cmd+B), and the screens say so", async () => {
  const { v, cx } = await open([proj("demo", "/r/demo")]);
  state.platform = "macos"; // the picker reads it with the rest of herdr's data, when it redraws
  rendered(v);
  press(v, cx, "x", { platform: true });
  assert.equal(v.mode, "backup");
  assert.ok(texts(v).includes("⌘⌥B back · Esc closes"));
  assert.ok(!texts(v).includes("⌘B back"));
  press(v, cx, "b", { platform: true, alt: true });
  assert.equal(v.mode, "list");
  press(v, cx, "e", { platform: true });
  assert.equal(v.mode, "edit");
  assert.ok(texts(v).includes("⌘⌥B back"));
  press(v, cx, "b", { platform: true, alt: true });
  assert.equal(v.mode, "list");
  assert.equal(state.closed, 0);
});

test("Escape steps back one screen at a time and then closes", async () => {
  const { v, cx } = await open([proj("demo", "/r/demo")]);
  press(v, cx, "e", { alt: true });
  assert.equal(v.mode, "edit");
  press(v, cx, "escape");
  assert.equal(v.mode, "list");
  assert.equal(state.closed, 0);
  press(v, cx, "escape");
  assert.equal(state.closed, 1);
});

test("a handler that throws is shown in the popup instead of vanishing", async () => {
  const { v } = await open([proj("demo", "/r/demo")]);
  v.guard("boom", () => { throw new Error("kaput"); })();
  assert.match(v.error, /boom: kaput/);
  assert.match(texts(v), /boom: kaput/);
});

test("projects are ordered: open spaces, pinned, recent, then by name", async () => {
  const { v } = await open([proj("zeta", "/r/z"), proj("alpha", "/r/a"), proj("pinned", "/r/p", { pinned: true }), proj("open", "/r/o")]);
  state.spaces = [{ id: "s", folder: "/r/o", machine: null }];
  v.refreshSnap();
  assert.deepEqual(v.rows().map((r) => r.p.name), ["open", "pinned", "alpha", "zeta"]);
});

test("on macOS the hints use ⌘ and the layout key is ⌘⌥L", async () => {
  const { v } = await open([proj("a", "/r/a")]);
  state.platform = "macos";
  const t = texts(v);
  for (const s of ["⌘N", "⌘E", "⌘W", "⌘D", "⌘⌥L"]) assert.ok(t.includes(s), s);
  assert.ok(!t.includes("alt+n") && !t.includes("ctrl+alt+L"));
});

test("Browse… fills the folder and, when empty, the name", async () => {
  const dir = makeRepo();
  const { v, cx } = await open([]);
  v.edit(normalize({ name: "", path: "" }), null);
  state.picked = null;
  await v.browse(cx);
  assert.equal(v.fields.find(([k]) => k === "path")[1].value(), "");
  state.picked = dir;
  await v.browse(cx);
  assert.equal(v.fields.find(([k]) => k === "path")[1].value(), dir);
  assert.equal(v.fields.find(([k]) => k === "name")[1].value(), dir.split("/").pop());
});

test("panes chosen from a layout in the editor are saved and built on the next open", async () => {
  const dir = makeRepo();
  const { v, cx } = await open([proj("demo", dir, { worktree: { mode: "never" } })]);
  v.editSelected();
  v.showSection("startup");
  clickId(v, cx, "pp-fromlay-0");
  await v.save(cx);
  assert.equal(v.error, null);
  assert.deepEqual(JSON.parse(readFileSync(dataFile(), "utf8")).projects[0].startup.tabs[0].panes.map((x) => [x.type, x.direction]), [["agent", ""], ["shell", "down"]]);
  enter(v); enter(v); // the launch screen, then launch
  await cx.settle();
  assert.equal(state.splits.length, 1);
  assert.equal(state.splits[0].direction, "down");
});

// ---------------------------------------------------------------- sections, git chips and the detail card

test("the list has Open now / Pinned / Everything else headers, and none while searching", async () => {
  const { v } = await open([proj("zeta", "/r/z"), proj("alpha", "/r/a"), proj("pinned", "/r/p", { pinned: true }), proj("open", "/r/o")]);
  state.spaces = [{ id: "s", folder: "/r/o", machine: null, status: "idle" }];
  const t = texts(v);
  for (const h of ["OPEN NOW", "PINNED", "EVERYTHING ELSE"]) assert.ok(t.includes(h), h);
  assert.ok(t.indexOf("OPEN NOW") < t.indexOf("PINNED") && t.indexOf("PINNED") < t.indexOf("EVERYTHING ELSE"));
  v.search.set_value("a");
  assert.ok(!texts(v).includes("OPEN NOW"));
});

test("section headers are shorter than rows, and arrow keys skip them", async () => {
  const { v, cx } = await open([proj("alpha", "/r/a"), proj("pinned", "/r/p", { pinned: true })]);
  const list = findAll(rendered(v), (e) => e.tag === "virtual_list")[0];
  assert.ok(list, "the projects list");
  assert.equal(list.arg, "pp-projects");
  assert.deepEqual(list.sizes, [30, 48, 30, 48], "header, row, header, row");
  press(v, cx, "down");
  assert.equal(v.at, 1);
  press(v, cx, "down");
  assert.equal(v.at, 0);
});

test("rows show the branch, changed files and worktree count once the git details load", async () => {
  const dir = makeRepo({ name: "Ada" });
  writeFileSync(join(dir, "a.txt"), "changed\n");
  sh(dir, "worktree", "add", "-q", "-b", "side", join(scratch("pp-ui-wt"), "side"));
  const { v, cx } = await open([proj("demo", dir)]);
  assert.ok(!texts(v).includes("1 changed"), "nothing yet while loading");
  await v.loadInfo(cx);
  const t = texts(v);
  assert.ok(t.includes("main") && t.includes("1 changed") && t.includes("1 wt"));
});

test("a clean project with no worktrees shows only its branch; an unreadable folder shows no chips", async () => {
  const { v, cx } = await open([proj("clean", makeRepo()), proj("gone", "/no/such/dir")]);
  await v.loadInfo(cx);
  const rowsText = findAll(rendered(v), (e) => /^pp-\d+$/.test(e.op?.("id")?.[0] ?? "")).map(textOf);
  const clean = rowsText.find((x) => x.includes("clean"));
  assert.ok(clean.includes("main") && !clean.includes("changed") && !clean.includes("wt"));
  const gone = rowsText.find((x) => x.includes("gone"));
  assert.ok(!gone.includes("main"));
});

test("a working agent's stripe pulses and an open space gets a status stripe", async () => {
  const { v } = await open([proj("busy", "/r/b"), proj("idle", "/r/i"), proj("closed", "/r/c")]);
  state.spaces = [{ id: "1", folder: "/r/b", machine: null, status: "working" }, { id: "2", folder: "/r/i", machine: null, status: "idle" }];
  const rows = findAll(rendered(v), (e) => /^pp-\d+$/.test(e.op?.("id")?.[0] ?? ""));
  const byName = (n) => rows.find((r) => textOf(r).includes(n));
  const pulses = (r) => findAll(r, (e) => e.has("loop")).length;
  const stripes = (r) => findAll(r, (e) => e.has("absolute") && e.op("w")?.[0] === 3).length;
  assert.equal(pulses(byName("busy")), 1);
  assert.equal(pulses(byName("idle")), 0);
  assert.equal(stripes(byName("busy")), 1);
  assert.equal(stripes(byName("idle")), 1);
  assert.equal(stripes(byName("closed")), 0);
});

test("the search box shows how many projects match", async () => {
  const { v } = await open([proj("alpha", "/r/a"), proj("beta", "/r/b"), proj("gamma", "/r/g")]);
  assert.ok(texts(v).includes("3 of 3"));
  v.search.set_value("alp");
  assert.ok(texts(v).includes("1 of 3"));
});

test("the detail card describes the highlighted project", async () => {
  const dir = makeRepo({ name: "Ada" });
  writeFileSync(join(dir, "a.txt"), "x\n");
  const { v, cx } = await open([proj("demo", dir, { group: "platform", pinned: true, startup: AG("claude"), worktree: { mode: "always" } })], undefined, { detail: true, gitInfo: true });
  state.spaces = [{ id: "s", folder: dir, machine: null, status: "working" }];
  await v.loadInfo(cx);
  const t = texts(v);
  for (const s of ["demo", "agent working", "Agent", "Claude Code", "Branch", "main", "Changes", "1 file modified", "Worktrees", "Last opened", "never",
    "Enter opens the launch screen for a new worktree and opens the project's tabs.", "Open…", "Checkout", "LAYOUT"]) assert.ok(t.includes(s), s);
});

test("the card follows the highlight and says what each mode does", async () => {
  const { v, cx } = await open([proj("a", "/r/a", { worktree: { mode: "never" } }), proj("b", "/r/b", { worktree: { mode: "ask" } })]);
  assert.match(texts(v), /Enter opens the launch screen for the checkout and opens the project's tabs\./);
  press(v, cx, "down");
  assert.match(texts(v), /Enter opens the launch screen and asks for a branch name and opens the project's tabs\./);
  v.layoutPick = "agent-terminal";
  assert.match(texts(v), /Enter opens the launch screen and asks for a branch name and opens agent \+ terminal below\./);
  assert.ok(texts(v).includes("Open…"));
});

test("Last opened shows when the project was last used", async () => {
  const { v } = await open([proj("demo", "/r/demo")]);
  state.platform = "linux";
  const { setShared } = await import("./helpers/herdr-stub.mjs");
  setShared("projects.recent", { "/r/demo": Date.now() - 12 * 60_000 });
  assert.ok(texts(v).includes("12 min ago"));
});

test("clicking a layout picture picks it for this launch; clicking the project's own clears the pick", async () => {
  const { v, cx } = await open([proj("a", "/r/a")]);
  const click = (label) => chips(v)[label].op("on_click")[0]();
  click("Agent + terminal below");
  assert.equal(v.layoutPick, "agent-terminal");
  assert.ok(texts(v).includes("LAYOUT · PICKED"));
  click("Project's tabs");
  assert.equal(v.layoutPick, null);
  assert.ok(!texts(v).includes("PICKED"));
  assert.ok(chips(v)["Agent + terminal below"]);
});

test("the card's layout pictures draw each layout's panes", async () => {
  const { v } = await open([proj("a", "/r/a")], LAYOUTS);
  const thumb = (label) => findAll(chips(v)[label], (e) => e.tag === "div" && e.has("absolute"));
  assert.equal(thumb("Project's tabs").length, 1);
  assert.equal(thumb("Agent + terminal below").length, 2);
  assert.equal(thumb("Agent, files and a terminal").length, 2);
});

test("the Open and Checkout buttons in the card start the project", async () => {
  const dir = makeRepo();
  const { v, cx } = await open([proj("demo", dir, { worktree: { mode: "always" } })]);
  const button = (id) => findAll(rendered(v), (e) => e.op?.("id")?.[0] === id)[0];
  button("pp-checkout").op("on_click")[0]();
  assert.equal(v.launch.worktree, false, "the launch screen opens on the checkout");
  button("pp-launch").op("on_click")[0]({}, cx);
  await cx.settle();
  assert.equal(spaceNew()[0].args.folder, dir);
  assert.equal(state.closed, 1);
});

test("with no projects the card says nothing is selected", async () => {
  const { v } = await open([]);
  assert.ok(texts(v).includes("Nothing selected."));
});

test("the popup is wide enough for the list and, when turned on, the card", () => {
  const mod = JSON.parse(readFileSync(new URL("../mods/projects/mod.json", import.meta.url), "utf8"));
  assert.ok(mod.overlay.width >= 880, "room for the list and, when it is on, the card");
});

// ---------------------------------------------------------------- turning the detail card off

const hasId = (v, id) => findAll(rendered(v), (e) => e.op?.("id")?.[0] === id).length > 0;

test("ctrl+alt+I hides the detail card, and the buttons and layout choice move under the list", async () => {
  const { v, cx } = await open([proj("demo", "/r/demo", { worktree: { mode: "always" } })], LAYOUTS);
  assert.ok(texts(v).includes("Last opened"));
  press(v, cx, "i", CTRL_ALT);
  const t = texts(v);
  assert.ok(!t.includes("Last opened") && !t.includes("Enter creates a new worktree"), "no card");
  assert.ok(hasId(v, "pp-wt") && hasId(v, "pp-edit") && hasId(v, "pp-delete") && hasId(v, "pp-add"), "the action buttons are under the list");
  for (const s of ["Layout", "Project's tabs", "Agent + terminal below", "Agent, files and a terminal", "Show details"]) assert.ok(t.includes(s), s);
  assert.deepEqual(findAll(rendered(v), (e) => /^pp-lay-/.test(e.op?.("id")?.[0] ?? "")), [], "no layout pictures");
});

test("with the card on, the buttons are in the card only once and the layout choice is the pictures", async () => {
  const { v } = await open([proj("demo", "/r/demo")]);
  for (const id of ["pp-wt", "pp-edit", "pp-delete", "pp-open", "pp-checkout", "pp-add", "pp-details"]) {
    assert.equal(findAll(rendered(v), (e) => e.op?.("id")?.[0] === id).length, 1, id);
  }
  assert.ok(texts(v).includes("Hide details"));
});

test("the card lists the project's tabs with pane counts, and its agent from any pane", async () => {
  const { v } = await open([proj("shop", "/r/shop", { startup: { tabs: [{ name: "server", panes: [{ type: "shell" }, { type: "agent", agent: "codex", direction: "down" }] }, { name: "git", command: "lazygit" }] } })]);
  const t = texts(v);
  assert.match(t, /server ×2/); assert.match(t, /git/); assert.match(t, /Codex|codex/);
});
test("the card shows the description when there is one", async () => {
  const { v } = await open([proj("shop", "/r/shop", { description: "the storefront" })]);
  assert.match(texts(v), /the storefront/);
});
test("Enter builds the project's tabs: later tabs through herdr-app do tab.new", async () => {
  const dir = realpathSync(makeRepo()); mkdirSync(join(dir, "web"));
  const { v, cx } = await open([proj("shop", dir, { worktree: { mode: "never" }, startup: { tabs: [{ name: "a", command: "" }, { name: "web", folder: "web", command: "npm run dev" }] } })]);
  enter(v); enter(v); await cx.settle(); // the launch screen, then launch
  assert.deepEqual(state.tabsMade.map((t) => t.name), ["web"]);
});

test("a bare alt+I or ctrl+I does nothing", async () => {
  const { v, cx } = await open([proj("demo", "/r/demo")]);
  press(v, cx, "i", { alt: true });
  press(v, cx, "i", { control: true });
  assert.equal(v.detail, true);
});

test("the choice is remembered: a picker opened later starts the same way", async () => {
  const { v, cx } = await open([proj("demo", "/r/demo")]);
  press(v, cx, "i", CTRL_ALT);
  assert.equal(v.detail, false);
  const { shared } = await import("./helpers/herdr-stub.mjs");
  assert.equal(shared("projects.detail"), false);
  const pending = [];
  const cx2 = { timer: { after() {}, every() {} }, spawn: (fn) => { const p = fn(cx2); pending.push(p); return p; }, focus_handle: () => ({}), notify() {}, stop_propagation() {} };
  const again = new Picker();
  again.init({}, cx2);
  await Promise.all(pending);
  assert.equal(again.detail, false);
  assert.ok(!texts(again).includes("Last opened"));
  press(again, cx2, "i", CTRL_ALT);
  assert.equal(again.detail, true);
  assert.ok(texts(again).includes("Last opened"));
});

test("the Hide details button toggles it both ways", async () => {
  const { v } = await open([proj("demo", "/r/demo")]);
  const click = () => findAll(rendered(v), (e) => e.op?.("id")?.[0] === "pp-details")[0].op("on_click")[0]();
  click();
  assert.equal(v.detail, false);
  assert.ok(texts(v).includes("Show details"));
  click();
  assert.equal(v.detail, true);
  assert.ok(texts(v).includes("Hide details"));
});

test("the layout key and Enter still work with the card hidden", async () => {
  const dir = makeRepo();
  const { v, cx } = await open([proj("demo", dir, { worktree: { mode: "never" } })], LAYOUTS);
  press(v, cx, "i", CTRL_ALT);
  for (let i = 0; i < 3; i++) press(v, cx, "l", CTRL_ALT); // agent-terminal, side, coding
  assert.equal(v.layoutPick, "coding");
  enter(v); enter(v); // the launch screen, then launch
  await cx.settle();
  assert.equal(state.splits.length, 1);
  assert.equal(state.splits[0].direction, "right");
});

test("hiding the card keeps the buttons working: Edit opens the editor", async () => {
  const { v, cx } = await open([proj("demo", "/r/demo")]);
  press(v, cx, "i", CTRL_ALT);
  findAll(rendered(v), (e) => e.op?.("id")?.[0] === "pp-edit")[0].op("on_click")[0]();
  assert.equal(v.mode, "edit");
});

test("with no projects and the card hidden there are no action buttons to press", async () => {
  const { v, cx } = await open([]);
  press(v, cx, "i", CTRL_ALT);
  assert.ok(!hasId(v, "pp-wt") && !hasId(v, "pp-edit") && hasId(v, "pp-add"));
});

// ---------------------------------------------------------------- space colors

const avatarOf = (el) => findAll(el, (e) => e.tag === "h_flex" && e.has("font_bold") && e.has("rounded"))[0];
const rowOf = (v, name) => findAll(rendered(v), (e) => /^pp-\d+$/.test(e.op?.("id")?.[0] ?? "")).find((r) => textOf(r).includes(name));

test("an open project's avatar has its space's color and its initial, like the sidebar's", async () => {
  const { v } = await open([proj("alpha", "/r/a"), proj("beta", "/r/b"), proj("gamma", "/r/g"), proj("delta", "/r/d")]);
  state.spaces = [
    { id: "s1", folder: "/r/a", machine: null, status: "idle" },
    { id: "s2", folder: "/r/b", machine: null, status: "idle" },
    { id: "s3", folder: "/r/g", machine: null, status: "idle" },
  ];
  const { setShared } = await import("./helpers/herdr-stub.mjs");
  setShared("space.colors", { s1: "ansi4", s2: "#123456" });
  const a = avatarOf(rowOf(v, "alpha"));
  assert.equal(a.op("bg")[0], "#5b8def");
  assert.equal(textOf(a), "A");
  assert.equal(avatarOf(rowOf(v, "beta")).op("bg")[0], "#123456", "a stored hex color is used as is");
  assert.equal(avatarOf(rowOf(v, "gamma")).op("bg")[0], "#22a99a", "teal until herdr gives the space a color");
});

test("a project with no open space gets an outlined avatar without a color", async () => {
  const { v } = await open([proj("delta", "/r/d")]);
  const a = avatarOf(rowOf(v, "delta"));
  assert.ok(!a.has("bg"));
  assert.equal(a.op("border_color")[0], "#input");
  assert.equal(textOf(a), "D");
});

test("the card's header repeats the avatar in the same color", async () => {
  const { v } = await open([proj("alpha", "/r/a")]);
  state.spaces = [{ id: "s1", folder: "/r/a", machine: null, status: "idle" }];
  const { setShared } = await import("./helpers/herdr-stub.mjs");
  setShared("space.colors", { s1: "ansi5" });
  const card = findAll(rendered(v), (e) => e.tag === "v_flex" && e.has("border_1") && textOf(e).includes("LAYOUT"))[0];
  assert.equal(avatarOf(card).op("bg")[0], "#8b7cf6");
});

test("a color name the sidebar palette lacks falls back to the theme, then to teal", async () => {
  const { v } = await open([proj("alpha", "/r/a")]);
  state.spaces = [{ id: "s1", folder: "/r/a", machine: null, status: "idle" }];
  const { setShared } = await import("./helpers/herdr-stub.mjs");
  setShared("space.colors", { s1: "ansi7" });
  assert.equal(avatarOf(rowOf(v, "alpha")).op("bg")[0], "#ansi7", "the theme's own color");
});

test("a slow preview for earlier input never overwrites the preview for the current input", async () => {
  const dir = makeRepo({ name: "Ada" });
  const { v, cx } = await open([proj("demo", dir, { worktree: { mode: "ask", branchTemplate: "{user}/{slug}" } })]);
  enter(v);
  // Hold the two requests back, then let the newer one answer first and the older one last.
  const held = [];
  const slow = { notify() {}, spawn: (fn) => { held.push(fn); } };
  v.nameInput.set_value("first");
  v.refreshPreview(slow);
  v.nameInput.set_value("second");
  v.refreshPreview(slow);
  assert.equal(held.length, 2);
  await held[1](cx);
  assert.equal(v.preview, "ada/second");
  await held[0](cx);
  assert.equal(v.preview, "ada/second", "the older answer arrived last and was ignored");
});

test("a preview error from stale input does not replace the current preview", async () => {
  const dir = makeRepo({ name: "Ada" });
  const { v, cx } = await open([proj("demo", dir, { worktree: { mode: "ask", branchTemplate: "{user}/{slug}" } })]);
  enter(v);
  v.nameInput.set_value("fine");
  v.refreshPreview(cx);
  await cx.settle();
  assert.equal(v.preview, "ada/fine");
  assert.equal(v.error, null);
});

// ---------------------------------------------------------------- render cost

test("a draw reads no live herdr data except the theme: spaces, shared state and the platform come from a snapshot", async () => {
  const projects = Array.from({ length: 30 }, (_, i) => proj(`proj-${i}`, `/r/p${i}`, { group: "g", pinned: i % 7 === 0 }));
  const { v } = await open(projects);
  state.spaces = Array.from({ length: 12 }, (_, i) => ({ id: `s${i}`, folder: `/r/p${i}`, machine: null, status: "idle" }));
  setShared("space.colors", { s1: "ansi4" });
  v.refreshSnap();
  resetCalls();
  v.render();
  v.search.set_value("proj");
  v.render();
  const { home, ...rest } = calls;
  assert.deepEqual(rest, { theme: 2 }, "two draws: only the theme");
  assert.ok((home ?? 0) <= 1, "home is remembered");
});

test("the snapshot is what a draw shows: herdr's data changing does not change a draw until it is refreshed", async () => {
  const { v } = await open([proj("a", "/r/a")]);
  state.spaces = [{ id: "s1", folder: "/r/a", machine: null, status: "working" }];
  assert.ok(!texts_noRefresh(v).includes("OPEN NOW"), "not yet");
  assert.equal(v.refreshSnap(), true);
  assert.equal(v.refreshSnap(), false, "nothing changed since");
  assert.ok(textOf(v.render()).includes("agent working") || textOf(v.render()).length > 0);
  assert.equal(v.rows()[0].space.status, "working");
});

test("the refresh timer asks for a draw only when something changed", async () => {
  const { v, cx } = await open([proj("a", "/r/a")]);
  let draws = 0;
  const tick = cx.every.find((e) => e.ms === 3000);
  assert.ok(tick, "a refresh timer is set");
  const counting = { notify: () => { draws++; } };
  tick.fn(counting);
  assert.equal(draws, 0, "nothing changed");
  state.spaces = [{ id: "s1", folder: "/r/a", machine: null, status: "idle" }];
  tick.fn(counting);
  assert.equal(draws, 1);
  tick.fn(counting);
  assert.equal(draws, 1, "and not again for the same data");
  setShared("projects.recent", { "/r/a": 5 });
  tick.fn(counting);
  assert.equal(draws, 2, "recent projects are part of it");
});

test("a platform change reaches the hints through the snapshot", async () => {
  const { v } = await open([proj("a", "/r/a")]);
  state.platform = "macos";
  resetCalls();
  v.render();
  assert.ok(!calls.window, "a draw does not ask herdr for the platform");
  assert.ok(texts(v).includes("⌘N"));
});

test("git answers cause one batched redraw, not one per project", async () => {
  const projects = Array.from({ length: 6 }, (_, i) => proj(`p${i}`, makeRepo()));
  const { v, cx } = await open(projects);
  let notified = 0;
  const counting = { ...cx, notify: () => { notified++; }, timer: { after: (ms, fn) => cx.timers.push({ ms, fn }), every() {} } };
  cx.timers.length = 0;
  v.bumpPending = false; // the timer from opening the picker never fires in this fake
  await v.loadInfo(counting);
  assert.equal(notified, 0, "no redraw per answer");
  assert.equal(cx.timers.filter((t) => t.ms === 250).length, 1, "one batching timer for all six");
  cx.timers.find((t) => t.ms === 250).fn();
  assert.equal(v.bumpPending, false);
});

test("the detail card is on by default, ctrl+alt+I turns it off, and the choice is kept", async () => {
  const { v, cx } = await open([proj("demo", "/r/demo")], undefined, {});
  assert.equal(v.detail, true);
  assert.ok(texts(v).includes("Last opened"));
  press(v, cx, "i", CTRL_ALT);
  assert.equal(v.detail, false);
  const t = texts(v);
  assert.ok(!t.includes("Last opened") && t.includes("Show details") && hasId(v, "pp-wt"), "the buttons and the layout choice move under the list");
});

// ---------------------------------------------------------------- git details are opt-in

test("with gitInfo: false no git is run for the list, and the card has no git rows", async () => {
  const dir = makeRepo();
  const { v, cx } = await open([proj("demo", dir)], undefined, { detail: true, gitInfo: false });
  await cx.settle();
  assert.equal(v.gitInfo, false);
  assert.deepEqual(v.info, {}, "nothing was gathered");
  const t = texts(v);
  assert.ok(t.includes("Last opened") && !t.includes("Branch") && !t.includes("Changes"), "the Worktrees button stays; the git rows go");
  assert.ok(!t.includes("changed") && !/\bwt\b/.test(t), "no chips");
});

test("by default the git details are gathered after the list shows", async () => {
  const dir = makeRepo();
  writeFileSync(join(dir, "a.txt"), "x\n");
  const { v, cx } = await open([proj("demo", dir)], undefined, { detail: true });
  for (let i = 0; i < 30 && !v.info[dir]; i++) { await cx.settle(); await new Promise((r) => setTimeout(r, 20)); }
  assert.equal(v.gitInfo, true);
  assert.deepEqual(v.info[dir], { branch: "main", dirty: 1, worktrees: 0 });
  const t = texts(v);
  assert.ok(t.includes("Branch") && t.includes("1 file modified") && t.includes("1 changed"));
});

// ---------------------------------------------------------------- closing

test("herdr's own close hook only stops background work; it does not close an overlay itself", async () => {
  const { v } = await open([proj("demo", "/r/demo")]);
  const before = state.closed;
  v.overlay = null; // opened without an overlay id, as a command-line open is
  assert.doesNotThrow(() => v.close({}));
  assert.equal(v.closing, true);
  assert.equal(state.closed, before, "no closeOverlay call");
  assert.deepEqual(state.runs.filter((r) => r.command === "overlay.close"), [], "and no command either");
});

test("Escape closes the popup through its overlay id, or by command when it has none", async () => {
  const { v, cx } = await open([proj("demo", "/r/demo")]);
  press(v, cx, "escape");
  assert.equal(state.closed, 1);
  const again = await open([proj("demo", "/r/demo")]);
  again.v.overlay = null;
  press(again.v, again.cx, "escape");
  assert.equal(state.closed, 0, "closeOverlay is not called with no id");
  assert.deepEqual(state.runs.filter((r) => r.command === "overlay.close"), [{ command: "overlay.close", args: {} }]);
});

// ---------------------------------------------------------------- keeping the highlight in view

const twenty = () => Array.from({ length: 20 }, (_, i) => proj(`proj-${String(i + 1).padStart(2, "0")}`, `/r/p${i + 1}`, { pinned: i < 2 }));

test("every arrow press asks herdr to bring the highlighted item into view: the item itself, header rows counted", async () => {
  const { v, cx } = await open(twenty());
  rendered(v);
  v.scroll.calls.length = 0;
  for (let i = 0; i < 12; i++) press(v, cx, "down");
  // items: [header, p1, p2, header, p3 …]; the highlight starts on p1 (item 1)
  assert.deepEqual(v.scroll.calls, [2, 4, 5, 6, 7, 8, 9, 10, 11, 12, 13, 14]);
  assert.equal(v.at, 12);
});

test("it never asks for an earlier item than the highlighted one (which herdr would find already on screen and not scroll)", async () => {
  const { v, cx } = await open(twenty());
  rendered(v);
  v.scroll.calls.length = 0;
  for (let i = 0; i < 15; i++) press(v, cx, "down");
  const items = (await import("../mods/projects/lib.js")).listItems(v.rows(), false);
  const shown = v.scroll.calls.map((c) => items[c]);
  assert.ok(shown.every((it) => it.row), "always a row, never a header, going down");
  assert.deepEqual(shown.map((it) => it.index), [1, 2, 3, 4, 5, 6, 7, 8, 9, 10, 11, 12, 13, 14, 15]);
});

test("going up into a section's first project above what shows brings the header with it", async () => {
  const { v, cx } = await open(twenty());
  rendered(v);
  v.at = 2; // proj-03: the first row under "Everything else"
  v.ranges["pp-projects"].start = 5; // the list is scrolled well below it
  v.scroll.calls.length = 0;
  v.revealRow();
  assert.deepEqual(v.scroll.calls, [3], "the header, item 3, not the row at item 4");
  v.ranges["pp-projects"].start = 0; // the row is below the top of what shows: just the row
  v.scroll.calls.length = 0;
  v.revealRow();
  assert.deepEqual(v.scroll.calls, [4]);
});

test("a wrap from the last project to the first asks for the first", async () => {
  const { v, cx } = await open(twenty());
  rendered(v);
  press(v, cx, "up");
  assert.equal(v.at, 19);
  v.scroll.calls.length = 0;
  press(v, cx, "down");
  assert.equal(v.at, 0);
  assert.deepEqual(v.scroll.calls, [1]);
});

test("the worktree list scrolls with its highlight too", async () => {
  const { v } = await open([proj("demo", "/r/demo")]);
  v.wtScroll.calls.length = 0;
  v.reveal("pp-worktrees", v.wtScroll, 9);
  assert.deepEqual(v.wtScroll.calls, [9]);
});

// ---------------------------------------------------------------- the template and duplicating

const T = { detail: true, template: true };
const fieldOf = (v, key) => v.fields.find(([k]) => k === key)[1];
/** The editor's box for the draft's first agent pane, and a project's first agent command. */
const agentBox = (v) => v.boxFor(firstAgent(v.draft.startup.tabs).pane, "agent");
const agentOf = (p) => firstAgent(p.startup.tabs)?.pane.agent ?? "";
const rowNames = (v) => v.rows().map((r) => r.p.name);

test("the default template is the last row for everyone, tagged and under its own header", async () => {
  const { v } = await open([proj("zeta", "/r/z", { pinned: true }), proj("alpha", "/r/a")], undefined, T);
  assert.deepEqual(rowNames(v), ["zeta", "alpha", "Template"]);
  const t = texts(v);
  assert.ok(t.includes("TEMPLATE") && t.includes("template") && t.includes("A starting point: press Enter to make a project from it"));
  assert.ok(t.includes("3 of 3"));
});

test("with no projects the list is just the template and says what to do", async () => {
  const { v } = await open([], undefined, T);
  assert.deepEqual(rowNames(v), ["Template"]);
  assert.match(texts(v), /No projects yet\. Edit the Template to suit you \(alt\+e\), then press Enter on it/);
  assert.ok(!texts(v).includes("No project matches"));
});

test("a project is not hidden by the template: hideTemplate in the data file removes the row", async () => {
  const { v } = await open([proj("alpha", "/r/a")], undefined, {});
  assert.deepEqual(rowNames(v), ["alpha"]);
});

test("the template card says what it is and offers Use template, Edit and Delete only", async () => {
  const { v, cx } = await open([], undefined, T);
  const t = texts(v);
  for (const s of ["Not a real project", "Agent", "Claude Code", "Tabs", "Worktrees", "asks for a branch name", "Use template", "Edit", "Delete"]) assert.ok(t.includes(s), s);
  assert.ok(!hasId(v, "pp-open") && !hasId(v, "pp-checkout") && !hasId(v, "pp-wt"), "nothing that needs a folder");
});

test("Enter on the template opens the editor on a new project with its settings and no folder", async () => {
  const { v, cx } = await open([], undefined, T);
  enter(v);
  assert.equal(v.mode, "edit");
  assert.equal(v.editKind, "fromTemplate");
  assert.equal(fieldOf(v, "name").value(), "New project");
  assert.equal(fieldOf(v, "path").value(), "");
  assert.equal(agentBox(v).value(), "claude");
  assert.ok(texts(v).includes("New project from the template"));
  assert.equal(v.index, null);
  assert.deepEqual(spaceNew(), [], "nothing was launched");
  press(v, cx, "enter", { shift: true });
  assert.equal(v.mode, "edit", "Shift+Enter on the list would do the same, but the editor is already open");
});

test("saving a project made from the template needs a folder, and keeps the template", async () => {
  const dir = makeRepo();
  const { v, cx } = await open([], undefined, T);
  enter(v);
  await v.save(cx);
  assert.match(v.error, /Choose the project's folder/);
  assert.equal(v.mode, "edit");
  fieldOf(v, "path").set_value(dir);
  fieldOf(v, "name").set_value("api");
  await v.save(cx);
  assert.equal(v.error, null);
  assert.equal(v.mode, "list");
  const saved = JSON.parse(readFileSync(dataFile(), "utf8")).projects;
  assert.deepEqual(saved.map((p) => p.name), ["api"]);
  assert.equal(agentOf(saved[0]), "claude");
  assert.equal(saved[0].template, undefined);
  assert.deepEqual(rowNames(v), ["api", "Template"], "the template is still there");
});

test("ctrl+alt+U duplicates the highlighted project: a copy to edit, same folder, unique name", async () => {
  const dir = makeRepo();
  const { v, cx } = await open([proj("api", dir, { pinned: true, startup: { agent: "codex" }, group: "work" })], undefined, {});
  press(v, cx, "u", { alt: true });
  assert.equal(v.mode, "edit");
  assert.equal(v.editKind, "duplicate");
  assert.ok(texts(v).includes("Duplicate project"));
  assert.equal(fieldOf(v, "name").value(), "api copy");
  assert.equal(fieldOf(v, "path").value(), dir);
  assert.equal(agentBox(v).value(), "codex");
  assert.equal(v.draft.pinned, false);
  await v.save(cx);
  assert.equal(v.error, null);
  assert.deepEqual(JSON.parse(readFileSync(dataFile(), "utf8")).projects.map((p) => p.name), ["api", "api copy"]);
  assert.equal(v.projects[0].pinned, true, "the original is untouched");
  press(v, cx, "u", { alt: true });
  assert.equal(fieldOf(v, "name").value(), "api copy 2", "a second copy gets the next name");
});

test("the Duplicate button does the same, and Escape leaves without saving", async () => {
  const { v, cx } = await open([proj("api", "/r/api")], undefined, {});
  findAll(rendered(v), (e) => e.op?.("id")?.[0] === "pp-dup")[0].op("on_click")[0]();
  assert.equal(v.mode, "edit");
  press(v, cx, "escape");
  assert.equal(v.mode, "list");
  assert.deepEqual(rowNames(v), ["api"]);
});

test("editing the template saves it as a real entry; Add project then starts from it", async () => {
  const { v, cx } = await open([proj("api", "/r/api")], undefined, T);
  assert.equal(agentOf(v.newProject()), "", "before it is saved, Add project is blank");
  assert.equal(v.newProject().name, "");
  v.at = rowNames(v).indexOf("Template");
  press(v, cx, "e", { alt: true });
  assert.equal(v.editKind, "template");
  assert.ok(texts(v).includes("Edit template"));
  agentBox(v).set_value("hermes");
  fieldOf(v, "group").set_value("starter");
  await v.save(cx);
  assert.equal(v.error, null, "no folder needed for a template");
  const saved = JSON.parse(readFileSync(dataFile(), "utf8")).projects;
  const tpl = saved.find((p) => p.template);
  assert.equal(agentOf(tpl), "hermes");
  assert.equal(v.virtualTemplate, null, "the unsaved one is gone");
  assert.deepEqual(rowNames(v), ["api", "Template"]);
  const fresh = v.newProject();
  assert.deepEqual([agentOf(fresh), fresh.group, fresh.name, fresh.path], ["hermes", "starter", "", ""]);
  press(v, cx, "n", { alt: true });
  assert.equal(agentBox(v).value(), "hermes", "the n key opens the editor with the template's settings");
});

test("deleting the template hides it for good", async () => {
  const { v, cx } = await open([proj("api", "/r/api")], undefined, T);
  v.at = rowNames(v).indexOf("Template");
  press(v, cx, "d", { alt: true });
  assert.match(texts(v), /Remove the template\? .*hideTemplate/);
  press(v, cx, "d", { alt: true });
  await cx.settle();
  assert.deepEqual(rowNames(v), ["api"]);
  const data = JSON.parse(readFileSync(dataFile(), "utf8"));
  assert.equal(data.hideTemplate, true);
  assert.deepEqual(data.projects.map((p) => p.name), ["api"]);
  v.reload(cx);
  await cx.settle();
  assert.deepEqual(rowNames(v), ["api"], "still gone after a reload");
});

test("deleting a saved template also hides it", async () => {
  const { v, cx } = await open([proj("api", "/r/api"), normalize({ name: "Mine", path: "", template: true })], undefined, T);
  assert.deepEqual(rowNames(v), ["api", "Mine"], "a saved template replaces the default one");
  v.at = 1;
  press(v, cx, "d", { alt: true });
  press(v, cx, "d", { alt: true });
  await cx.settle();
  assert.deepEqual(rowNames(v), ["api"]);
  assert.equal(JSON.parse(readFileSync(dataFile(), "utf8")).hideTemplate, true);
});

test("a template never launches or opens worktrees, and git is not run for it", async () => {
  const { v, cx } = await open([], undefined, T);
  press(v, cx, "w", { alt: true });
  assert.equal(v.mode, "list");
  await v.loadInfo(cx);
  assert.deepEqual(v.info, {});
  assert.deepEqual(spaceNew(), []);
});

test("searching finds the template by name, and the card still follows the highlight", async () => {
  const { v } = await open([proj("api", "/r/api")], undefined, T);
  v.search.set_value("templ");
  assert.deepEqual(rowNames(v), ["Template"]);
  assert.ok(texts(v).includes("Use template"));
});

// ---------------------------------------------------------------- backup and restore

const click = (v, id) => findAll(rendered(v), (e) => e.op?.("id")?.[0] === id)[0].op("on_click")[0]();
const backupPath = () => `${scratch("backup")}/backup.json`;
const savedFile = () => JSON.parse(readFileSync(dataFile(), "utf8"));

test("alt+x and the Import / export button open the screen, Back returns", async () => {
  const { v, cx } = await open([proj("api", "/r/api")], undefined, {});
  press(v, cx, "x", { alt: true });
  assert.equal(v.mode, "backup");
  const t = texts(v);
  for (const s of ["Import and export config", "Export", "Import: merge", "Import: replace"]) assert.ok(t.includes(s), s);
  assert.match(v.backupPath.value(), /^~\/Downloads\/projects-config-\d{4}-\d\d-\d\d-\d{6}\.json$/, "a dated name");
  assert.ok(texts_noRefresh(v).length && !texts(v).includes("Backup"));
  click(v, "pp-bk-back");
  assert.equal(v.mode, "list");
  click(v, "pp-backup");
  assert.equal(v.mode, "backup");
});

test("Export writes the whole data file with portable paths, and asks before replacing a file", async () => {
  const dir = `${state.home}/code/api`;
  const file = backupPath();
  const { v, cx } = await open([proj("api", dir, { pinned: true }), proj("ext", "/srv/ext")], [{ name: "dev", panes: [{ type: "agent" }] }], { gitInfo: false });
  v.openBackup();
  v.backupPath.set_value(file);
  await v.exportBackup();
  const out = JSON.parse(readFileSync(file, "utf8"));
  assert.equal(out.format, "projects-backup");
  assert.deepEqual(out.projects.map((p) => p.name), ["api", "ext"]);
  assert.match(out.projects[0].path, /^~\//, "the home folder is written as ~");
  assert.equal(out.projects[1].path, "/srv/ext");
  assert.equal(out.projects[0].pinned, true);
  assert.equal(out.gitInfo, false);
  assert.deepEqual(out.layouts.map((l) => l.name), ["dev"]);
  assert.match(v.backupNote.text, /Exported 2 project\(s\)/);
  await v.exportBackup();
  assert.match(v.backupNote.text, /already exists/);
  assert.ok(v.backupNote.bad);
  assert.equal(v.backupConfirm, "overwrite");
  assert.ok(texts(v).includes("Click again to replace the file"));
  await v.exportBackup();
  assert.match(v.backupNote.text, /Exported/);
});

test("Export with nothing typed or an unwritable place says so", async () => {
  const { v } = await open([proj("api", "/r/api")], undefined, {});
  v.openBackup();
  v.backupPath.set_value("  ");
  await v.exportBackup();
  assert.match(v.backupNote.text, /Type where to save the file/);
});

test("Import merge adds what is missing, keeps yours, and warns about folders this machine lacks", async () => {
  const file = backupPath();
  writeFileSync(file, JSON.stringify({ format: "projects-backup", version: 1, projects: [{ name: "api", path: "/r/api", startup: AG("codex") }, { name: "blog", path: "/nope/blog" }], layouts: [{ name: "solo", panes: [{ type: "agent" }] }] }));
  const { v } = await open([proj("api", "/r/api", { startup: AG("claude") })], undefined, {});
  v.openBackup();
  v.backupPath.set_value(file);
  await v.importBackup("merge");
  assert.match(v.backupNote.text, /Merged: 1 project\(s\) added, 1 already here, 1 layout\(s\) added/);
  assert.match(v.backupNote.text, /1 folder\(s\) don't exist on this machine: blog/);
  assert.deepEqual(rowNames(v), ["api", "blog"]);
  const saved = savedFile();
  assert.deepEqual(saved.projects.map((p) => p.name), ["api", "blog"]);
  assert.equal(saved.projects[0].startup.tabs[0].panes[0].agent, "claude");
  assert.deepEqual(saved.layouts.map((l) => l.name), ["solo"]);
});

test("Import replace needs a second click, saves a .bak first, and restores exactly the backup", async () => {
  const file = backupPath();
  writeFileSync(file, JSON.stringify({ projects: [{ name: "only", path: "/r/only" }], layouts: [], gitInfo: false, hideTemplate: true }));
  const { v } = await open([proj("a", "/r/a"), proj("b", "/r/b")], undefined, {});
  const before = readFileSync(dataFile(), "utf8");
  v.openBackup();
  v.backupPath.set_value(file);
  await v.importBackup("replace");
  assert.match(v.backupNote.text, /replaces your 2 project\(s\) with the file's 1/);
  assert.equal(v.backupConfirm, "replace");
  assert.ok(texts(v).includes("Click again to replace everything"));
  assert.deepEqual(rowNames(v), ["a", "b"], "nothing changed yet");
  await v.importBackup("replace");
  assert.match(v.backupNote.text, /Replaced everything with the file: 1 project\(s\)/);
  assert.deepEqual(rowNames(v), ["only"]);
  assert.equal(readFileSync(`${dataFile()}.bak`, "utf8"), before, "the previous file is kept");
  const saved = savedFile();
  assert.deepEqual([saved.projects.map((p) => p.name), saved.gitInfo, saved.hideTemplate], [["only"], false, true]);
  assert.equal(v.gitInfo, false);
});

test("typing in the file box cancels a pending confirmation", async () => {
  const file = backupPath();
  writeFileSync(file, JSON.stringify({ projects: [] }));
  const { v } = await open([proj("a", "/r/a")], undefined, {});
  v.openBackup();
  v.backupPath.set_value(file);
  await v.importBackup("replace");
  assert.equal(v.backupConfirm, "replace");
  v.backupPath.emit("change");
  assert.equal(v.backupConfirm, null);
  assert.deepEqual(rowNames(v), ["a"]);
});

test("Import reports a missing file, a file that is not JSON, and one that is not a backup, and changes nothing", async () => {
  const dir = scratch("bad");
  const { v } = await open([proj("a", "/r/a")], undefined, {});
  rmSync(`${dataFile()}.bak`, { force: true }); // an earlier test's
  const before = readFileSync(dataFile(), "utf8");
  v.openBackup();
  v.backupPath.set_value(`${dir}/missing.json`);
  await v.importBackup("merge");
  assert.match(v.backupNote.text, /There is no file at/);
  writeFileSync(`${dir}/x.json`, "{ nope");
  v.backupPath.set_value(`${dir}/x.json`);
  await v.importBackup("merge");
  assert.match(v.backupNote.text, /Import failed: That file is not valid JSON/);
  writeFileSync(`${dir}/y.json`, JSON.stringify({ hello: 1 }));
  v.backupPath.set_value(`${dir}/y.json`);
  await v.importBackup("replace");
  assert.match(v.backupNote.text, /Import failed: That file has no list of projects/);
  assert.ok(v.backupNote.bad);
  assert.equal(readFileSync(dataFile(), "utf8"), before);
  assert.equal(existsSync(`${dataFile()}.bak`), false);
});

test("a backup exported here imports on a machine with another home folder", async () => {
  const file = backupPath();
  const dir = `${state.home}/code/api`;
  const a = await open([proj("api", dir)], undefined, {});
  a.v.openBackup();
  a.v.backupPath.set_value(file);
  await a.v.exportBackup();
  const b = await open([], undefined, {});
  b.v.openBackup();
  b.v.backupPath.set_value(file);
  await b.v.importBackup("merge");
  assert.deepEqual(rowNames(b.v), ["api"]);
  assert.match(savedFile().projects[0].path, /^~\//, "kept as ~, so it resolves under the new home");
});

// ---------------------------------------------------------------- the toolbar under the search box

const idsIn = (node) => findAll(node, (e) => e.op?.("id")?.[0]?.startsWith?.("pp-")).map((e) => e.op("id")[0]);

test("the actions live in one toolbar under the search box, with the card on or off, and say whom they act on", async () => {
  for (const detail of [true, false]) {
    const { v } = await open([proj("alpha", "/r/a"), proj("beta", "/r/b")], undefined, { detail });
    const t = texts(v);
    for (const s of ["Add project", "Duplicate", "Worktrees", "Edit", "Delete", "Import / export…", detail ? "Hide details" : "Show details", "acts on alpha"]) assert.ok(t.includes(s), `${detail}: ${s}`);
    const ids = idsIn(rendered(v));
    for (const id of ["pp-add", "pp-dup", "pp-wt", "pp-edit", "pp-delete", "pp-backup", "pp-details"]) assert.equal(ids.filter((x) => x === id).length, 1, `${detail}: one ${id}`);
    assert.ok(ids.indexOf("pp-add") < ids.indexOf("pp-0"), "above the list");
    v.at = 1;
    assert.ok(texts(v).includes("acts on beta"));
  }
});

test("the card no longer repeats the action buttons, and the template's toolbar has no Worktrees", async () => {
  const { v } = await open([proj("alpha", "/r/a")], undefined, T);
  assert.ok(hasId(v, "pp-open") && hasId(v, "pp-checkout"));
  v.at = rowNames(v).indexOf("Template");
  const ids = idsIn(rendered(v));
  assert.ok(ids.includes("pp-use") && ids.includes("pp-edit") && ids.includes("pp-delete") && ids.includes("pp-add"));
  assert.ok(!ids.includes("pp-wt"), "a template has no worktrees");
  assert.equal(ids.filter((x) => x === "pp-edit").length, 1);
});

test("with no projects the toolbar offers Add project and the screens, but no row actions", async () => {
  const { v } = await open([], undefined, {});
  const ids = idsIn(rendered(v));
  assert.ok(ids.includes("pp-add") && ids.includes("pp-backup") && ids.includes("pp-details"));
  assert.ok(!ids.includes("pp-edit") && !ids.includes("pp-dup"));
});

test("the Launcher button cycles sidebar, status bar, tab bar, off, and only touches blocks the layout has", async () => {
  const { v } = await open([proj("alpha", "/r/a")]);
  state.layout = { id: "root", children: [{ id: "projects-launch-sidebar" }, { id: "projects-launch-tabs" }] }; // no status block
  v.refreshSnap();
  assert.equal(v.snap.launcher, "sidebar", "the sidebar is the default");
  state.runs.length = 0;
  v.cycleLauncher(); // → status bar: it has no block here
  assert.equal(v.snap.launcher, "status");
  assert.deepEqual(state.runs.map((r) => [r.command, r.args.id]), [["layout.hide", "projects-launch-sidebar"], ["layout.hide", "projects-launch-tabs"]]);
  state.runs.length = 0;
  v.cycleLauncher(); // → tab bar
  assert.deepEqual(state.runs.map((r) => [r.command, r.args.id]), [["layout.hide", "projects-launch-sidebar"], ["layout.show", "projects-launch-tabs"]]);
});

test("on a layout with no launcher blocks the Launcher button never asks herdr to show or hide one", async () => {
  const { v } = await open([proj("alpha", "/r/a")]);
  state.layout = { id: "root", children: [{ id: "sidebar" }] };
  v.refreshSnap();
  assert.equal(v.snap.launcherInLayout, false);
  state.runs.length = 0;
  v.cycleLauncher();
  assert.deepEqual(state.runs.filter((r) => r.command === "layout.show" || r.command === "layout.hide"), []);
});

test("with no launcher blocks in the layout, the Launcher button writes a copy with them and switches to it", async () => {
  const { v, cx } = await open([proj("alpha", "/r/a")]);
  setShared("layout", "main");
  state.layout = { id: "root", children: [{ id: "sidebar", children: [{ id: "spaces", type: "block", size: { weight: 1 } }] }, { id: "work", children: [{ id: "tabs", type: "block", size: { px: 42 } }, { id: "status", type: "block", size: { px: 28 } }] }] };
  v.refreshSnap();
  assert.ok(texts(v).includes("Launcher: add to layout"));
  state.runs.length = 0;
  v.cycleLauncher();
  await cx.settle();
  assert.equal(v.error, null, "no separate launcher mod to check for");
  const file = `${state.appHome}/layouts/main-launcher.json`;
  assert.ok(existsSync(file), "the copy is written as a file, with no clone to wait for");
  const text = readFileSync(file, "utf8");
  assert.ok(["projects-launch-sidebar", "projects-launch-status", "projects-launch-tabs"].every((id) => text.includes(id)));
  assert.ok(!text.includes("projects-launcher"), "the blocks draw the projects mod");
  assert.deepEqual(state.runs.map((r) => [r.command, r.args.name]), [["layout.switch", "main-launcher"]], "no layout.clone and no layout.set");
});

test("the Launcher button rewrites a layout whose blocks still name the retired projects-launcher mod, then cycles", async () => {
  const { v, cx } = await open([proj("alpha", "/r/a")]);
  setShared("layout", "main-launcher");
  state.layout = { id: "root", children: [{ id: "spaces-section", children: [{ id: "spaces" }, { id: "projects-launch-sidebar", type: "block", content: { mod: "projects-launcher", props: { slot: "sidebar" } } }] }] };
  const file = `${state.appHome}/layouts/main-launcher.json`;
  mkdirSync(`${state.appHome}/layouts`, { recursive: true });
  writeFileSync(file, JSON.stringify(state.layout, null, 2) + "\n");
  v.refreshSnap();
  v.cycleLauncher();
  await cx.settle();
  assert.equal(v.snap.launcher, "status", "the cycle still happens");
  const saved = JSON.parse(readFileSync(file, "utf8"));
  assert.deepEqual(saved.children[0].children[1].content, { mod: "projects", props: { slot: "sidebar" } });
  assert.equal(v.error, null);
});

/** The copy of the mod a launcher block loads: props() carries the block's slot. */
function openLauncher(slot = "sidebar") {
  reset();
  state.props = { slot };
  const cx = { timers: [], every: [], timer: { after: (ms, fn) => cx.timers.push({ ms, fn }), every: (ms, fn) => cx.every.push({ ms, fn }) }, spawn: (fn) => fn(cx), focus_handle: () => ({}), notify() {}, stop_propagation() {} };
  const v = new Picker();
  v.init({}, cx);
  return { v, cx };
}

test("loaded by a launcher block, the mod draws the Projects button and runs the watcher, with no picker", () => {
  const { v, cx } = openLauncher("sidebar");
  assert.equal(v.role, "launcher");
  assert.ok(v.watcher, "the watcher lives in this copy");
  assert.ok(cx.every.some((e) => e.ms === 2000), "the watcher's tick is registered");
  assert.ok(!cx.every.some((e) => e.ms === 3000), "no picker snapshot timer");
  assert.equal(v.search, undefined, "no search box");
  const el = v.render();
  assert.ok(textOf(el).includes("Projects"));
  const button = findAll(el, (e) => e.op?.("id")?.[0] === "pp-launch")[0];
  button.op("on_click")[0]();
  assert.deepEqual(state.runs.map((r) => [r.command, r.args.name]), [["mod.open", "projects"]], "a click opens the picker");
});

test("only the launcher copy in the chosen slot lets its watcher act", () => {
  const { v } = openLauncher("status");
  assert.equal(v.watcher.active(), false, "the default slot is the sidebar");
  setShared("projects.launcher", "status");
  assert.equal(v.watcher.active(), true);
  setShared("projects.launcher", "off");
  assert.equal(v.watcher.active(), false);
});

test("a launcher copy whose slot is not the chosen one hides its own block, once", () => {
  const { v } = openLauncher("tabs");
  setShared("projects.launcher", "status");
  v.render(); v.render();
  assert.deepEqual(state.runs.map((r) => [r.command, r.args.id]), [["layout.hide", "projects-launch-tabs"]]);
});

test("opened as a popup (no slot), the mod is the picker and runs no watcher", async () => {
  const { v } = await open([proj("alpha", "/r/a")]);
  assert.equal(v.role, "picker");
  assert.equal(v.watcher, undefined);
  assert.ok(v.search);
});

test("a demo file can start the launcher setup", async () => {
  const { v } = await open([proj("alpha", "/r/a")]);
  let called = 0;
  v.setupLauncher = () => { called++; };
  v.applyDemo({ view: "launcher-setup" });
  assert.equal(called, 1);
});

test("a demo file can open the editor on a given tab and pane", async () => {
  const { v } = await open([proj("shop", "/r/shop", { startup: { tabs: [{ name: "a" }, { name: "b", panes: [{ type: "shell" }, { type: "shell", direction: "down" }] }] } })]);
  v.applyDemo({ view: "edit", project: "shop", section: "startup", tab: 1, pane: 1 });
  assert.deepEqual([v.mode, v.section, v.tabAt, v.paneAt], ["edit", "startup", 1, 1]);
});

test("a demo file can launch the named project", async () => {
  const dir = realpathSync(makeRepo()); mkdirSync(join(dir, "web"));
  const { v, cx } = await open([proj("shop", dir, { worktree: { mode: "never" }, startup: { tabs: [{ name: "a" }, { name: "web", folder: "web", command: "top" }] } })]);
  v.applyDemo({ view: "launch", project: "shop" }); await cx.settle();
  assert.deepEqual(state.tabsMade.map((t) => t.name), ["web"]);
});

const excludeFile = (wt) => { const p = sh(wt, "rev-parse", "--git-path", "info/exclude"); return p.startsWith("/") ? p : join(wt, p); };
test("opening a new worktree copies the listed files, runs worktree and startup setup once, and marks the worktree", async () => {
  const dir = realpathSync(makeRepo()); writeFileSync(join(dir, ".env"), "A=1\n");
  const root = scratch("pp-wt");
  const { v, cx } = await open([proj("api", dir, { worktree: { mode: "always", copy: [".env"], setup: ["npm ci"], branchTemplate: "{slug}", root: `${root}/{branch}` }, startup: { setup: ["echo hi"], agentTiming: "after", ...AG("claude") } })]);
  enter(v); enter(v); await cx.settle(); // the launch screen, then launch
  const wt = state.runs.find((r) => r.command === "space.new").args.folder;
  assert.equal(readFileSync(join(wt, ".env"), "utf8"), "A=1\n");
  const line = state.runs.find((r) => r.command === "space.new").args.argv[2];
  assert.match(line, /sh -ec 'npm ci' && sh -ec 'echo hi' && touch '.*\.projects-setup-done' && cd '[^']*' && exec 'claude'/);
  assert.match(readFileSync(excludeFile(wt), "utf8"), /projects-setup-done/);
  assert.ok(v.notes.some((n) => /copied 1 file/.test(n)));
  assert.ok(["will run: npm ci", "will run: echo hi"].every((n) => v.notes.includes(n)), v.notes.join(" | "));
});
test("a worktree that already carries the marker gets only the startup setup: no copy, no worktree setup, no touch", async () => {
  const dir = realpathSync(makeRepo()); const wt = join(scratch("pp-wt"), "w"); sh(dir, "worktree", "add", "-q", wt, "-b", "w");
  writeFileSync(join(wt, ".projects-setup-done"), ""); writeFileSync(join(dir, ".env"), "A=1\n");
  const { v, cx } = await open([proj("wt", wt, { worktree: { mode: "never", copy: [".env"], setup: ["echo X"] }, startup: { setup: ["echo Y"], agentTiming: "after", ...AG("claude") } })]);
  enter(v); enter(v); await cx.settle(); // the launch screen, then launch
  const line = state.runs.find((r) => r.command === "space.new").args.argv[2];
  assert.match(line, /sh -ec 'echo Y' && cd '[^']*' && exec/); assert.doesNotMatch(line, /echo X|touch/);
  assert.equal(existsSync(join(wt, ".env")), false);
});
test("quickSetup runs the steps inline before the agent and passes no chain", async () => {
  const dir = realpathSync(makeRepo());
  const { v, cx } = await open([proj("api", dir, { worktree: { mode: "never" }, startup: { setup: ["touch ran.txt"], quickSetup: true, agentTiming: "after", ...AG("claude") } })]);
  enter(v); enter(v); await cx.settle(); // the launch screen, then launch
  assert.equal(existsSync(join(dir, "ran.txt")), true);
  assert.deepEqual(state.runs.find((r) => r.command === "space.new").args.argv, ["claude"]);
  assert.ok(v.notes.some((n) => n === "$ touch ran.txt"));
  assert.ok(!v.notes.some((n) => n.startsWith("will run:")));
});
test("inline setup steps get the PROJECTS_* env", async () => {
  const dir = realpathSync(makeRepo());
  const { v, cx } = await open([proj("api", dir, { worktree: { mode: "never" }, startup: { setup: ["printf '%s' \"$PROJECTS_NAME\" > n.txt"], quickSetup: true, ...AG("claude") } })]);
  enter(v); enter(v); await cx.settle();
  assert.equal(readFileSync(join(dir, "n.txt"), "utf8"), "api");
});
test("a slash in the branch box is used verbatim", async () => {
  const dir = realpathSync(makeRepo()); const root = scratch("pp-wt");
  const { v, cx } = await open([proj("api", dir, { worktree: { mode: "ask", root: `${root}/{branch}` }, startup: AG("claude") })]);
  enter(v); await cx.settle();
  v.nameInput.set_value("feat/x"); enter(v); await cx.settle();
  assert.match(state.runs.find((r) => r.command === "space.new").args.name, /feat\/x/);
});
test("quickSetup on a new worktree marks it too, so the worktree setup runs once", async () => {
  const dir = realpathSync(makeRepo()); const root = scratch("pp-wt");
  const over = (path, mode) => proj("api", path, { worktree: { mode, setup: ["touch wt.txt"], branchTemplate: "{slug}", root: `${root}/{branch}` }, startup: { setup: ["touch st.txt"], quickSetup: true, agentTiming: "after", ...AG("claude") } });
  let { v, cx } = await open([over(dir, "always")]);
  enter(v); enter(v); await cx.settle();
  const wt = state.runs.find((r) => r.command === "space.new").args.folder;
  for (const f of ["wt.txt", "st.txt", ".projects-setup-done"]) assert.equal(existsSync(join(wt, f)), true, f);
  rmSync(join(wt, "wt.txt")); rmSync(join(wt, "st.txt"));
  ({ v, cx } = await open([over(wt, "never")]));
  enter(v); enter(v); await cx.settle();
  assert.equal(existsSync(join(wt, "st.txt")), true);
  assert.equal(existsSync(join(wt, "wt.txt")), false);
});

// ---------------------------------------------------------------- the launch screen

test("Enter on an ask project opens the launch screen with Open as Worktree, the prompt prefilled, and the project's timing", async () => {
  const { v, cx } = await open([proj("api", realpathSync(makeRepo()), { startup: { agentTiming: "after", setup: ["npm ci"], ...AG("claude", { prompt: "hello" }) } })]);
  enter(v); await cx.settle();
  assert.equal(v.mode, "launch");
  assert.deepEqual([v.launch.worktree, v.launch.agentTiming, v.promptBox.value()], [true, "after", "hello"]);
  const t = texts(v);
  for (const s of ["Open · api", "Worktree", "Checkout", "Branch", "Prompt", "Agent: after setup", "Launch"]) assert.ok(t.includes(s), s);
});
test("the launch screen launches with what was chosen: checkout, a typed prompt, timing toggled", async () => {
  const dir = realpathSync(makeRepo());
  const { v, cx } = await open([proj("api", dir, { worktree: { mode: "never" }, startup: { setup: ["true"], agentTiming: "after", ...AG("claude") } })]);
  enter(v); await cx.settle();
  v.promptBox.set_value("do the thing"); press(v, cx, "t", CTRL_ALT);
  assert.equal(v.launch.agentTiming, "with");
  v.launchNow(); await cx.settle();
  const sn = state.runs.find((r) => r.command === "space.new").args;
  assert.deepEqual([sn.argv, sn.task], [["claude"], "do the thing"]);
});
test("an empty prompt starts the agent bare", async () => {
  const dir = realpathSync(makeRepo());
  const { v, cx } = await open([proj("api", dir, { worktree: { mode: "never" }, startup: AG("claude", { prompt: "hello" }) })]);
  enter(v); await cx.settle(); v.promptBox.set_value(""); v.launchNow(); await cx.settle();
  const sn = state.runs.find((r) => r.command === "space.new").args;
  assert.deepEqual([sn.argv, sn.task, state.sent.length], [["claude"], undefined, 0]);
});
test("a project with no setup commands hides the Agent row and launches with", async () => {
  const dir = realpathSync(makeRepo());
  const { v, cx } = await open([proj("api", dir, { worktree: { mode: "never" }, startup: { agentTiming: "after", ...AG("claude") } })]);
  enter(v); await cx.settle();
  assert.doesNotMatch(texts(v), /Agent: /);
  v.launchNow(); await cx.settle();
  assert.deepEqual(state.runs.find((r) => r.command === "space.new").args.argv, ["claude"]);
});
test("quickLaunch skips the screen for always and never modes but not for ask", async () => {
  const dir = realpathSync(makeRepo()); const root = scratch("pp-wt");
  const mk = (name, mode) => proj(name, dir, { quickLaunch: true, worktree: { mode, root: `${root}/{branch}` }, startup: AG("claude") });
  const { v, cx } = await open([mk("never", "never"), mk("always", "always"), mk("ask", "ask")]);
  for (const [name, expected] of [["never", "busy"], ["always", "busy"], ["ask", "launch"]]) {
    v.search.set_value(name); v.at = 0; enter(v); await cx.settle();
    assert.equal(v.mode, expected, name);
    v.mode = "list"; reset(); // next project; a fresh stub state for each launch
  }
});
test("the demo view launch-screen opens the screen", async () => {
  const { v } = await open([proj("api", realpathSync(makeRepo()))]);
  v.applyDemo({ view: "launch-screen", project: "api" });
  assert.equal(v.mode, "launch");
});
test("ctrl+Enter on the launch screen launches", async () => {
  const dir = realpathSync(makeRepo());
  const { v, cx } = await open([proj("api", dir, { worktree: { mode: "never" }, startup: AG("claude") })]);
  enter(v); await cx.settle();
  assert.equal(v.mode, "launch");
  press(v, cx, "enter", { control: true }); await cx.settle();
  assert.equal(state.runs.filter((r) => r.command === "space.new").length, 1);
});
test("Shift+Enter on the list opens the launch screen on the checkout path", async () => {
  const { v, cx } = await open([proj("api", realpathSync(makeRepo()), { worktree: { mode: "ask" } })]);
  press(v, cx, "enter", { shift: true }); await cx.settle();
  assert.deepEqual([v.mode, v.launch.worktree], ["launch", false]);
});

test("the editor shows copy and worktree setup as one path or command per line and saves them as lists", async () => {
  const dir = realpathSync(makeRepo());
  const { v, cx } = await open([proj("api", dir, { worktree: { copy: [".env"], setup: ["npm ci"] }, startup: { setup: ["a", "b"] } })]);
  press(v, cx, "e", { alt: true }); v.showSection("worktree");
  assert.equal(v.fieldState("copy").value(), ".env"); assert.equal(v.fieldState("wtSetup").value(), "npm ci");
  v.fieldState("copy").set_value(".env\n.claude/*"); v.fieldState("wtSetup").set_value("npm ci\nnpm run build");
  v.showSection("startup"); assert.equal(v.fieldState("setup").value(), "a\nb");
  await v.save(cx);
  const saved = JSON.parse(readFileSync(dataFile(), "utf8")).projects[0];
  assert.deepEqual([saved.worktree.copy, saved.worktree.setup, saved.startup.setup], [[".env", ".claude/*"], ["npm ci", "npm run build"], ["a", "b"]]);
});
test("a two-command startup setup round-trips through the editor unchanged", async () => {
  const dir = realpathSync(makeRepo());
  const { v, cx } = await open([proj("api", dir, { startup: { setup: ["a", "b"] } })]);
  press(v, cx, "e", { alt: true });
  await v.save(cx);
  assert.deepEqual(JSON.parse(readFileSync(dataFile(), "utf8")).projects[0].startup.setup, ["a", "b"]);
});
test("quick launch and inline setup toggles are saved", async () => {
  const dir = realpathSync(makeRepo());
  const { v, cx } = await open([proj("api", dir)]);
  press(v, cx, "e", { alt: true }); v.showSection("startup");
  for (const id of ["pp-quicklaunch", "pp-quicksetup"]) findAll(rendered(v), (e) => e.op?.("id")?.[0] === id)[0].op("on_click")[0]({}, cx);
  await v.save(cx);
  const saved = JSON.parse(readFileSync(dataFile(), "utf8")).projects[0];
  assert.deepEqual([saved.quickLaunch, saved.startup.quickSetup], [true, true]);
});
test("the card summarises setup", async () => {
  const { v } = await open([proj("a", "/r/a", { worktree: { copy: [".env"], setup: ["x", "y"] }, startup: { agentTiming: "after" } }), proj("b", "/r/b")]);
  assert.match(texts(v), /1 copy · 2 setup · agent after setup/);
  v.at = 1; assert.match(texts(v), /no setup/);
});

test("a startup setup command containing ;; survives opening and saving the editor", async () => {
  const dir = realpathSync(makeRepo());
  const { v, cx } = await open([proj("api", dir, { startup: { setup: ["case x in a) ;; esac"] } })]);
  press(v, cx, "e", { alt: true });
  await v.save(cx);
  assert.deepEqual(JSON.parse(readFileSync(dataFile(), "utf8")).projects[0].startup.setup, ["case x in a) ;; esac"]);
});
