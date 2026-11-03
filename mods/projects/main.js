// Projects: a picker of configured git checkouts, each with its own worktree and startup
// settings. Type to filter, ↑/↓ and Enter to open, Shift+Enter for the main checkout, Add project / Edit / Worktrees / Delete
// buttons (or alt/ctrl/cmd + n, e, w, d), alt+b (cmd+alt+B on a Mac) to go back a screen. Herdr itself closes a popup on Esc and
// never passes that key to the mod, so Esc can only close the picker.

import { View, div, image, svg } from "gpui-kit";
import { v_flex, h_flex, InputState, Input, TextareaState, Textarea, Scrollbar, VirtualListScrollHandle, v_virtual_list } from "gpui-base";
import { knownAgents, window, theme, props, closeOverlay, run, pickFolder, shared, setShared, home, spaces, readTextFile, writeTextFile, layout, layouts, appHome, exec } from "herdr";
import { loadConfig, saveConfig, dataFilePath } from "./config.js";
import { inspect, projectFolder, previewBranch, createWorktree, worktreeSpaceName, listWorktrees, removeWorktree, prepareMain, findSpace, gitSummary, folderExists } from "./git.js";
import { buildWorkspace } from "./workspace.js";
import { copyInto, isNewWorktree, markerPath, excludeMarker } from "./setup.js";
import { readDemo } from "./demo.js";
import { initLog, log, logError } from "./log.js";
import { fuzzy, blankProject, blankPane, shortHome, splitList, joinList, basename, allLayouts, nextLayout, fuzzyPositions, highlightRuns, commandName, agentOptions, ago, listItems, layoutRects, enterAction, spaceColor, defaultTemplate, duplicateProject, startFromTemplate, expandHome, exportData, parseBackup, mergeProjects, mergeLayouts, exportFileName, withLauncherBlocks, tabsForLaunch, firstAgent, tabLabels, tabPlan, spaceShows, setupVars, setupChain, expand } from "./lib.js";

const RECENT = "projects.recent";
const EXPORT_DIR = "~/Downloads";
const LAUNCHER = "projects.launcher"; // where the clickable open button sits: sidebar (the default), status, tabs or off
const LAUNCHERS = [["sidebar", "sidebar"], ["status", "status bar"], ["tabs", "tab bar"], ["off", "off"]];
/** The launcher blocks the shown layout has (ids "projects-launch-<slot>"). A layout without them, such as herdr's own, has none. */
const launcherBlocks = () => {
  const found = [];
  const walk = (n) => { if (n?.id?.startsWith("projects-launch-")) found.push(n.id); (n?.children ?? []).forEach(walk); };
  walk(layout());
  return found;
};
const DETAIL = "projects.detail"; // false: hide the detail card (kept between sessions)
// Shortcut hints: ⌘ on macOS (Option+letter types a character there), alt elsewhere.
// The platform, copied from herdr with the rest of the snapshot (see takeSnapshot).
let platformNow = "";
const mac = () => platformNow === "macos";
let homeDir;
const homeOf = () => (homeDir ??= home());
const key = (letter, other = "alt") => (mac() ? `⌘${letter.toUpperCase()}` : `${other}+${letter}`);
/** The way back a screen. Herdr closes a popup on Esc itself, and it owns cmd+B on a Mac, so a Mac gets the cmd+alt chord (like the layout and details keys). */
const backKey = () => (mac() ? "⌘⌥B" : "alt+b");
// Herdr binds a bare alt+l to moving between panes, so the layout key needs ctrl (⌘ on macOS) as well, like the open key.
const FOOTER_SIZE = 12;
const LAYOUT_HINT = () => (mac() ? "⌘⌥L" : "ctrl+alt+L");
const DETAIL_HINT = () => (mac() ? "⌘⌥I" : "ctrl+alt+I");

const ROW = 48;
const HEADER = 30; // a section header in the project list
const CARD = 340; // the detail card's width
// Editor sections and the text fields each one shows.
const SECTIONS = [["project", "Project"], ["worktree", "Worktree"], ["git", "Git"], ["startup", "Startup"]];
const SECTION_FIELDS = {
  project: ["name", "path", "group", "description"],
  worktree: ["branchTemplate", "root", "spaceName"],
  git: ["remote", "base"],
  startup: ["setup"],
};
const MODES = ["ask", "always", "never"];
const MODE_HELP = { ask: "ask for a branch name", always: "always a new worktree", never: "open the checkout" };

// Editor fields: text ones keep an InputState, the rest are buttons.
const TEXT = [
  ["name", "Name", (p) => p.name, (p, v) => (p.name = v)],
  ["path", "Folder", (p) => p.path, (p, v) => (p.path = v)],
  ["group", "Group", (p) => p.group, (p, v) => (p.group = v)],
  ["description", "Description", (p) => p.description, (p, v) => (p.description = v)],
  ["branchTemplate", "Branch name", (p) => p.worktree.branchTemplate, (p, v) => (p.worktree.branchTemplate = v), "{user} {date} {slug} {repo} {project}"],
  ["root", "Worktree folder", (p) => p.worktree.root, (p, v) => (p.worktree.root = v), "{repo} {branch} plus the above"],
  ["spaceName", "Space name", (p) => p.worktree.spaceName, (p, v) => (p.worktree.spaceName = v), "the sidebar name: {name} {branch} {slug} {user} {date} {repo}"],
  ["remote", "Remote", (p) => p.git.remote, (p, v) => (p.git.remote = v)],
  ["base", "Base branch", (p) => p.git.base, (p, v) => (p.git.base = v)],
  ["setup", "Setup commands", (p) => joinList(p.startup.setup), (p, v) => (p.startup.setup = splitList(v)), "separate with ;; — each limited to 30 s"],
];
// The Startup section's boxes for a tab and for a pane: [field, label, note]. Each tab or pane object gets its own (see boxFor).
const TAB_BOXES = [
  ["name", "Name", "shown in the tab bar"],
  ["folder", "Folder", "empty: the project's folder; relative to it, or absolute"],
  ["command", "Command", "empty: a plain shell"],
];
const PANE_BOXES = [
  ["folder", "Folder", "empty: the tab's folder"],
  ["command", "Command", "runs in this pane"],
  ["agent", "Agent command", "pick above or type one"],
  ["args", "Arguments", "e.g. --model opus --permission-mode plan"],
  ["prompt", "First prompt", "sent to the agent"],
];
const boxNote = (list, f) => list.find(([k]) => k === f);

export default class ProjectPresets extends View {
  init(_props, cx) {
    this.cx = cx;
    this.scroll = VirtualListScrollHandle.new();
    this.wtScroll = VirtualListScrollHandle.new();
    this.ranges = {};
    this.overlay = props()?.overlay;
    this.projects = [];
    this.virtualTemplate = null; // the default template, shown until it is saved or deleted (see syncTemplate)
    this.hideTemplate = false;
    this.layouts = [];
    this.userLayouts = []; // the layouts in the data file (this.layouts also has the built-in ones)
    this.refreshSnap();
    cx.timer.every(3000, (cx) => { if (this.refreshSnap()) cx.notify(); });
    this.detail = shared(DETAIL) !== false; // the detail card beside the list (ctrl+alt+I turns it off)
    this.gitInfo = true;
    this.info = {}; // folder → { branch, dirty, worktrees } (null: not readable), filled in after the list shows
    this.layoutPick = null; // null: each project's own tabs; else a layout name (a pick of "" is the same as null)
    this.raw = null;
    this.mode = "list"; // list | edit | name | busy
    this.at = 0;
    this.error = null;
    this.notes = [];
    this.handle = cx.focus_handle();

    this.search = InputState.new({ placeholder: "Open a project…" });
    this.search.on("change", (_e, cx) => { this.at = 0; cx.notify(); });
    this.search.on("submit", () => { if (Date.now() - (this.handled ?? 0) > 200) this.activate(false); });
    this.search.focus();
    cx.timer.after(600, () => this.mode === "list" && this.search.focus());

    this.agents = [];
    this.allAgents = []; // every agent herdr knows plus the usual ones, installed or not: all are offered, and a project may name one this machine lacks
    knownAgents().then((a) => { this.allAgents = agentOptions(a); this.agents = this.allAgents; this.bump(cx); }).catch((e) => logError("knownAgents", e));
    initLog();
    this.reload(cx, async () => { const d = await readDemo(); if (d) this.applyDemo(d); });
  }

  /** Wraps a handler: an exception is logged and shown in the popup instead of vanishing. */
  guard(where, fn) {
    return (...a) => {
      try {
        const r = fn(...a);
        if (r && r.catch) r.catch((e) => this.fail(where, e));
        return r;
      } catch (e) { this.fail(where, e); }
    };
  }

  fail(where, e) {
    logError(where, e);
    this.error = `${where}: ${e?.message ?? e}`;
    if (this.mode === "launch") this.mode = "list";
    this.cx?.notify();
  }

  reload(cx, after) {
    cx.spawn(async (cx) => {
      try {
        const c = await loadConfig();
        this.projects = c.projects;
        this.layouts = allLayouts(c.layouts);
        this.userLayouts = c.layouts;
        this.gitInfo = c.gitInfo;
        this.hideTemplate = c.hideTemplate;
        this.syncTemplate();
        this.raw = c.raw;
      } catch (e) {
        logError("load config", e);
        this.error = e.message;
      }
      if (after) await after();
      cx.notify();
      // Branch, changed files and worktrees per project: on unless "gitInfo": false is in the data file (it runs git in every
      // project each time the picker opens).
      if (this.gitInfo) this.loadInfo(cx);
    });
  }

  /** A redraw for background work (git answers, the agent list): at most one every 250 ms. Herdr cuts a slow draw off when
   *  another is asked for, so a stream of redraws can keep the popup from ever finishing one. */
  bump(cx) {
    if (this.bumpPending) return;
    this.bumpPending = true;
    cx.timer.after(250, () => { this.bumpPending = false; cx.notify(); });
  }

  /** The default template is a row nobody has saved yet: it shows until the file has a template of its own, or the person
   *  deleted it (`hideTemplate` in the data file). */
  syncTemplate() {
    this.virtualTemplate = !this.hideTemplate && !this.projects.some((p) => p.template) ? (this.virtualTemplate ?? defaultTemplate()) : null;
  }

  /** The saved projects plus the unsaved default template, when it shows. */
  allProjects() { return this.virtualTemplate ? [...this.projects, this.virtualTemplate] : this.projects; }

  /** A new project: blank, or with the settings of a template the person has saved (not the unsaved default one). */
  newProject() {
    const template = this.projects.find((p) => p.template);
    return template ? startFromTemplate(template) : blankProject();
  }

  /** Branch, changed files and worktree count for each project, three at a time so the list stays quick. */
  async loadInfo(cx) {
    const token = (this.infoToken = (this.infoToken ?? 0) + 1);
    const queue = this.projects.filter((p) => !p.template && p.path);
    const worker = async () => {
      for (let p = queue.shift(); p; p = queue.shift()) {
        if (this.infoToken !== token || this.closing) return;
        const folder = projectFolder(p);
        this.info[folder] = await gitSummary(folder);
      }
    };
    await Promise.all([worker(), worker(), worker()]);
    this.bump(cx);
  }

  /** Puts the picker in the view a demo file names (see demo.js). */
  applyDemo(d) {
    const project = this.projects.find((p) => p.name === d.project);
    if (d.query != null) this.search.set_value(d.query);
    if (d.detail != null) this.detail = d.detail; // for the screenshot only: not kept
    if (d.layout != null) this.layoutPick = d.layout;
    const at = () => { const i = this.rows().findIndex((r) => r.p === project); this.at = Math.max(0, i); };
    if (d.select != null) this.at = d.select;
    else if (project) at();
    if (d.scrollTo != null) this.cx.timer.after(600, () => { this.scroll.scroll_to_item(d.scrollTo, "top"); this.cx.notify(); });
    if (d.view === "edit") {
      this.edit(project ?? blankProject(), project ? this.projects.indexOf(project) : null);
      if (d.section) this.showSection(d.section);
      if (d.tab != null) this.tabAt = d.tab;
      if (d.pane != null) this.paneAt = d.pane;
      if (d.focus) this.fields.find(([k]) => k === d.focus)?.[1].focus();
    } else if (d.view === "duplicate") this.duplicateSelected(); // a copy of the project, or a new project from the template when that row is picked
    else if (d.view === "backup") {
      this.openBackup();
      if (d.text) this.backupPath.set_value(d.text);
      if (d.note) this.backupNote = { text: d.note, bad: Boolean(d.bad) };
    } else if (d.view === "launch") { // launches the named project at once with its defaults, for checking a launch in the app
      if (project) { this.target = project; this.start(project, { worktree: project.worktree.mode !== "never" }); }
    } else if (d.view === "delete") this.pendingDelete = project;
    else if (d.view === "launch-screen" && project) {
      this.openLaunch(project, { mainOnly: Boolean(d.mainOnly) });
      if (d.text != null && this.nameInput) { this.nameInput.set_value(d.text); this.cx.timer.after(600, () => this.refreshPreview(this.cx)); }
      if (d.prompt != null) this.promptBox.set_value(d.prompt);
    } else if (d.view === "worktrees") {
      this.afterWt = () => { if (d.tick) this.selectMerged(); if (d.confirm) this.wtConfirm = true; };
      this.openWorktrees();
    } else if (d.view === "busy") {
      this.target = project;
      this.mode = "busy";
      this.notes = d.notes ?? [];
    }
  }

  /** Closes the popup. Not called `close`: herdr calls a view's `close(cx)` as its own cleanup hook when the popup goes. */
  dismiss() {
    this.closing = true;
    if (this.overlay) closeOverlay(this.overlay);
    else run("overlay.close", {}); // opened without an overlay id (a command line open): close the top one
  }

  /** herdr's hook for when the popup is going: stop background work. */
  close() { this.closing = true; }

  query() { return this.search.value(); }

  // ---- herdr's live data -------------------------------------------------

  /** The herdr data a draw needs, copied. Herdr draws a view again whenever live data it read changes (spaces, agents,
   *  shared state), and while an agent works that is constantly: a draw that read the live data was redrawn over and
   *  over, and a draw that takes a while is cut off when the next one is asked for. A draw reads this copy instead. */
  takeSnapshot() {
    const colors = shared("space.colors");
    return {
      spaces: spaces().filter((s) => !s.machine).map((s) => ({ id: s.id, folder: s.folder, status: s.status })),
      colors: colors ? { ...colors } : colors,
      recent: { ...(shared(RECENT) ?? {}) },
      platform: window()?.platform ?? "",
      launcher: shared(LAUNCHER) ?? "sidebar",
      launcherInLayout: launcherBlocks().length > 0,
    };
  }

  /** Takes a new snapshot; true when something in it changed (the caller then asks for a draw). */
  refreshSnap() {
    const next = this.takeSnapshot();
    const key = JSON.stringify(next);
    if (key === this.snapKey) return false;
    this.snap = next;
    this.snapKey = key;
    platformNow = next.platform;
    return true;
  }

  // ---- list -------------------------------------------------------------

  rows() {
    if (this.frame) return this.frame.rows; // while rendering, every caller gets the same list
    const recent = this.snap.recent;
    const q = this.query();
    const open = this.snap.spaces;
    const rows = this.allProjects().map((p) => {
      const score = Math.max(fuzzy(q, p.name), fuzzy(q, p.group), fuzzy(q, basename(p.path)) - 1);
      const folder = projectFolder(p);
      return { p, score, space: p.template ? undefined : open.find((s) => s.folder === folder) ?? open.find((s) => spaceShows(s.folder, folder)), used: recent[p.path] ?? 0 };
    }).filter((r) => r.score >= 0);
    rows.sort((a, b) => q
      ? b.score - a.score
      : (!!a.p.template - !!b.p.template) || (!!b.space - !!a.space) || (b.p.pinned - a.p.pinned) || (b.used - a.used) || a.p.name.localeCompare(b.p.name));
    return rows;
  }

  selected() { return this.rows()[this.at]; }

  /** The layout name a launch of `p` uses: the picked one, else "" (the project's own tabs). */
  layoutNameFor(p) { return this.layoutPick ?? ""; }

  /** ctrl+alt+I: shows or hides the detail card; the choice is kept for next time. */
  toggleDetail() {
    this.detail = !this.detail;
    setShared(DETAIL, this.detail);
  }

  /** The shown layout has no launcher blocks (herdr's own layouts have none, and it won't let a mod change those): writes a
   *  copy of the shown layout with the blocks to layouts/<name>-launcher.json and switches to it. The copy is built from the
   *  tree in hand and written as a file, so nothing waits on herdr finishing a clone. Your own layouts are never edited. */
  setupLauncher() {
    const from = shared("layout") ?? "main";
    const taken = new Set(layouts());
    let as = `${from}-launcher`;
    for (let n = 2; taken.has(as); n++) as = `${from}-launcher-${n}`;
    const { tree, added } = withLauncherBlocks(layout());
    log("info", "adding the launcher blocks", { from, as, added });
    if (!added.length) return this.fail("launcher", new Error("this layout has no spaces, status or tabs block to put the button beside"));
    return this.guard("launcher", async () => {
      // The blocks draw with the projects-launcher mod; without its folder they would be empty and herdr would log errors.
      const modDir = `${appHome()}/mods/projects-launcher`;
      if ((await readTextFile(`${modDir}/main.js`)) == null) throw new Error(`the launcher mod isn't installed. Copy mods/projects-launcher/ from the repo to ${shortHome(modDir, homeOf())}, then click this again`);
      await writeTextFile(`${appHome()}/layouts/${as}.json`, JSON.stringify(tree, null, 2) + "\n", null);
      run("layout.switch", { name: as });
      this.snap = { ...this.snap, launcherInLayout: true };
      this.cx.notify();
    })();
  }

  /** Moves the clickable open button (see the projects-launcher mod) to the next place: sidebar, status bar,
   *  tab bar, then off. The key combo is not affected. */
  cycleLauncher() {
    if (launcherBlocks().length === 0) return this.setupLauncher();
    const now = shared(LAUNCHER) ?? "sidebar";
    const next = LAUNCHERS[(LAUNCHERS.findIndex(([k]) => k === now) + 1) % LAUNCHERS.length][0];
    setShared(LAUNCHER, next);
    this.snap = { ...this.snap, launcher: next }; // the toolbar label changes at once, not at the next snapshot
    // Only the blocks this layout has: on a layout without them (see "The clickable Projects button" in the README) there is
    // nothing to show or hide, and asking would fail.
    const have = launcherBlocks();
    for (const [k] of LAUNCHERS) if (k !== "off" && have.includes(`projects-launch-${k}`)) run(k === next ? "layout.show" : "layout.hide", { id: `projects-launch-${k}` });
  }

  /** ctrl+alt+L: the next layout for `p`'s launch (none, then each layout). */
  cycleLayout(p) {
    const next = nextLayout(this.layouts.map((l) => l.name), this.layoutNameFor(p));
    this.layoutPick = next === "" ? null : next;
    // The selector stands out for a second so the change is easy to see.
    const flash = (this.layoutFlash = (this.layoutFlash ?? 0) + 1);
    this.layoutLit = true;
    this.cx.timer.after(1000, () => { if (this.layoutFlash === flash) { this.layoutLit = false; this.cx.notify(); } });
  }

  /** Under the list: a hint line with the keys in bold, then the layout selector. It shows every layout with the
   *  one this launch uses lit; for a second after a change the lit one turns bold with an accent ring. */
  footer(t, p, list) {
    const hints = list
      ? [["Enter", "opens"], ["Shift+Enter", "checkout"], [key("n"), "add"], [key("u"), "duplicate"], [key("x"), "import/export"], [key("e"), "edit"], [key("w"), "worktrees"], [key("d"), "delete"], [LAYOUT_HINT(), "layout"], [DETAIL_HINT(), "details"]]
      : [["ctrl+⏎", "launches"], [backKey(), "back"], ["Esc", "closes"]];
    const current = this.layoutNameFor(p);
    const lit = this.layoutLit;
    const choice = (name, label) => {
      const on = name === current;
      return div().px(10).py(3).rounded(8).border_1().text_size(11.5)
        .border_color(on ? (lit ? t.accent : t.solid) : t.input).bg(on ? t.solid : t.raised)
        .text_color(on ? t.solid_foreground : t.dim).when(on, (el) => (lit ? el.font_bold() : el.font_semibold())).child(label);
    };
    // Every element a render builds costs time, and herdr cuts a slow render off: one row, a bold key and a plain
    // string per hint, not a box with two boxes inside.
    const hintLine = h_flex().gap(5).items_baseline().flex_wrap().text_size(FOOTER_SIZE).text_color(t.dim)
      .children(hints.flatMap(([k, w], i) => [div().font_semibold().text_color(t.foreground).child(k), i < hints.length - 1 ? `${w}  ·` : w]));
    if (list && this.detail) return hintLine; // the detail card has the layout choice
    return v_flex().gap(8)
      .child(hintLine)
      .child(h_flex().gap(6).items_center().flex_wrap().text_size(FOOTER_SIZE)
        .child(div().text_color(t.dim).child("Layout"))
        .child(choice("", "Project's tabs"))
        .children(this.layouts.map((l) => choice(l.name, l.label ?? l.name)))
        .child(div().flex_1())
        .child(div().px(6).rounded(5).border_1().border_color(t.input).bg(t.raised).text_size(10.5).text_color(t.foreground).child(LAYOUT_HINT())));
  }

  /** A mini icon for an agent entry from herdr's program table (a one-color glyph or a picture). */
  programIcon(t, program, size = 16) {
    const box = div().w(size).h(size).flex_none();
    if (!program?.icon) return box.child(svg("icons/agent.svg").size(size).flex_none().text_color(t.dim));
    return box.child(program.tint ? svg(program.icon).size(size).flex_none().text_color(t.foreground) : image(program.icon).w(size).h(size).flex_none());
  }

  shellIcon(t, size = 16) { return div().w(size).h(size).flex_none().child(svg("icons/shell.svg").size(size).flex_none().text_color(t.dim)); }

  /** The mini icon for what a project starts: its agent (claude, hermes, pi…), the shell icon for a plain
   *  shell, and the generic agent icon for a command herdr has no entry for. */
  agentIcon(t, p, size = 16) {
    const name = commandName(firstAgent(p.startup.tabs)?.pane.agent);
    if (!name) return this.shellIcon(t, size);
    return this.programIcon(t, this.allAgents.find((a) => a.key === name || commandName((a.run ?? []).join(" ")) === name), size);
  }

  /** A project's name with the letters the search matched in bold and the accent color. */
  nameText(t, name) {
    const at = fuzzyPositions(this.query(), name);
    const row = h_flex().text_color(t.foreground).font_medium();
    if (!at.length) return row.child(name);
    return row.children(highlightRuns(name, at).map((r) => r.hit ? div().font_bold().text_color(t.accent).child(r.text) : div().child(r.text)));
  }

  /** Enter (mainOnly false) opens the launch screen on a new worktree (a checkout for a `never` project); Shift+Enter
   *  opens it on the checkout. A quickLaunch project skips the screen unless it would ask for a branch name. */
  activate(mainOnly) {
    const r = this.selected();
    if (!r || this.mode !== "list") return;
    const p = r.p;
    if (p.template) return this.duplicateSelected(); // a template has no folder to open: Enter makes a project from it
    this.target = p;
    if (p.quickLaunch && (mainOnly || p.worktree.mode !== "ask")) return this.start(p, { worktree: !mainOnly && p.worktree.mode !== "never" });
    this.openLaunch(p, { mainOnly });
  }

  /** The launch screen: open as worktree or checkout, branch, first prompt, agent timing, layout. Makes host
   *  objects, so it runs from an event, never from render. */
  openLaunch(p, { mainOnly = false } = {}) {
    this.target = p;
    this.mode = "launch";
    this.error = null;
    this.launch = { worktree: !mainOnly && p.worktree.mode !== "never", agentTiming: p.startup.agentTiming };
    this.nameInput = null;
    this.preview = "";
    if (this.launch.worktree) this.makeNameInput();
    this.promptBox = TextareaState.new({ placeholder: "First prompt (optional)", value: firstAgent(p.startup.tabs)?.pane.prompt ?? "", rows: 3 });
    this.promptBox.set_auto_grow(3, 8);
    // No `submit` handler: the box fires it on every Enter, which also types a newline. ctrl+Enter launches (see keys).
    (this.nameInput ?? this.promptBox).focus();
  }

  makeNameInput() {
    this.nameInput = InputState.new({ placeholder: "branch name, e.g. fix login (empty: use the time)" });
    this.nameInput.on("change", (_e, cx) => this.refreshPreview(cx));
    this.nameInput.on("submit", () => this.launchNow());
    this.refreshPreview(this.cx);
  }

  /** Open as Worktree or Checkout. */
  setOpenAs(worktree) {
    this.launch.worktree = worktree;
    if (worktree && !this.nameInput) this.makeNameInput();
    else if (worktree) this.refreshPreview(this.cx);
  }

  /** Whether this launch runs setup commands, so the agent can start after them. */
  launchHasSetup() {
    const p = this.target;
    return p.startup.setup.length > 0 || (this.launch.worktree && p.worktree.setup.length > 0);
  }

  launchNow() {
    if (this.mode !== "launch") return; // the branch box's submit and ctrl+Enter can both arrive
    this.start(this.target, {
      worktree: this.launch.worktree,
      branchText: this.launch.worktree ? (this.nameInput?.value() ?? "") : "",
      prompt: this.promptBox.value().trim(),
      agentTiming: this.launchHasSetup() ? this.launch.agentTiming : "with",
    });
  }

  refreshPreview(cx) {
    const p = this.target;
    const text = this.nameInput.value();
    // Answers can come back out of order: only the latest request may set the preview.
    const seq = (this.previewSeq = (this.previewSeq ?? 0) + 1);
    cx?.spawn(async (cx) => {
      try {
        const branch = await previewBranch(p, text);
        if (seq !== this.previewSeq) return;
        this.preview = branch;
        this.error = null;
      } catch (e) {
        if (seq !== this.previewSeq) return;
        this.error = e.message;
      }
      cx.notify();
    });
    cx?.notify();
  }

  start(p, { worktree, branchText = "", prompt = firstAgent(p.startup.tabs)?.pane?.prompt ?? "", agentTiming = p.startup.agentTiming, pick = this.layoutNameFor(p) } = {}) {
    this.mode = "busy";
    this.notes = [];
    this.error = null;
    const log = (m) => { this.notes = [...this.notes, m]; this.cx?.notify(); };
    this.cx?.spawn(async (cx) => {
      try {
        if (pick && !this.layouts.some((l) => l.name === pick)) throw new Error(`No layout called "${pick}". Layouts: ${this.layouts.map((l) => l.name).join(", ") || "none"}`);
        const tabs = tabsForLaunch(p, this.layouts, pick);
        tabPlan(tabs); // a broken layout is reported before anything is created
        const existing = findSpace(p);
        if (!worktree && existing) {
          setShared(RECENT, { ...(shared(RECENT) ?? {}), [p.path]: Date.now() });
          this.dismiss();
          return run("space.select", { id: existing.id });
        }
        const { folder, name, chain, steps, mark } = await this.prepareLaunch(p, { worktree, branchText }, log);
        const quick = p.startup.quickSetup;
        if (quick && await runInline(steps, folder, log) && mark) {
          await excludeMarker(folder);
          await exec("touch", [markerPath(folder)]);
        }
        setShared(RECENT, { ...(shared(RECENT) ?? {}), [p.path]: Date.now() });
        const first = firstAgent(p.startup.tabs)?.pane;
        if (prompt && first?.promptMode === "send" && agentTiming === "with") log("Waiting for the agent to be ready for its prompt…");
        // Stay open until the prompt is sent: closing the popup cancels this task.
        await buildWorkspace({ project: p, folder, name, tabs, prompt, agentTiming, chain: quick ? "" : chain, log });
        this.dismiss();
      } catch (e) {
        logError("open project", e);
        this.error = e.message;
        cx.notify();
      }
    });
  }

  /** The worktree (created, copied into, chained) or the prepared checkout: { folder, name, chain, steps }. */
  async prepareLaunch(p, { worktree, branchText }, log) {
    const main = projectFolder(p), quick = p.startup.quickSetup;
    const note = (steps) => { if (!quick) steps.forEach((s) => log(`$ ${s}`)); };
    if (!worktree) {
      await prepareMain(p, log);
      const { vars, env } = setupVars({ main, folder: main, branch: (await inspect(main)).branch, repo: basename(main), name: p.name, home: home() });
      const steps = p.startup.setup.map((s) => expand(s, vars));
      note(p.startup.setup);
      return { folder: main, name: p.name, steps, chain: setupChain({ steps: p.startup.setup, vars, env, folder: main }) };
    }
    const wt = await createWorktree(p, branchText, log);
    const isNew = await isNewWorktree(wt.folder);
    const { vars, env } = setupVars({ main, folder: wt.folder, branch: wt.branch, repo: wt.vars.repo, name: p.name, home: home() });
    if (isNew && p.worktree.copy.length) await copyInto({ main, dest: wt.folder, patterns: p.worktree.copy, vars, log });
    const raw = (isNew ? p.worktree.setup : []).concat(p.startup.setup);
    const marker = isNew && raw.length && !quick ? markerPath(wt.folder) : undefined;
    const chain = setupChain({ steps: raw, vars, env, folder: wt.folder, marker });
    if (marker) await excludeMarker(wt.folder);
    note(raw);
    return { folder: wt.folder, name: worktreeSpaceName(p, wt), steps: raw.map((s) => expand(s, vars)), chain, mark: isNew && raw.length > 0 };
  }

  // ---- editor -----------------------------------------------------------

  edit(project, index, kind) {
    try { this.openEditor(project, index, kind); } catch (e) { logError("editor", e); this.mode = "list"; this.error = `Editor failed: ${e.message}`; }
    this.cx?.notify();
  }

  openEditor(project, index, kind) {
    this.mode = "edit";
    this.index = index; // null: new
    this.editKind = kind ?? (project.template ? "template" : index == null ? "add" : "edit");
    this.draft = JSON.parse(JSON.stringify(project));
    this.error = null;
    this.confirmDelete = false;
    this.fields = TEXT.map(([key, , get]) => {
      const s = InputState.new({ value: get(this.draft) ?? "" });
      s.on("focus", () => { this.field = key; this.focused = s; });
      return [key, s];
    });
    this.inputs = new WeakMap(); // tab or pane object → { field: InputState }
    this.tabAt = 0;
    this.paneAt = null;
    this.fieldOrder = [];
    this.makeBoxes();
    this.section = "project";
    this.focused = this.fields[0][1];
    this.fields[0][1].focus();
  }

  fieldState(key) { return this.fields.find(([k]) => k === key)[1]; }

  showSection(id) {
    this.section = id;
    this.field = SECTION_FIELDS[id][0];
    const state = this.fieldState(this.field);
    this.focused = state;
    this.cx.timer.after(80, () => state.focus()); // once its input is on screen
    this.cx.notify();
  }

  async browse(cx) {
    const dir = await pickFolder({ prompt: "Use this folder" });
    if (!dir) return;
    this.fields.find(([k]) => k === "path")[1].set_value?.(dir);
    this.draft.path = dir;
    const name = this.fields.find(([k]) => k === "name")[1];
    if (!name.value()) name.set_value?.(basename(dir));
    cx.notify();
  }

  async save(cx) {
    try {
      this.collectTabs();
      for (const [key, state] of this.fields) TEXT.find(([k]) => k === key)[3](this.draft, key === "path" ? state.value() : state.value().trim());
      const d = this.draft;
      // An emptied list stores the plain shell tab normalize gives a project with none.
      if (!d.startup.tabs.length) d.startup.tabs = [{ name: "shell", folder: "", command: "", panes: [] }];
      tabPlan(d.startup.tabs);
      if (!d.name) throw new Error("Give the project a name");
      if (!d.template) {
        if (!d.path.trim()) throw new Error("Choose the project's folder: Browse… or type its path");
        await inspect(projectFolder(d));
      }
      const list = [...this.projects];
      if (this.index == null) list.push(d); else list[this.index] = d;
      this.raw = await saveConfig(list, this.raw);
      this.projects = list;
      this.syncTemplate();
      this.mode = "list";
      this.error = null;
      this.search.focus();
    } catch (e) {
      logError("save", e);
      this.error = e.message;
    }
    cx.notify();
  }

  async remove(cx) {
    if (!this.confirmDelete) { this.confirmDelete = true; return cx.notify(); }
    try {
      const list = this.projects.filter((_p, i) => i !== this.index);
      const template = this.draft.template;
      this.raw = await saveConfig(list, this.raw, template ? { hideTemplate: true } : {});
      this.projects = list;
      if (template) this.hideTemplate = true;
      this.syncTemplate();
      this.mode = "list";
      this.search.focus();
    } catch (e) { logError("delete", e); this.error = e.message; }
    cx.notify();
  }

  /** Tab and Shift+Tab: the next box of the section in the order the last draw showed them. */
  focusNextField(back) {
    const order = this.fieldOrder?.length ? this.fieldOrder : SECTION_FIELDS[this.section].map((k) => this.fieldState(k));
    let i = order.indexOf(this.focused);
    if (i < 0) i = back ? 0 : -1;
    const next = order[(i + (back ? -1 : 1) + order.length) % order.length];
    this.focused = next;
    this.field = this.fields.find(([, s]) => s === next)?.[0] ?? null;
    next.focus();
  }

  // ---- editor: the Startup section's tabs and panes -----------------------
  // The draft's tabs and panes are edited in place; each object has its own boxes (this.inputs), which collectTabs reads
  // back on save. Moving a tab or pane moves the object, so what was typed moves with it.

  tab() { return this.draft.startup.tabs[this.tabAt]; }
  pane() { return this.paneAt == null ? undefined : this.tab()?.panes[this.paneAt]; }

  /** The box for a tab's or pane's field, made on first use. */
  boxFor(obj, field) {
    let boxes = this.inputs.get(obj);
    if (!boxes) this.inputs.set(obj, (boxes = {}));
    if (!boxes[field]) {
      const s = InputState.new({ value: obj[field] ?? "" });
      s.on("focus", () => { this.field = null; this.focused = s; });
      boxes[field] = s;
    }
    return boxes[field];
  }

  /** Boxes for every tab and pane, made when the draft changes shape so a draw only reads them. */
  makeBoxes() {
    for (const tab of this.draft.startup.tabs) {
      for (const [f] of TAB_BOXES) this.boxFor(tab, f);
      for (const pane of tab.panes) for (const [f] of PANE_BOXES) this.boxFor(pane, f);
    }
  }

  /** Sets a field and its box together, so collectTabs does not write the old text back. */
  setField(obj, field, value) {
    obj[field] = value;
    this.inputs.get(obj)?.[field]?.set_value(value);
  }

  /** Writes every box back into its tab or pane (a folder keeps its spaces, the rest are trimmed). */
  collectTabs() {
    const read = (obj, list) => {
      const boxes = this.inputs.get(obj) ?? {};
      for (const [f] of list) if (boxes[f]) obj[f] = f === "folder" ? boxes[f].value() : boxes[f].value().trim();
    };
    for (const tab of this.draft.startup.tabs) {
      read(tab, TAB_BOXES);
      for (const pane of tab.panes) read(pane, PANE_BOXES);
    }
  }

  selectTab(i) { this.tabAt = i; this.paneAt = null; }

  addTab() {
    const tabs = this.draft.startup.tabs;
    tabs.push({ name: "", folder: "", command: "", panes: [] });
    this.selectTab(tabs.length - 1);
    this.makeBoxes();
  }

  /** Removes the selected tab and selects the one before it (none when the list is empty). */
  removeTab() {
    if (!this.tab()) return;
    this.draft.startup.tabs.splice(this.tabAt, 1);
    this.selectTab(Math.max(0, this.tabAt - 1));
  }

  moveTab(delta) {
    const tabs = this.draft.startup.tabs;
    const to = this.tabAt + delta;
    if (!this.tab() || to < 0 || to >= tabs.length) return;
    [tabs[this.tabAt], tabs[to]] = [tabs[to], tabs[this.tabAt]];
    this.tabAt = to;
  }

  /** A shell pane split below the last one. A tab that runs a command first gets that command as pane 1. */
  addPane() {
    const tab = this.tab();
    if (!tab) return;
    const command = this.boxFor(tab, "command").value().trim();
    if (command && !tab.panes.length) {
      tab.panes.push(blankPane({ type: "command", command }));
      this.setField(tab, "command", "");
    }
    tab.panes.push(blankPane({ direction: tab.panes.length ? "down" : "" }));
    this.paneAt = tab.panes.length - 1;
    this.makeBoxes();
  }

  removePane() {
    const tab = this.tab();
    if (!this.pane()) return;
    tab.panes.splice(this.paneAt, 1);
    this.paneAt = tab.panes.length ? Math.max(0, this.paneAt - 1) : null;
  }

  movePane(delta) {
    const panes = this.tab()?.panes;
    const to = (this.paneAt ?? -1) + delta;
    if (!this.pane() || to < 0 || to >= panes.length) return;
    [panes[this.paneAt], panes[to]] = [panes[to], panes[this.paneAt]];
    this.paneAt = to;
  }

  setPaneType(type) { const pane = this.pane(); if (pane) pane.type = type; }

  cycleDirection() { const pane = this.pane(); if (pane) pane.direction = pane.direction === "right" ? "down" : "right"; }

  /** Replaces the selected tab's panes with a layout's. The tab's agent (command, arguments, prompt) goes to the
   *  layout's first agent pane. */
  panesFromLayout(name) {
    const tab = this.tab();
    const layout = this.layouts.find((l) => l.name === name);
    if (!tab || !Array.isArray(layout?.panes)) return;
    this.collectTabs();
    const src = firstAgent([tab])?.pane;
    const panes = layout.panes.map((x) => blankPane({ type: String(x.command ?? "").trim() ? "command" : "shell", ...x }));
    const dest = panes.find((x) => x.type === "agent");
    if (src && dest) Object.assign(dest, { agent: src.agent, args: src.args, prompt: src.prompt, promptMode: src.promptMode });
    tab.panes = panes;
    this.setField(tab, "command", "");
    this.paneAt = null;
    this.makeBoxes();
  }

  /** The Startup section: setup commands, agent timing, the tabs list and the selected tab's and pane's fields. */
  renderTabs(t, cx, field, input, label) {
    const d = this.draft;
    const tab = this.tab();
    const pane = this.pane();
    const val = (obj, f) => this.boxFor(obj, f).value();
    const box = (obj, list, f) => { const [, name, note] = boxNote(list, f); return input(this.boxFor(obj, f), name, note); };
    const dim = (text) => div().text_size(11.5).text_color(t.dim).child(text);
    const act = (id, text, action, on = false, lead = null) => this.button(t, id, text, on, () => { action(); cx.notify(); }, lead);
    const row = (id, on, cells, pick) => h_flex().id(id).gap(10).h(28).px(10).items_center().rounded(6).cursor_pointer()
      .bg(on ? t.selected : t.raised).text_size(12.5).text_color(t.foreground)
      .on_click(this.guard(`row ${id}`, () => { pick(); cx.notify(); })).children(cells);
    const moves = (kind, add, del, move) => h_flex().pt(6).gap(6)
      .child(act(`pp-${kind}-add`, `Add ${kind}`, add)).child(act(`pp-${kind}-del`, `Remove ${kind}`, del))
      .child(act(`pp-${kind}-up`, "Move up", () => move(-1))).child(act(`pp-${kind}-down`, "Move down", () => move(1)));
    const timing = d.startup.agentTiming === "with";
    const out = [
      field("setup"),
      h_flex().pt(8).gap(8).items_center()
        .child(act("pp-timing", `Agent timing: ${timing ? "with setup" : "after setup"}`, () => (d.startup.agentTiming = timing ? "after" : "with")))
        .child(dim(timing ? "agents start while the setup commands run" : "agents start once the setup commands finish")),
      label("Tabs"),
      d.startup.tabs.length
        ? v_flex().gap(3).children(d.startup.tabs.map((x, i) => row(`pp-tab-${i}`, i === this.tabAt, [
          div().flex_1().min_w(0).font_medium().child(val(x, "name") || "(unnamed)"),
          dim(val(x, "folder")),
          dim(x.panes.length ? `${x.panes.length} pane${x.panes.length > 1 ? "s" : ""}` : val(x, "command") || "plain shell"),
        ], () => this.selectTab(i))))
        : dim("No tabs: a plain shell"),
      moves("tab", () => this.addTab(), () => this.removeTab(), (k) => this.moveTab(k)),
    ];
    if (!tab) return out;
    out.push(box(tab, TAB_BOXES, "name"), box(tab, TAB_BOXES, "folder"));
    if (!tab.panes.length) out.push(box(tab, TAB_BOXES, "command"));
    out.push(
      label("Panes"),
      tab.panes.length
        ? v_flex().gap(3).children(tab.panes.map((x, j) => row(`pp-pane-${j}`, j === this.paneAt, [
          div().w(64).child(x.type),
          div().flex_1().min_w(0).child(x.type === "command" ? val(x, "command") : x.type === "agent" ? val(x, "agent") || "(no agent)" : ""),
          dim(j === 0 ? "" : x.direction || "down"),
        ], () => (this.paneAt = j))))
        : dim("No panes: the tab runs its command, or a plain shell"),
      moves("pane", () => this.addPane(), () => this.removePane(), (k) => this.movePane(k)),
      h_flex().pt(6).gap(6).items_center().flex_wrap().child(dim("Panes from:"))
        .children(this.layouts.filter((l) => Array.isArray(l.panes)).map((l, i) => act(`pp-fromlay-${i}`, l.label ?? l.name, () => this.panesFromLayout(l.name)))),
    );
    if (!pane) return out;
    out.push(
      label(`Pane ${this.paneAt + 1}`),
      h_flex().gap(6).items_center()
        .children(["agent", "shell", "command"].map((ty) => act(`pp-ptype-${ty}`, ty, () => this.setPaneType(ty), pane.type === ty)))
        .when(this.paneAt > 0, (el) => el.child(act("pp-pdir", `Direction: ${pane.direction || "down"}`, () => this.cycleDirection()))),
      box(pane, PANE_BOXES, "folder"),
    );
    if (pane.type === "command") out.push(box(pane, PANE_BOXES, "command"));
    if (pane.type === "agent") {
      const agent = this.boxFor(pane, "agent");
      const chip = (id, text, value, lead, faint) => act(id, text, () => { agent.set_value(value); pane.promptMode = /^hermes\b/.test(value) ? "send" : "arg"; }, agent.value().trim() === value, lead).when(faint, (el) => el.opacity(0.6));
      const send = pane.promptMode === "send";
      out.push(
        label("Agent"),
        h_flex().flex_wrap().gap(6)
          .child(chip("pp-agent-shell", "Shell", "", this.shellIcon(t, 14), false))
          .children(this.agents.map((a, i) => chip(`pp-agent-${i}`, a.name, a.run.join(" "), this.programIcon(t, a, 14), a.installed === false))),
        box(pane, PANE_BOXES, "agent"),
        box(pane, PANE_BOXES, "args"),
        box(pane, PANE_BOXES, "prompt"),
        h_flex().pt(8).gap(8).items_center()
          .child(act("pp-pmode", `Prompt: ${send ? "typed after start" : "command-line argument"}`, () => (pane.promptMode = send ? "arg" : "send")))
          .child(dim(send ? "for agents that reject a prompt argument" : "claude and most agents")),
      );
    }
    return out;
  }

  editSelected() {
    const r = this.selected();
    if (!r) return;
    const index = this.projects.indexOf(r.p);
    this.edit(r.p, index < 0 ? null : index);
  }

  /** ctrl/alt+U: opens the editor on a copy of the highlighted project (from the template: a new project with its settings). */
  duplicateSelected() {
    const r = this.selected();
    if (!r || this.mode !== "list") return;
    this.edit(duplicateProject(r.p, this.allProjects().map((p) => p.name)), null, r.p.template ? "fromTemplate" : "duplicate");
  }

  // ---- delete project ---------------------------------------------------

  /** First press asks, the second removes the project from the list (its folder and worktrees stay). */
  deleteSelected() {
    const r = this.selected();
    if (!r) return;
    if (this.pendingDelete !== r.p) { this.pendingDelete = r.p; this.error = null; return; }
    const list = this.projects.filter((p) => p !== r.p);
    this.pendingDelete = null;
    const template = Boolean(r.p.template);
    saveConfig(list, this.raw, template ? { hideTemplate: true } : {}).then((raw) => {
      this.raw = raw;
      this.projects = list;
      if (template) this.hideTemplate = true;
      this.syncTemplate();
      this.cx.notify();
    }).catch((e) => this.fail("delete project", e));
  }

  // ---- worktree cleanup -------------------------------------------------

  openWorktrees() {
    const r = this.selected();
    if (!r || r.p.template) return; // a template has no repository
    this.target = r.p;
    this.mode = "worktrees";
    this.wts = null;
    this.wtSel = new Set();
    this.wtAt = 0;
    this.wtConfirm = false;
    this.error = null;
    this.wtSearch = InputState.new({ placeholder: "Filter worktrees…" });
    this.wtSearch.on("change", (_e, cx) => { this.wtAt = 0; cx.notify(); });
    this.wtSearch.on("submit", () => { if (Date.now() - (this.handled ?? 0) > 200) this.toggleWt(); });
    this.wtSearch.focus();
    this.loadWorktrees();
  }

  loadWorktrees() {
    this.cx.spawn(async (cx) => {
      try { this.wts = await listWorktrees(this.target); } catch (e) { this.wts = []; logError("list worktrees", e); this.error = e.message; }
      this.afterWt?.();
      this.afterWt = null;
      cx.notify();
    });
  }

  wtRows() {
    const q = this.wtSearch?.value() ?? "";
    return (this.wts ?? []).filter((w) => fuzzy(q, `${w.branch ?? ""} ${basename(w.path)}`) >= 0);
  }

  toggleWt() {
    const w = this.wtRows()[this.wtAt];
    if (!w) return;
    this.wtConfirm = false;
    if (this.wtSel.has(w.path)) this.wtSel.delete(w.path); else this.wtSel.add(w.path);
  }

  selectMerged() {
    this.wtConfirm = false;
    const mergedClean = (this.wts ?? []).filter((w) => w.merged && !w.dirty && !w.locked);
    const all = mergedClean.every((w) => this.wtSel.has(w.path));
    for (const w of mergedClean) all ? this.wtSel.delete(w.path) : this.wtSel.add(w.path);
  }

  /** First press asks for confirmation, the second removes the ticked worktrees one by one. */
  removeSelected() {
    const chosen = (this.wts ?? []).filter((w) => this.wtSel.has(w.path));
    if (!chosen.length) return;
    if (!this.wtConfirm) { this.wtConfirm = true; return; }
    this.wtConfirm = false;
    this.error = null;
    this.cx.spawn(async (cx) => {
      const failed = [];
      for (const w of chosen) {
        try { await removeWorktree(this.target, w); log("debug", "removed worktree", { path: w.path }); } catch (e) { logError("remove worktree", e); failed.push(e.message); }
      }
      this.wtSel = new Set();
      this.error = failed.length ? failed.join("\n") : null;
      try { this.wts = await listWorktrees(this.target); } catch {}
      cx.notify();
    });
  }

  // ---- import and export of the config -----------------------------------------------

  openBackup() {
    this.mode = "backup";
    this.error = null;
    this.backupNote = null;
    this.backupConfirm = null; // "overwrite" | "replace": the second click does it
    const fresh = `${EXPORT_DIR}/${exportFileName()}`;
    if (this.backupPath) this.backupPath.set_value(fresh);
    else {
      this.backupPath = InputState.new({ value: fresh });
      this.backupPath.on("change", (_e, cx) => { this.backupConfirm = null; cx.notify(); });
    }
    this.backupPath.focus();
  }

  backupFile() { return expandHome(this.backupPath.value().trim(), homeOf()); }

  setNote(text, bad = false) {
    this.backupNote = { text, bad };
    this.cx.notify();
  }

  /** Writes the project list, the layouts and the settings to the file in the box. An existing file is only replaced after a second click. */
  async exportBackup() {
    try {
      const path = this.backupFile();
      if (!path) return this.setNote("Type where to save the file.", true);
      const existing = await readTextFile(path);
      if (existing != null && this.backupConfirm !== "overwrite") {
        this.backupConfirm = "overwrite";
        return this.setNote(`${shortHome(path, homeOf())} already exists. Click Export again to replace it.`, true);
      }
      const data = exportData({ projects: this.projects, layouts: this.userLayouts, gitInfo: this.gitInfo, hideTemplate: this.hideTemplate }, homeOf());
      await writeTextFile(path, JSON.stringify(data, null, 2) + "\n", existing);
      this.backupConfirm = null;
      this.setNote(`Exported ${data.projects.length} project(s) and ${data.layouts.length} layout(s) to ${shortHome(path, homeOf())}. Paths under your home folder are saved as ~.`);
    } catch (e) {
      logError("export", e);
      this.setNote(`Export failed: ${e.message}`, true);
    }
  }

  /** Reads the file in the box. "merge" adds what is missing and keeps yours; "replace" swaps everything for the backup, after a
   *  second click and with your current file saved as <data file>.bak first. */
  async importBackup(how) {
    try {
      const path = this.backupFile();
      const text = path ? await readTextFile(path) : null;
      if (text == null) return this.setNote(`There is no file at ${shortHome(path || "(nothing typed)", homeOf())}.`, true);
      const backup = parseBackup(text);
      const bak = `${dataFilePath()}.bak`;
      let summary;
      let added;
      if (how === "replace") {
        if (this.backupConfirm !== "replace") {
          this.backupConfirm = "replace";
          return this.setNote(`This replaces your ${this.projects.length} project(s) with the file's ${backup.projects.length}. Your current file is saved as ${shortHome(bak, homeOf())} first. Click Import: replace again to go on.`, true);
        }
        await writeTextFile(bak, this.raw ?? "{}\n", await readTextFile(bak));
        this.raw = await saveConfig(backup.projects, this.raw, { layouts: backup.layouts, gitInfo: backup.gitInfo, hideTemplate: backup.hideTemplate });
        this.applyConfig(backup.projects, backup.layouts, backup.gitInfo, backup.hideTemplate);
        added = backup.projects;
        summary = `Replaced everything with the file: ${backup.projects.length} project(s), ${backup.layouts.length} layout(s). Your previous file is saved as ${shortHome(bak, homeOf())}.`;
      } else {
        const merged = mergeProjects(this.projects, backup.projects);
        const layouts = mergeLayouts(this.userLayouts, backup.layouts);
        this.raw = await saveConfig(merged.projects, this.raw, { layouts: layouts.layouts });
        added = merged.projects.filter((p) => !this.projects.includes(p));
        this.applyConfig(merged.projects, layouts.layouts, this.gitInfo, this.hideTemplate);
        summary = `Merged: ${merged.added} project(s) added, ${merged.skipped} already here${layouts.added ? `, ${layouts.added} layout(s) added` : ""}.`;
      }
      this.backupConfirm = null;
      const missing = [];
      for (const p of added) if (!p.template && p.path && !(await folderExists(expandHome(p.path, homeOf())))) missing.push(p.name);
      this.setNote(missing.length ? `${summary} ${missing.length} folder(s) don't exist on this machine: ${missing.slice(0, 5).join(", ")}${missing.length > 5 ? "…" : ""}. Go back (${backKey()}), then press ${key("e")} on each to fix its folder.` : summary);
    } catch (e) {
      logError("import", e);
      this.setNote(`Import failed: ${e.message}`, true);
    }
  }

  /** Makes a restored or merged project list the current one. */
  applyConfig(projects, layouts, gitInfo, hideTemplate) {
    this.projects = projects;
    this.userLayouts = layouts;
    this.layouts = allLayouts(layouts);
    this.gitInfo = gitInfo;
    this.hideTemplate = hideTemplate;
    this.syncTemplate();
    this.info = {};
    this.at = 0;
    if (this.gitInfo) this.loadInfo(this.cx);
  }

  async browseBackup() {
    const dir = await pickFolder({ prompt: "Save the export here" });
    if (!dir) return;
    const name = this.backupFile().split("/").pop() || "projects-backup.json";
    this.backupPath.set_value(`${dir}/${name}`);
    this.cx.notify();
  }

  renderBackup(t, cx) {
    const confirmAction = this.backupConfirm;
    return v_flex().gap(10)
      .child(this.title(t, "Import and export config", `${backKey()} back · Esc closes`))
      .child(div().text_size(12).text_color(t.dim).child("Export saves your project list, layouts and settings to one file. Import brings them back, on this machine or another. Paths under your home folder are saved as ~, so an exported file works on a machine with a different user name."))
      .child(div().text_size(11.5).text_color(t.dim).child("File"))
      .child(h_flex().gap(8).items_center()
        .child(h_flex().flex_1().h(36).px(10).items_center().rounded(9).border_1().border_color(t.accent).bg(t.background)
          .child(Input.new(this.backupPath).flex_1().h_full().text_size(12.8).text_color(t.foreground)))
        .child(this.button(t, "pp-bk-browse", "Browse…", false, () => this.browseBackup())))
      .child(h_flex().gap(8).items_center().flex_wrap()
        .child(this.button(t, "pp-bk-export", confirmAction === "overwrite" ? "Click again to replace the file" : "Export", true, () => this.exportBackup()))
        .child(this.button(t, "pp-bk-merge", "Import: merge", false, () => this.importBackup("merge")))
        .child(this.button(t, "pp-bk-replace", confirmAction === "replace" ? "Click again to replace everything" : "Import: replace", false, () => this.importBackup("replace"))))
      .child(div().text_size(11).text_color(t.dim).child("Merge adds the projects you don't have and keeps yours. Replace swaps everything for the file, after a second click, and first saves your current file as projects.json.bak."))
      .when(Boolean(this.backupNote), (el) => el.child(div().text_size(12).text_color(this.backupNote.bad ? t.blocked : t.done).child(this.backupNote.text)))
      .child(h_flex().justify_end().child(this.button(t, "pp-bk-back", "Back", false, () => { this.mode = "list"; this.search.focus(); cx.notify(); })));
  }

  // ---- keys -------------------------------------------------------------

  keys(e, cx) {
    const k = e.key;
    const ctrl = e.modifiers.control;
    const mod = ctrl || e.modifiers.alt || e.modifiers.platform; // ctrl, alt or cmd
    const layoutMod = e.modifiers.alt && (ctrl || e.modifiers.platform);
    if (this.pendingDelete && k !== "d") this.pendingDelete = null;
    // herdr never passes Esc to a popup, so this is the way back. (Not a bracket key: herdr binds alt-[ and alt-] to tabs.)
    const back = k === "b" && mod;
    if (k === "escape" || back) {
      if (this.mode === "list") { if (back) return; this.dismiss(); }
      else if (this.mode === "busy" && !this.error) return;
      else { this.mode = "list"; this.error = null; this.search.focus(); }
    } else if (this.mode === "list") {
      const n = this.rows().length;
      if (k === "down" && n) { this.at = (this.at + 1) % n; this.revealRow(); }
      else if (k === "up" && n) { this.at = (this.at + n - 1) % n; this.revealRow(); }
      else if (k === "enter" && e.modifiers.shift) { this.handled = Date.now(); this.activate(true); }
      else if (k === "d" && mod) this.deleteSelected();
      else if (k === "w" && mod) this.openWorktrees();
      else if (k === "n" && mod) this.edit(this.newProject(), null);
      else if (k === "u" && mod) this.duplicateSelected();
      else if (k === "x" && mod) this.openBackup();
      else if (k === "l" && layoutMod) this.cycleLayout(this.selected()?.p ?? blankProject());
      else if (k === "i" && layoutMod) this.toggleDetail();
      else if (k === "e" && mod) this.editSelected();
      else return;
    } else if (this.mode === "launch") {
      if (k === "l" && layoutMod) this.cycleLayout(this.target);
      else if (k === "t" && layoutMod && this.launchHasSetup()) this.launch.agentTiming = this.launch.agentTiming === "after" ? "with" : "after";
      else if (k === "enter" && ctrl) { this.handled = Date.now(); this.launchNow(); }
      else return;
    }
    else if (this.mode === "worktrees") {
      const n = this.wtRows().length;
      if (k === "down" && n) { this.wtAt = (this.wtAt + 1) % n; this.reveal("pp-worktrees", this.wtScroll, this.wtAt); }
      else if (k === "up" && n) { this.wtAt = (this.wtAt + n - 1) % n; this.reveal("pp-worktrees", this.wtScroll, this.wtAt); }
      else if (k === "enter") { this.handled = Date.now(); this.toggleWt(); }
      else if (k === "m" && mod) this.selectMerged();
      else if (k === "r" && mod) this.removeSelected();
      else return;
    } else if (this.mode === "edit" && k === "tab") this.focusNextField(e.modifiers.shift);
    else if (this.mode === "edit" && k === "s" && mod) this.save(cx);
    else return;
    cx.stop_propagation();
    cx.notify();
  }

  // ---- render -----------------------------------------------------------

  render() {
    const cx = this.cx;
    const t = theme();
    this.frame = null;
    this.frame = { rows: this.mode === "list" ? this.rows() : [] };
    let body;
    try {
      body = { list: () => this.renderList(t, cx), edit: () => this.renderEdit(t, cx), worktrees: () => this.renderWorktrees(t, cx), backup: () => this.renderBackup(t, cx), launch: () => this.renderLaunch(t, cx), busy: () => this.renderBusy(t) }[this.mode]();
    } finally {
      this.frame = null;
    }
    return v_flex().id("projects").track_focus(this.handle).w_full().min_h(0).p(18).gap(10).bg(t.popover).text_size(13)
      .on_key_down(this.guard("key", (e, cx) => { log("debug", "key", { key: e.key, mods: e.modifiers, mode: this.mode }); this.keys(e, cx); }))
      .child(body);
  }

  /** A scrolling list of 48px rows: wheel and scrollbar work, and `reveal` keeps the highlight in view. */
  vlist(id, rows, render, handle, max, keyOf, onClick, sizes = null) {
    const total = sizes ? sizes.reduce((a, b) => a + b, 0) : rows.length * ROW;
    const height = Math.min(max, total);
    this.ranges[id] = { ...(this.ranges[id] ?? { start: 0, end: 0 }), visible: Math.max(1, Math.floor(height / ROW)) };
    return div().relative().flex_none().w_full().h(height).min_h(0)
      .child(v_virtual_list(id, rows.length, sizes ?? ROW, (i) => keyOf(rows[i], i), (range) => {
        Object.assign(this.ranges[id], { start: range.start, end: range.end });
        return rows.slice(range.start, range.end).map((r, j) => render(r, range.start + j));
      }).track_scroll(handle).on_item_click(this.guard("row click", (key, cx) => onClick(key, cx))).size_full())
      .when(total > height, (el) => el.child(Scrollbar.vertical(id).viewport_from_layout().absolute().inset_0()));
  }

  /** Keeps the highlighted project in view (section headers count as list items). When it is above what is showing and a
   *  section header sits right over it, the header is brought into view instead, so the row comes with its header. */
  revealRow() {
    const items = listItems(this.rows(), Boolean(this.query()));
    const at = items.findIndex((it) => it.row && it.index === this.at);
    if (at < 0) return;
    const r = this.ranges["pp-projects"];
    this.reveal("pp-projects", this.scroll, r && at < r.start && items[at - 1]?.header ? at - 1 : at);
  }

  /** Brings list item `at` into view. herdr's scroll_to_item means "put this item on screen": it does nothing when the item
   *  is already showing and scrolls just far enough when it is not. (Asking for an item that is already on screen, as the
   *  old code did to land `at` at the bottom, scrolled nothing.) */
  reveal(_id, handle, at) {
    handle.scroll_to_item(at);
  }

  button(t, id, text, primary, action, lead = null) {
    return h_flex().id(id).gap(lead ? 6 : 0).h(32).px(14).items_center().rounded(8).border_1()
      .border_color(primary ? t.solid : t.input).bg(primary ? t.solid : t.raised)
      .text_color(primary ? t.solid_foreground : t.foreground).text_size(12.5).font_medium().cursor_pointer()
      .on_click(this.guard(`button ${id}`, (...a) => { log("debug", "click", { id }); return action(...a); }))
      .when(Boolean(lead), (el) => el.child(lead)).child(text);
  }

  title(t, text, hint) {
    return h_flex().items_center().child(div().flex_1().text_size(15).font_semibold().text_color(t.foreground).child(text))
      .child(div().text_size(11).text_color(t.dim).child(hint));
  }

  /** The project's avatar, drawn like herdr's sidebar draws a space's: a tile in the space's own color with the
   *  initial. A project with no open space gets an outline in no color. */
  avatar(t, p, space, size = 18) {
    const tile = h_flex().size(size).flex_none().rounded(5).items_center().justify_center().text_size(size * 0.58).font_bold();
    const initial = [...(p.name ?? "")][0]?.toUpperCase() ?? "?";
    if (!space) return tile.border_1().border_color(t.input).text_color(t.dim).child(initial);
    return tile.bg(spaceColor(this.snap.colors, space.id, t)).text_color("#ffffff").child(initial);
  }

  /** A small outlined label. */
  tag(t, text, color, border = color) {
    return div().px(8).rounded(10).border_1().border_color(border).text_size(10.5).text_color(color).flex_none().child(text);
  }

  /** The selected project's mini picture of a layout's panes: the agent's pane lit when this is the one chosen. */
  layoutThumb(t, layout, on, w = 72, h = 38) {
    const box = div().relative().w(w).h(h).flex_none();
    layoutRects(layout).forEach((r, i) => box.child(div().absolute().left(r.x * w + 1).top(r.y * h + 1).w(r.w * w - 2).h(r.h * h - 2).rounded(3).bg(i === 0 && on ? t.accent : on ? t.selected : t.input)));
    return box;
  }

  /** Worktrees, Edit and Delete for the highlighted project: in the detail card, or under the list without it. */
  actionButtons(t, cx) {
    return h_flex().gap(8).items_center().flex_wrap()
      .child(this.button(t, "pp-dup", "Duplicate", false, () => { this.duplicateSelected(); cx.notify(); }))
      .when(!this.selected()?.p.template, (el) => el.child(this.button(t, "pp-wt", "Worktrees", false, () => { this.openWorktrees(); cx.notify(); })))
      .child(this.button(t, "pp-edit", "Edit", false, () => { this.editSelected(); cx.notify(); }))
      .child(this.button(t, "pp-delete", this.pendingDelete ? "Delete?" : "Delete", false, () => { this.deleteSelected(); cx.notify(); }));
  }

  /** The detail card: what the highlighted project is, what Enter will do, and the layout choice. */
  /** The card for the template row: what it is, the settings a project made from it starts with, and its buttons. */
  renderTemplateCard(t, card, r, cx) {
    const p = r.p;
    const name = commandName(firstAgent(p.startup.tabs)?.pane.agent);
    const program = name && this.allAgents.find((a) => a.key === name || commandName((a.run ?? []).join(" ")) === name);
    const kv = (k, v) => h_flex().gap(10).text_size(12).text_color(t.foreground).child(div().w(84).text_color(t.dim).child(k)).child(v);
    return card
      .child(h_flex().gap(10).items_center()
        .child(this.avatar(t, p, null, 24))
        .child(div().text_size(16).font_semibold().text_color(t.foreground).child(p.name))
        .child(this.tag(t, "template", t.accent)))
      .child(div().text_size(12).text_color(t.dim).child(`Not a real project: it has no folder. Edit it (${key("e")}) to set the defaults you want, then use it to make projects. Add project starts from it once you have saved it.`))
      .child(v_flex().gap(3)
        .child(kv("Agent", program?.name ?? (name || "plain shell")))
        .child(kv("Tabs", tabLabels(p.startup.tabs).join(" · ")))
        .child(kv("Worktrees", enterAction(p.worktree.mode)[0]))
        .when(Boolean(p.group), (el) => el.child(kv("Group", p.group))))
      .child(h_flex().gap(8).items_center().flex_wrap()
        .child(this.button(t, "pp-use", "Use template", true, () => { this.duplicateSelected(); cx.notify(); })));
  }

  renderCard(t, r, cx) {
    const card = v_flex().w(CARD).flex_none().gap(10).p(14).rounded(12).border_1().border_color(t.input).bg(t.raised);
    if (!r) return card.child(div().text_color(t.dim).text_size(12).child("Nothing selected."));
    const p = r.p;
    if (p.template) return this.renderTemplateCard(t, card, r, cx);
    const folder = projectFolder(p);
    const info = this.info[folder];
    const name = commandName(firstAgent(p.startup.tabs)?.pane.agent);
    const program = name && this.allAgents.find((a) => a.key === name || commandName((a.run ?? []).join(" ")) === name);
    const kv = (k, v) => h_flex().gap(10).items_start().text_size(12)
      .child(div().w(84).flex_none().text_color(t.dim).child(k))
      .child(div().flex_1().min_w(0).text_color(t.foreground).child(v));
    const current = this.layoutNameFor(p);
    const choices = [{ name: "", label: "Project's tabs", panes: p.startup.tabs[0]?.panes ?? [] }, ...this.layouts];
    const [what, openLabel] = enterAction(p.worktree.mode);
    const shown = choices.find((c) => c.name === current);
    const dirtyText = info == null ? "…" : info.dirty ? `${info.dirty} file${info.dirty > 1 ? "s" : ""} modified` : "clean";
    return card
      .child(h_flex().gap(10).items_center().flex_wrap()
        .child(this.avatar(t, p, r.space, 24))
        .child(div().text_size(16).font_semibold().text_color(t.foreground).child(p.name))
        .when(Boolean(r.space), (el) => el.child(this.tag(t, r.space.status === "working" ? "agent working" : "open", r.space.status === "working" ? t.working : t.done)))
        .when(p.pinned, (el) => el.child(this.tag(t, "pinned", t.dim, t.input))))
      .child(v_flex().gap(4)
        .when(Boolean(p.description), (el) => el.child(div().text_size(12).text_color(t.dim).child(p.description)))
        .child(kv("Agent", h_flex().gap(6).items_center().child(this.agentIcon(t, p, 14)).child(div().child(program?.name ?? (name || "plain shell")))))
        .child(kv("Tabs", tabLabels(p.startup.tabs).join(" · ")))
        .when(Boolean(p.group), (el) => el.child(kv("Group", p.group)))
        .when(this.gitInfo, (el) => el.child(kv("Branch", info?.branch ?? "…")).child(kv("Changes", info?.dirty ? div().text_color(t.working).child(dirtyText) : dirtyText)).child(kv("Worktrees", info == null ? "…" : String(info.worktrees))))
        .child(kv("Last opened", ago(this.snap.recent[p.path]))))
      .child(v_flex().gap(6)
        .child(h_flex().items_center().child(div().flex_1().text_size(10.5).font_semibold().text_color(t.dim).child(`LAYOUT${this.layoutPick !== null ? " · PICKED" : ""}`))
          .child(div().px(6).rounded(5).border_1().border_color(t.input).text_size(10.5).text_color(t.foreground).child(LAYOUT_HINT())))
        .child(h_flex().gap(8).items_start().flex_wrap().children(choices.map((c, i) => {
          const on = c.name === current;
          const lit = on && this.layoutLit;
          return v_flex().id(`pp-lay-${i}`).gap(4).p(6).rounded(9).border_1().cursor_pointer()
            .border_color(on ? (lit ? t.accent : t.solid) : t.input).bg(on ? t.selected : t.background)
            .on_click(this.guard("layout click", () => { this.layoutPick = c.name === "" ? null : c.name; cx.notify(); }))
            .child(this.layoutThumb(t, c, on))
            .child(div().text_size(10.5).max_w(72).text_color(on ? t.foreground : t.dim).when(on, (el) => (lit ? el.font_bold() : el.font_semibold())).child(c.label ?? c.name))
            .when(c.name === "", (el) => el.child(div().text_size(9.5).text_color(t.dim).child("project default")));
        }))))
      .child(div().text_size(12).text_color(t.dim).child(`Enter ${what}${shown && shown.name ? ` and opens ${(shown.label ?? shown.name).toLowerCase()}` : " and opens the project's tabs"}.`))
      .child(h_flex().gap(8).items_center()
        .child(this.button(t, "pp-open", openLabel, true, () => { this.activate(false); cx.notify(); }))
        .child(this.button(t, "pp-checkout", "Checkout", false, () => { this.activate(true); cx.notify(); })));
  }

  /** Under the list: the hints and the layout choice, then the buttons. With the card its buttons are in the card, so
   *  only Hide details and Add project share the hints' row; without it the hints get a row of their own. */
  /** The row of buttons under the search box: Add project, then what acts on the highlighted project (named at the
   *  right), then the import/export screen and the card toggle. */
  renderToolbar(t, cx, rows) {
    const sel = this.selected();
    return h_flex().gap(8).items_center().flex_wrap()
      .child(this.button(t, "pp-add", "Add project", true, () => { this.edit(this.newProject(), null); cx.notify(); }))
      .when(rows.length > 0, (el) => el.child(this.actionButtons(t, cx)))
      .child(div().flex_1().min_w(0).truncate().text_size(11).text_color(t.dim).when(Boolean(sel), (e) => e.child(`acts on ${sel.p.name}`)))
      .child(this.button(t, "pp-backup", "Import / export…", false, () => { this.openBackup(); cx.notify(); }))
      .child(this.button(t, "pp-launcher", this.snap.launcherInLayout ? `Launcher: ${LAUNCHERS.find(([k]) => k === this.snap.launcher)?.[1]}` : "Launcher: add to layout", false, () => { this.cycleLauncher(); cx.notify(); }))
      .child(this.button(t, "pp-details", this.detail ? "Hide details" : "Show details", false, () => { this.toggleDetail(); cx.notify(); }));
  }

  listFooter(t) {
    return this.footer(t, this.selected()?.p ?? blankProject(), true);
  }

  renderList(t, cx) {
    const rows = this.rows();
    if (this.at >= rows.length) this.at = Math.max(0, rows.length - 1);
    const projectKey = (r) => `${r.p.name}\u0000${r.p.path}`;
    const items = listItems(rows, Boolean(this.query()));
    const stripe = (r) => (r.space ? (t[r.space.status] ?? t.done) : null);
    const row = (r, i) => {
      const on = i === this.at;
      const info = this.info[projectFolder(r.p)];
      return h_flex().id(`pp-${i}`).relative().w_full().h(ROW).flex_none().overflow_hidden().pl(14).pr(12).gap(10).items_center().rounded(8).cursor_pointer()
        .when(on, (el) => el.bg(t.selected))
        .when(Boolean(r.space), (el) => el.child(div().absolute().left(0).top(9).w(3).h(ROW - 18).rounded(2).bg(stripe(r))
          .when(r.space.status === "working", (e) => e.loop("opacity", { from: 1, to: 0.35, period: 1000 }))))
        .child(this.avatar(t, r.p, r.space))
        .child(this.agentIcon(t, r.p))
        .child(v_flex().flex_1().min_w(0)
          .child(this.nameText(t, r.p.name))
          .child(div().text_size(11).text_color(t.dim).truncate().child(r.p.template ? "A starting point: press Enter to make a project from it" : shortHome(projectFolder(r.p), homeOf()))))
        .when(Boolean(r.p.template), (el) => el.child(this.tag(t, "template", t.accent)))
        .when(Boolean(r.p.group), (el) => el.child(div().text_size(11).text_color(t.dim).child(r.p.group)))
        .when(Boolean(info), (el) => el.child(h_flex().gap(5).flex_none()
          .child(this.tag(t, info.branch, t.dim, t.input))
          .when(info.dirty > 0, (e) => e.child(this.tag(t, `${info.dirty} changed`, t.working)))
          .when(info.worktrees > 0, (e) => e.child(this.tag(t, `${info.worktrees} wt`, t.accent)))));
    };
    const item = (it, i) => it.header
      ? div().w_full().h(HEADER).flex_none().px(14).pb(3).flex().items_end().text_size(10.5).font_semibold().text_color(t.dim).child(it.header.toUpperCase())
      : row(it.row, it.index);
    const list = this.vlist("pp-projects", items, item, this.scroll, this.detail ? 420 : 330, // shorter without the card: its footer is three rows tall
       (it) => (it.header ? `header:${it.header}` : projectKey(it.row)), (key, cx) => {
      const i = rows.findIndex((r) => projectKey(r) === key);
      if (i < 0) return;
      const double = this.lastClick?.key === key && Date.now() - this.lastClick.at < 450;
      this.lastClick = { key, at: Date.now() };
      log("debug", "click row", { i, double });
      this.at = i;
      if (double) this.activate(false); else cx.notify();
    }, items.map((it) => (it.header ? HEADER : ROW)));
    return v_flex().gap(10).min_h(0)
      .child(this.title(t, "Projects", "Esc"))
      .child(h_flex().h(36).flex_none().px(10).items_center().rounded(9).border_1().border_color(t.accent).bg(t.background)
        .child(Input.new(this.search).flex_1().h_full().text_size(12.8).text_color(t.foreground))
        .child(div().text_size(11).text_color(t.dim).child(`${rows.length} of ${this.allProjects().length}`)))
      .child(this.renderToolbar(t, cx, rows))
      .child(this.error ? div().text_size(12).text_color(t.blocked).child(this.error) : div())
      .child(h_flex().gap(14).items_start().min_h(0)
        .child(v_flex().flex_1().min_w(0).gap(6)
          .child(list)
          .when(!rows.length, (el) => el.child(div().py(14).text_color(t.dim).child("No project matches.")))
          .when(!this.query() && !this.projects.some((p) => !p.template), (el) => el.child(div().py(8).px(14).text_size(12).text_color(t.dim).child(this.virtualTemplate || this.projects.some((p) => p.template)
            ? "No projects yet. Edit the Template to suit you ({e}), then press Enter on it to make your first project, or click Add project.".replace("{e}", key("e"))
            : "No projects yet. Click Add project and choose a git checkout."))))
        .when(this.detail, (el) => el.child(this.renderCard(t, this.selected(), cx))))
      .when(Boolean(this.pendingDelete), (el) => el.child(div().text_size(12).text_color(t.blocked).child(this.pendingDelete.template
        ? `Remove the template? Press ${key("d")} again or click Delete. To bring it back later, delete "hideTemplate" from projects.json.`
        : `Remove "${this.pendingDelete.name}" from the list? Press ${key("d")} again or click Delete. The folder and its worktrees stay.`)))
      .child(this.listFooter(t));
  }

  renderWorktrees(t, cx) {
    const rows = this.wtRows();
    if (this.wtAt >= rows.length) this.wtAt = Math.max(0, rows.length - 1);
    const count = this.wtSel.size;
    const row = (w, i) => h_flex().id(`pp-wt-${i}`).w_full().h(48).flex_none().overflow_hidden().px(12).gap(10).items_center().rounded(8).cursor_pointer()
      .when(i === this.wtAt, (el) => el.bg(t.selected))
      .child(div().w(14).flex_none().text_color(this.wtSel.has(w.path) ? t.accent : t.dim).child(this.wtSel.has(w.path) ? "☑" : "☐"))
      .child(v_flex().flex_1().min_w(0)
        .child(div().text_color(t.foreground).font_medium().truncate().child(w.branch ?? "(detached)"))
        .child(div().text_size(11).text_color(t.dim).truncate().child(shortHome(w.path, homeOf()))))
      .when(Boolean(w.space), (el) => el.child(div().text_size(11).text_color(t.dim).child("open")))
      .when(w.dirty, (el) => el.child(div().text_size(11).text_color(t.blocked).child("uncommitted")))
      .when(w.locked, (el) => el.child(div().text_size(11).text_color(t.blocked).child("locked")))
      .child(div().text_size(11).text_color(w.merged ? t.done : t.dim).child(w.merged ? "merged" : "unmerged"));
    return v_flex().gap(10).min_h(0)
      .child(this.title(t, `Worktrees · ${this.target.name}`, `${backKey()} back · Esc closes`))
      .child(h_flex().h(36).flex_none().px(10).items_center().rounded(9).border_1().border_color(t.accent).bg(t.background)
        .child(Input.new(this.wtSearch).flex_1().h_full().text_size(12.8).text_color(t.foreground)))
      .when(Boolean(this.error), (el) => el.child(div().text_size(12).text_color(t.blocked).child(this.error)))
      .child(this.vlist("pp-worktrees", rows, row, this.wtScroll, 340, (w) => w.path, (key, cx) => {
        const i = rows.findIndex((w) => w.path === key);
        if (i < 0) return;
        this.wtAt = i;
        this.toggleWt();
        cx.notify();
      }))
      .when(this.wts === null, (el) => el.child(div().py(14).text_color(t.dim).child("Looking at worktrees…")))
      .when(this.wts !== null && !rows.length, (el) => el.child(div().py(14).text_color(t.dim).child(this.wts.length ? "No worktree matches." : "No worktrees besides the main checkout.")))
      .when(this.wtConfirm, (el) => el.child(div().text_size(12).text_color(t.blocked).child(`Remove ${count} worktree${count > 1 ? "s" : ""}${[...(this.wts ?? [])].some((w) => this.wtSel.has(w.path) && w.space) ? ", and close their spaces" : ""}? Merged branches are deleted too. Press ${key("r")} again or click.`)))
      .child(div().text_size(11).text_color(t.dim).child(`Enter tick · ${key("m")} tick all merged · ${key("r")} remove ticked. Worktrees with uncommitted changes are refused.`))
      .child(h_flex().gap(8).items_center().justify_end()
        .child(this.button(t, "pp-wt-merged", "Tick merged", false, () => { this.selectMerged(); cx.notify(); }))
        .child(this.button(t, "pp-wt-remove", this.wtConfirm ? `Click again to remove ${count}` : `Remove ${count} ticked`, count > 0, () => { this.removeSelected(); cx.notify(); })));
  }

  /** The launch screen: flat rows of a label and its control. */
  renderLaunch(t, cx) {
    const p = this.target, l = this.launch;
    const row = (label, control) => h_flex().gap(10).items_start()
      .child(div().w(64).flex_none().pt(8).text_size(12).text_color(t.dim).child(label))
      .child(v_flex().flex_1().min_w(0).gap(4).child(control));
    const note = (text) => div().text_size(FOOTER_SIZE).text_color(t.dim).child(text);
    const openAs = (worktree) => () => { this.setOpenAs(worktree); cx.notify(); };
    const setup = this.launchHasSetup();
    return v_flex().gap(10)
      .child(this.title(t, `Open · ${p.name}`, `${backKey()} back · Esc closes`))
      .child(row("Open as", h_flex().gap(8)
        .child(this.button(t, "pp-open-worktree", "Worktree", l.worktree, openAs(true)))
        .child(this.button(t, "pp-open-checkout", "Checkout", !l.worktree, openAs(false)))))
      .when(l.worktree && Boolean(this.nameInput), (el) => el.child(row("Branch", v_flex().gap(4)
        .child(h_flex().h(36).px(10).items_center().rounded(9).border_1().border_color(t.accent).bg(t.background)
          .child(Input.new(this.nameInput).flex_1().h_full().text_size(12.8).text_color(t.foreground)))
        .child(div().text_size(12).text_color(this.error ? t.blocked : t.dim).child(this.error ?? (this.preview ? `branch: ${this.preview}` : "")))
        .child(note(`from ${p.git.remote}/${p.git.base}${p.git.fetch ? " after a fetch" : ""} · Enter launches`)))))
      .child(row("Prompt", v_flex().gap(4)
        .child(div().px(10).py(6).rounded(9).border_1().border_color(t.input).bg(t.background)
          .child(Textarea.new(this.promptBox).w_full().text_size(12.8).text_color(t.foreground)))
        .child(note("Enter: newline · ctrl+⏎ launches"))))
      .when(setup, (el) => el.child(row("Agent", h_flex().gap(8).items_center()
        .child(this.button(t, "pp-timing-launch", l.agentTiming === "after" ? "Agent: after setup" : "Agent: with setup", false, () => { l.agentTiming = l.agentTiming === "after" ? "with" : "after"; cx.notify(); }))
        .child(div().px(6).rounded(5).border_1().border_color(t.input).bg(t.raised).text_size(10.5).text_color(t.foreground).child(mac() ? "⌘⌥T" : "ctrl+alt+T")))))
      .child(this.footer(t, p, false))
      .child(h_flex().justify_end().child(this.button(t, "pp-launch", "Launch", true, () => { this.launchNow(); cx.notify(); })));
  }

  /** The busy screen's steps: done ones get a ✓, the current one a spinner (or a ✗ once it failed). */
  stepRows(t) {
    const notes = this.notes.length ? this.notes : ["Starting…"];
    const mark = (i) => {
      const last = i === notes.length - 1;
      if (!last) return div().text_color(t.done).child("✓");
      if (this.error) return div().text_color(t.blocked).child("✗");
      return div().text_color(t.accent).frames(["⠋", "⠙", "⠹", "⠸", "⠼", "⠴", "⠦", "⠧", "⠇", "⠏"], 80).child("⠋");
    };
    return notes.map((n, i) => h_flex().gap(8).items_baseline().text_size(12)
      .child(mark(i).w(12).flex_none())
      .child(div().flex_1().min_w(0).text_color(i === notes.length - 1 && !this.error ? t.foreground : t.dim).child(n)));
  }

  renderBusy(t) {
    return v_flex().gap(8)
      .child(this.title(t, this.target.name, this.error ? "Esc back" : "working…"))
      .child(v_flex().gap(3).children(this.stepRows(t)))
      .when(Boolean(this.error), (el) => el.child(div().text_size(12.5).text_color(t.blocked).child(this.error)));
  }

  renderEdit(t, cx) {
    const d = this.draft;
    const label = (text, note) => h_flex().gap(8).items_baseline().pt(10).pb(5)
      .child(div().text_size(11.5).text_color(t.dim).child(text))
      .when(Boolean(note), (el) => el.child(div().text_size(10.5).text_color(t.muted ?? t.dim).child(note)));
    this.fieldOrder = []; // the boxes in the order shown, for Tab (see focusNextField)
    const input = (state, name, note) => {
      this.fieldOrder.push(state);
      return v_flex().child(label(name, note))
        .child(Input.new(state).h(34).px(10).rounded(8).border_1().border_color(this.focused === state ? t.accent : t.input).bg(t.background).text_size(12.8).text_color(t.foreground));
    };
    const field = (key) => {
      const [, name, , , note] = TEXT.find(([k]) => k === key);
      return input(this.fieldState(key), name, note);
    };
    const toggle = (id, text, value, set) => this.button(t, id, `${value ? "✓" : "○"} ${text}`, false, () => { set(!value); cx.notify(); });
    const sections = {
      project: () => [
        field("name"),
        field("path"),
        h_flex().pt(6).gap(8).child(this.button(t, "pp-browse", "Browse…", false, () => this.browse(cx))),
        field("group"),
        field("description"),
        h_flex().pt(10).child(toggle("pp-pin", "Pin to top", d.pinned, (v) => (d.pinned = v))),
      ],
      worktree: () => [
        h_flex().pt(10).gap(8).items_center()
          .child(this.button(t, "pp-mode", `Worktree: ${d.worktree.mode}`, false, () => { d.worktree.mode = MODES[(MODES.indexOf(d.worktree.mode) + 1) % MODES.length]; cx.notify(); }))
          .child(div().text_size(11.5).text_color(t.dim).child(MODE_HELP[d.worktree.mode])),
        field("branchTemplate"),
        field("root"),
        field("spaceName"),
        h_flex().pt(12).gap(8).items_center()
          .child(toggle("pp-repospace", "Open the repo's space first", d.worktree.repoSpace, (v) => (d.worktree.repoSpace = v)))
          .child(div().flex_1().min_w(0).text_size(11.5).text_color(t.dim).child("worktrees then nest under it in the sidebar")),
      ],
      git: () => [
        h_flex().pt(10).gap(8)
          .child(toggle("pp-fetch", "Fetch first", d.git.fetch, (v) => (d.git.fetch = v)))
          .child(toggle("pp-ff", "Fast-forward checkout", d.git.fastForward, (v) => (d.git.fastForward = v))),
        field("remote"),
        field("base"),
      ],
      startup: () => this.renderTabs(t, cx, field, input, label),
    };
    return v_flex().gap(0).min_h(0)
      .child(this.title(t, { add: "Add project", edit: "Edit project", duplicate: "Duplicate project", template: "Edit template", fromTemplate: "New project from the template" }[this.editKind ?? "add"], `Tab next field · ${key("s", "ctrl")} save · ${backKey()} back · Esc closes`))
      .child(h_flex().pt(10).gap(6)
        .children(SECTIONS.map(([id, name]) => this.button(t, `pp-sec-${id}`, name, this.section === id, () => this.showSection(id)))))
      .child(v_flex().min_h(0).h(430).overflow_y_scrollbar().pr(8).children(sections[this.section]()))
      .child(this.error ? div().pt(8).text_size(12).text_color(t.blocked).child(this.error) : div())
      .child(h_flex().pt(12).gap(8).justify_end()
        .when(this.index != null, (el) => el.child(this.button(t, "pp-del", this.confirmDelete ? "Click again to delete" : "Delete", false, () => this.remove(cx))))
        .child(div().flex_1())
        .child(this.button(t, "pp-cancel", "Cancel", false, () => { this.mode = "list"; this.error = null; this.search.focus(); cx.notify(); }))
        .child(this.button(t, "pp-save", "Save", true, () => this.save(cx))));
  }
}

/** Quick setup: the steps one after another in `folder`, stopping at the first failure. exec has a 30 s limit each. */
async function runInline(steps, folder, log) {
  for (const step of steps) {
    log(`$ ${step}`);
    try {
      const r = await exec("sh", ["-c", step], { cwd: folder });
      if (r.code !== 0) return log(`setup failed (${r.code}): ${step}`), false;
    } catch {
      return log(`setup stopped (timed out or couldn't start): ${step}`), false;
    }
  }
  return true;
}
