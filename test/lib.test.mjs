import test from "node:test";
import assert from "node:assert/strict";
import { fuzzy, slug, expand, branchName, expandHome, splitList, normalize, splitArgs, basename, parseWorktrees, fuzzyPositions, highlightRuns, commandName, agentOptions, ago, listItems, layoutRects, enterAction, spaceColor, SPACE_MARK, defaultTemplate, uniqueName, duplicateProject, startFromTemplate, portablePath, exportData, parseBackup, mergeProjects, mergeLayouts, BACKUP_FORMAT, exportFileName, allLayouts, layoutPlan, nextLayout, inFolder, BUILTIN_LAYOUTS, dateStamp, timeStamp, shortHome, joinList, blankProject, tabPlan, tabsForLaunch, matchAutoLayout, repoNameFromKey, tabsForAuto, firstAgent, blankPane, tabLabels, expandPath, resolveFolder, spaceShows, shq, setupVars, setupChain, chainThenAgent, chainAlone, setupSummary, expandSetup, exportsPrefix } from "../mods/projects/lib.js";
import { execFileSync } from "node:child_process";
import { readFileSync, existsSync, realpathSync } from "node:fs";
import { join } from "node:path";
import { scratch } from "./helpers/repo.mjs";

test("fuzzy matches subsequences and ranks tighter matches higher", () => {
  assert.equal(fuzzy("zzz", "herdr"), -1);
  assert.ok(fuzzy("hdr", "herdr") >= 0);
  assert.ok(fuzzy("her", "herdr") > fuzzy("hdr", "herdr"));
  assert.ok(fuzzy("api", "my-api") > fuzzy("api", "xaxxpxxi"));
  assert.equal(fuzzy("", "anything"), 0);
});

test("slug", () => assert.equal(slug("  Ada Lovelace!  "), "ada-lovelace"));

test("expand fills variables and blanks unknown ones", () => {
  assert.equal(expand("{a}/{b}/{c}", { a: "x", b: "y" }), "x/y/");
});

test("branchName cleans the result", () => {
  assert.equal(branchName("{user}/{date}-{slug}", { user: "craig", date: "2026-10-30", slug: "fix login" }), "craig/2026-10-30-fix-login");
  assert.equal(branchName("{user}//{slug}", { user: "", slug: "x" }), "x");
});

test("expandHome", () => {
  assert.equal(expandHome("~/code/api/", "/home/c"), "/home/c/code/api");
  assert.equal(expandHome("/srv/x", "/home/c"), "/srv/x");
});

test("splitList", () => assert.deepEqual(splitList(" npm ci \n cp a b \n"), ["npm ci", "cp a b"]));

test("normalize keeps overrides and fills defaults", () => {
  const p = normalize({ path: "/r/x", git: { base: "develop" } });
  assert.equal(p.git.base, "develop");
  assert.equal(p.git.remote, "origin");
  assert.equal(p.worktree.mode, "ask");
});

test("splitArgs keeps quoted words together", () => {
  assert.deepEqual(splitArgs(`--model opus --append-system-prompt "be brief" 'x y'`), ["--model", "opus", "--append-system-prompt", "be brief", "x y"]);
  assert.deepEqual(splitArgs(""), []);
});

test("worktree defaults cover the space name and the repo space", () => {
  const p = normalize({ path: "/r/x", worktree: { mode: "always" } });
  assert.equal(p.worktree.mode, "always");
  assert.equal(p.worktree.spaceName, "{name} · {branch}");
  assert.equal(p.worktree.repoSpace, false);
  assert.equal(expand(p.worktree.spaceName, { name: "API", branch: "me/2026-10-31-x" }), "API · me/2026-10-31-x");
  assert.equal(expand("{slug}", { slug: "add-search" }), "add-search");
});


test("paths keep trailing spaces and accept backslashes", () => {
  assert.equal(expandHome("/srv/Repo  ", "/h"), "/srv/Repo  ");
  assert.equal(expandHome("~/x\n", "/h"), "/h/x");
  assert.equal(basename("C:\\work\\repo\\"), "repo");
  assert.equal(basename("/srv/repo/"), "repo");
});

test("fuzzy: case-insensitive, prefers word starts, rejects out-of-order letters", () => {
  assert.ok(fuzzy("API", "my-api") >= 0);
  assert.ok(fuzzy("ma", "my-api") > fuzzy("ma", "xxmxxa"));
  assert.equal(fuzzy("ba", "ab"), -1);
});

test("slug drops punctuation, accents and edge dashes; tolerates null", () => {
  assert.equal(slug("--Fix: login/page!!--"), "fix-login-page");
  assert.equal(slug(null), "");
  assert.equal(slug("***"), "");
});

test("dateStamp and timeStamp zero-pad", () => {
  const d = new Date(2026, 0, 2, 3, 4, 5);
  assert.equal(dateStamp(d), "2026-01-02");
  assert.equal(timeStamp(d), "030405");
});

test("branchName cleans spaces, doubled slashes and leading or trailing junk", () => {
  assert.equal(branchName("  -/{slug}/.", { slug: "a b" }), "a-b");
  assert.equal(branchName("{a}", {}), "");
});

test("expandHome handles ~, $HOME and bare home", () => {
  assert.equal(expandHome("~", "/h"), "/h");
  assert.equal(expandHome("$HOME/x", "/h"), "/h/x");
  assert.equal(expandHome("~user/x", "/h"), "~user/x");
  assert.equal(expandHome(undefined, "/h"), "");
});

test("shortHome only shortens real home prefixes", () => {
  assert.equal(shortHome("/h", "/h"), "~");
  assert.equal(shortHome("/h/x/y", "/h"), "~/x/y");
  assert.equal(shortHome("/hx/y", "/h"), "/hx/y");
});

test("joinList and splitList round-trip", () => {
  assert.equal(joinList(["a", "b"]), "a\nb");
  assert.equal(joinList(undefined), "");
  assert.deepEqual(splitList(joinList(["npm ci", "cp a b"])), ["npm ci", "cp a b"]);
});

test("splitArgs on unbalanced quotes keeps the words", () => {
  assert.deepEqual(splitArgs(`a "b c`), ["a", '"b', "c"]);
});

test("blankProject and normalize", () => {
  const b = blankProject("/r/api/");
  assert.equal(b.name, "api");
  assert.equal(b.worktree.mode, "ask");
  assert.deepEqual(b.startup.setup, []);
  assert.deepEqual(b.startup, { setup: [], quickSetup: false, agentTiming: "after", tabs: [] });
  assert.equal(b.description, "");
  const n = normalize({ name: "x", startup: { agent: "claude" } });
  assert.equal(n.startup.tabs[0].panes[0].agent, "claude");
  assert.equal(n.startup.tabs[0].panes[0].promptMode, "arg");
  assert.equal(normalize(undefined).path, "");
  assert.deepEqual(normalize({ path: "/a" }).git, { fetch: true, remote: "origin", base: "main", fastForward: false });
});


test("parseWorktrees reads plain porcelain output", () => {
  const text = "worktree /r/main\nHEAD aaa\nbranch refs/heads/main\n\nworktree /r/wt\nHEAD bbb\nbranch refs/heads/me/x\nlocked reason\n\nworktree /r/old\nHEAD ccc\ndetached\nprunable gitdir file points to non-existent location\n";
  const [main, wt, old] = parseWorktrees(text);
  assert.deepEqual(main, { path: "/r/main", branch: "main", locked: false, prunable: false });
  assert.deepEqual(wt, { path: "/r/wt", branch: "me/x", locked: true, prunable: false });
  assert.deepEqual(old, { path: "/r/old", branch: null, locked: false, prunable: true });
});

test("parseWorktrees reads -z output, where a path may hold a newline", () => {
  const text = "worktree /r/main\0HEAD aaa\0branch refs/heads/main\0\0worktree /r/line\nbreak\0HEAD bbb\0branch refs/heads/b\0\0";
  const list = parseWorktrees(text);
  assert.equal(list.length, 2);
  assert.equal(list[1].path, "/r/line\nbreak");
  assert.equal(list[1].branch, "b");
  assert.deepEqual(parseWorktrees(""), []);
});

test("allLayouts offers the built-ins and lets a user layout replace one of the same name", () => {
  assert.deepEqual(allLayouts(undefined).map((l) => l.name), BUILTIN_LAYOUTS.map((l) => l.name));
  const mine = { name: "agent-terminal", panes: [{ type: "agent" }] };
  const list = allLayouts([mine, { name: "dev", panes: [{ type: "agent" }] }, { name: "", panes: [] }, { panes: [] }, null, { name: "nopanes" }]);
  assert.deepEqual(list.map((l) => l.name), ["agent-side-terminal", "agent-terminal", "dev"]);
  assert.equal(list.find((l) => l.name === "agent-terminal"), mine);
});

test("layoutPlan lists the splits in order and defaults each to the previous pane", () => {
  const plan = layoutPlan({ name: "dev", panes: [
    { type: "agent" },
    { name: "files", command: "yazi .", direction: "right" },
    { name: "term", type: "shell", direction: "down" },
    { name: "logs", type: "command", command: " tail -f log ", direction: "down", from: "agent" },
  ] });
  const pane = (over) => blankPane(over);
  assert.deepEqual(plan, [
    pane({ name: "files", type: "command", command: "yazi .", direction: "right", from: "agent" }),
    pane({ name: "term", type: "shell", direction: "down", from: "files" }),
    pane({ name: "logs", type: "command", command: "tail -f log", direction: "down", from: "agent" }),
  ]);
  assert.deepEqual(layoutPlan({ name: "solo", panes: [{ type: "agent" }] }), []);
  assert.deepEqual(layoutPlan(undefined), []);
});

test("layoutPlan names the problem in a bad layout", () => {
  const bad = (panes) => () => layoutPlan({ name: "x", panes });
  assert.deepEqual(layoutPlan({ name: "x", panes: [{ type: "agent" }, { type: "shell" }] }).map((q) => [q.direction, q.from]), [["down", "agent"]], "a missing direction defaults to down");
  assert.throws(bad([{ type: "agent" }, { type: "shell", direction: "left" }]), /needs direction/);
  assert.throws(bad([{ type: "agent" }, { type: "tmux", direction: "down" }]), /unknown type/);
  assert.throws(bad([{ type: "agent" }, { type: "command", direction: "down" }]), /no command/);
  assert.throws(bad([{ type: "agent" }, { name: "a", direction: "down", from: "later" }, { name: "later", direction: "down" }]), /does not come before/);
  assert.throws(bad([{ name: "a" }, { name: "a", direction: "down" }]), /two panes are called "a"/);
});

test("nextLayout cycles none, then each layout, then none again", () => {
  assert.equal(nextLayout(["a", "b"], ""), "a");
  assert.equal(nextLayout(["a", "b"], "a"), "b");
  assert.equal(nextLayout(["a", "b"], "b"), "");
  assert.equal(nextLayout(["a", "b"], "gone"), "");
  assert.equal(nextLayout(["a"], undefined), "a");
});

test("inFolder wraps a command so it starts in the folder, or starts a shell without one", () => {
  const [sh, c, script, , folder, ...rest] = inFolder("/r/x", ["npm", "run", "dev"]);
  assert.deepEqual([sh, c, folder, rest], ["sh", "-c", "/r/x", ["npm", "run", "dev"]]);
  assert.match(script, /cd "\$1"/);
  assert.deepEqual(inFolder("/r/x").slice(4), ["/r/x"]);
});

test("normalize gives every project tabs", () => assert.ok(Array.isArray(normalize({ path: "/a" }).startup.tabs)));

test("fuzzyPositions marks the letters fuzzy matched, and none for a miss or an empty query", () => {
  assert.deepEqual(fuzzyPositions("apgw", "api-gateway"), [0, 1, 4, 8]);
  assert.deepEqual(fuzzyPositions("API", "my-api"), [3, 4, 5]);
  assert.deepEqual(fuzzyPositions("zzz", "api-gateway"), []);
  assert.deepEqual(fuzzyPositions("", "api"), []);
  assert.deepEqual(fuzzyPositions("ba", "ab"), []);
});

test("highlightRuns groups consecutive matched and unmatched characters", () => {
  assert.deepEqual(highlightRuns("api-gateway", [0, 1, 4, 8]), [
    { text: "ap", hit: true }, { text: "i-", hit: false }, { text: "g", hit: true }, { text: "ate", hit: false }, { text: "w", hit: true }, { text: "ay", hit: false },
  ]);
  assert.deepEqual(highlightRuns("abc", []), [{ text: "abc", hit: false }]);
  assert.deepEqual(highlightRuns("", [0]), []);
});

test("commandName is the program an agent command runs", () => {
  assert.equal(commandName("claude --model opus"), "claude");
  assert.equal(commandName("/usr/local/bin/hermes"), "hermes");
  assert.equal(commandName('"pi" --x'), "pi");
  assert.equal(commandName(""), "");
  assert.equal(commandName(undefined), "");
});

test("agentOptions keeps herdr's agents and adds the usual ones it lacks, marked not installed", () => {
  const known = [{ key: "claude", name: "Claude Code", run: ["claude"], installed: true }, { key: "x", name: "Hermes", run: ["/opt/bin/hermes"], installed: true }];
  const list = agentOptions(known);
  assert.deepEqual(list.slice(0, 2), known);
  assert.deepEqual(list.slice(2).map((a) => a.key), ["codex", "opencode", "pi"]);
  assert.ok(list.slice(2).every((a) => a.installed === false && a.icon === `icons/${a.key}.svg`));
  assert.deepEqual(agentOptions(undefined).map((a) => a.key), ["claude", "codex", "opencode", "hermes", "pi"]);
});

test("ago words", () => {
  const now = Date.parse("2026-10-31T12:00:00Z");
  const back = (ms) => ago(now - ms, now);
  assert.equal(ago(undefined, now), "never");
  assert.equal(back(10_000), "just now");
  assert.equal(back(12 * 60_000), "12 min ago");
  assert.equal(back(60 * 60_000), "1 hour ago");
  assert.equal(back(5 * 3600_000), "5 hours ago");
  assert.equal(back(30 * 3600_000), "yesterday");
  assert.equal(back(3 * 86400_000), "3 days ago");
  assert.equal(back(15 * 86400_000), "2 weeks ago");
  assert.equal(back(90 * 86400_000), "3 months ago");
  assert.equal(ago(now + 5000, now), "just now", "a clock slightly ahead is not negative");
});

test("listItems puts section headers between groups, and drops them when searching or with one group", () => {
  const rows = [
    { p: { name: "open", pinned: false }, space: { id: 1 } },
    { p: { name: "pin", pinned: true }, space: null },
    { p: { name: "a", pinned: false }, space: null },
    { p: { name: "b", pinned: false }, space: null },
  ];
  const items = listItems(rows, false);
  assert.deepEqual(items.map((i) => i.header ?? `${i.row.p.name}#${i.index}`), ["Open now", "open#0", "Pinned", "pin#1", "Everything else", "a#2", "b#3"]);
  assert.deepEqual(listItems(rows, true).map((i) => i.index), [0, 1, 2, 3]);
  assert.ok(listItems(rows, true).every((i) => !i.header));
  assert.ok(listItems(rows.slice(2), false).every((i) => !i.header), "one section: no header");
  assert.deepEqual(listItems([], false), []);
  const open = [{ p: { pinned: true }, space: { id: 1 } }, { p: { pinned: false }, space: null }];
  assert.deepEqual(listItems(open, false).map((i) => i.header ?? "row"), ["Open now", "row", "Everything else", "row"], "an open pinned project is under Open now");
});

test("layoutRects divides the pane each split comes from", () => {
  assert.deepEqual(layoutRects(undefined), [{ name: "agent", x: 0, y: 0, w: 1, h: 1 }]);
  assert.deepEqual(layoutRects({ name: "s", panes: [{ type: "agent" }] }), [{ name: "agent", x: 0, y: 0, w: 1, h: 1 }]);
  const below = layoutRects(BUILTIN_LAYOUTS.find((l) => l.name === "agent-terminal"));
  assert.deepEqual(below, [{ name: "agent", x: 0, y: 0, w: 1, h: 0.5 }, { name: "pane2", x: 0, y: 0.5, w: 1, h: 0.5 }]);
  const three = layoutRects({ name: "t", panes: [{ type: "agent" }, { name: "files", command: "yazi", direction: "right" }, { name: "term", type: "shell", direction: "down" }] });
  assert.deepEqual(three.map((r) => [r.name, r.x, r.y, r.w, r.h]), [["agent", 0, 0, 0.5, 1], ["files", 0.5, 0, 0.5, 0.5], ["term", 0.5, 0.5, 0.5, 0.5]]);
  const from = layoutRects({ name: "f", panes: [{ type: "agent" }, { name: "a", direction: "right" }, { name: "b", direction: "down", from: "agent" }] });
  assert.deepEqual(from.map((r) => [r.name, r.x, r.y, r.w, r.h]), [["agent", 0, 0, 0.5, 0.5], ["a", 0.5, 0, 0.5, 1], ["b", 0, 0.5, 0.5, 0.5]]);
  assert.deepEqual(layoutRects({ name: "bad", panes: [{ type: "agent" }, { type: "shell", direction: "left" }] }), [{ name: "agent", x: 0, y: 0, w: 1, h: 1 }]);
});

test("enterAction describes each worktree mode", () => {
  assert.deepEqual(enterAction("never"), ["opens the launch screen for the checkout", "Open…"]);
  assert.deepEqual(enterAction("always"), ["opens the launch screen for a new worktree", "Open…"]);
  assert.deepEqual(enterAction("ask"), ["opens the launch screen and asks for a branch name", "Open…"]);
  assert.deepEqual(enterAction(undefined), ["opens the launch screen and asks for a branch name", "Open…"]);
  assert.deepEqual(enterAction("never", true), ["opens the checkout at once", "Open checkout"]);
  assert.deepEqual(enterAction("always", true), ["creates a new worktree at once", "Create worktree"]);
  assert.deepEqual(enterAction("ask", true), ["opens the launch screen and asks for a branch name", "Open…"]);
});

test("spaceColor reads herdr's stored names and hex colors, and defaults to teal", () => {
  assert.equal(spaceColor({ a: "ansi4" }, "a"), SPACE_MARK.ansi4);
  assert.equal(spaceColor({ a: "#abcdef" }, "a"), "#abcdef");
  assert.equal(spaceColor({}, "a"), SPACE_MARK.ansi6);
  assert.equal(spaceColor(undefined, "a"), SPACE_MARK.ansi6);
  assert.equal(spaceColor({ a: "ansi9" }, "a", { ansi9: "#010203" }), "#010203");
  assert.equal(spaceColor({ a: "nope" }, "a", {}), SPACE_MARK.ansi6);
});

test("the default template is a project with no folder and some starting settings", () => {
  const tpl = defaultTemplate();
  assert.equal(tpl.template, true);
  assert.equal(tpl.name, "Template");
  assert.equal(tpl.path, "");
  assert.deepEqual(tpl.startup.tabs[0].panes.map((x) => x.type), ["agent", "shell"]);
  assert.equal(tpl.startup.tabs[0].panes[0].agent, "claude");
  assert.equal(tpl.worktree.mode, "ask");
  assert.deepEqual(defaultTemplate(), tpl, "the same every time");
});

test("uniqueName adds a counter only when the name is taken", () => {
  assert.equal(uniqueName("api copy", []), "api copy");
  assert.equal(uniqueName("api copy", ["api copy"]), "api copy 2");
  assert.equal(uniqueName("api copy", ["api copy", "api copy 2", "api copy 4"]), "api copy 3");
});

test("duplicateProject copies the settings, keeps the folder, drops pinned, and names the copy", () => {
  const src = normalize({ name: "api", path: "/r/api", group: "work", pinned: true, startup: { agent: "codex", layout: "agent-terminal" }, worktree: { mode: "always" } });
  assert.equal(src.startup.tabs[0].panes[0].agent, "codex");
  const copy = duplicateProject(src, ["api"]);
  assert.equal(copy.name, "api copy");
  assert.equal(copy.path, "/r/api");
  assert.equal(copy.pinned, false);
  assert.equal(copy.group, "work");
  assert.equal(copy.startup.tabs[0].panes[0].agent, "codex");
  assert.equal(copy.worktree.mode, "always");
  assert.equal(copy.template, undefined);
  assert.equal(duplicateProject(src, ["api", "api copy"]).name, "api copy 2");
  copy.startup.tabs[0].panes[0].agent = "changed";
  assert.equal(src.startup.tabs[0].panes[0].agent, "codex", "a deep copy");
});

test("duplicating the template makes a project with the template's settings and no folder", () => {
  const copy = duplicateProject(defaultTemplate(), ["Template"]);
  assert.equal(copy.name, "New project");
  assert.equal(copy.path, "");
  assert.equal(copy.template, undefined);
  assert.equal(copy.startup.tabs[0].panes[0].agent, "claude");
  assert.equal(duplicateProject(defaultTemplate(), ["New project"]).name, "New project 2");
});

test("startFromTemplate keeps the settings and blanks the name and folder", () => {
  const tpl = normalize({ name: "Mine", path: "", template: true, pinned: true, group: "g", startup: { agent: "hermes", promptMode: "send" }, git: { base: "develop" } });
  const p = startFromTemplate(tpl);
  assert.equal(p.name, "");
  assert.equal(p.path, "");
  assert.equal(p.pinned, false);
  assert.equal(p.template, undefined);
  assert.deepEqual([p.group, p.startup.tabs[0].panes[0].agent, p.startup.tabs[0].panes[0].promptMode, p.git.base], ["g", "hermes", "send", "develop"]);
});

test("listItems puts the template in its own last section, never under Open now or Pinned", () => {
  const rows = [
    { p: { name: "a", pinned: false }, space: null },
    { p: { name: "Template", template: true, pinned: true }, space: undefined },
  ];
  assert.deepEqual(listItems(rows, false).map((i) => i.header ?? i.row.p.name), ["Everything else", "a", "Template", "Template"]);
  assert.deepEqual(listItems(rows.slice(1), false).map((i) => i.header ?? "row"), ["row"], "alone: no header");
});

test("portablePath writes the home folder as ~ and leaves other paths alone", () => {
  assert.equal(portablePath("/home/me/code/api", "/home/me"), "~/code/api");
  assert.equal(portablePath("/home/me", "/home/me/"), "~");
  assert.equal(portablePath("/home/mexico/x", "/home/me"), "/home/mexico/x", "only at a folder boundary");
  assert.equal(portablePath("/srv/api", "/home/me"), "/srv/api");
  assert.equal(portablePath("~/already", "/home/me"), "~/already");
  assert.equal(portablePath("", "/home/me"), "");
  assert.equal(portablePath(undefined, "/home/me"), "");
  assert.equal(portablePath("/home/me/x", ""), "/home/me/x");
});

test("exportData carries everything, with portable paths, and does not change its input", () => {
  const projects = [normalize({ name: "api", path: "/home/me/code/api", worktree: { root: "/home/me/.herdr/worktrees/{repo}/{branch}" } }), normalize({ name: "ext", path: "/srv/ext" })];
  const layouts = [{ name: "dev", panes: [{ type: "agent" }] }];
  const out = exportData({ projects, layouts, gitInfo: false, hideTemplate: true }, "/home/me", new Date("2026-11-01T12:00:00Z"));
  assert.deepEqual([out.format, out.version, out.exportedAt], [BACKUP_FORMAT, 1, "2026-11-01T12:00:00.000Z"]);
  assert.deepEqual([out.gitInfo, out.hideTemplate], [false, true]);
  assert.deepEqual(out.layouts, layouts);
  assert.deepEqual(out.projects.map((p) => p.path), ["~/code/api", "/srv/ext"]);
  assert.equal(out.projects[0].worktree.root, "~/.herdr/worktrees/{repo}/{branch}");
  assert.equal(projects[0].path, "/home/me/code/api", "the originals keep their paths");
  assert.deepEqual(exportData({}, "/h").projects, []);
});

test("parseBackup reads a backup and a plain data file, and says what is wrong with anything else", () => {
  const data = { projects: [{ name: "api", path: "~/api", startup: { agent: "codex" } }], layouts: [{ name: "x", panes: [] }], gitInfo: false, hideTemplate: true };
  for (const text of [JSON.stringify({ format: BACKUP_FORMAT, version: 1, ...data }), JSON.stringify(data)]) {
    const b = parseBackup(text);
    assert.equal(b.projects[0].startup.tabs[0].panes[0].agent, "codex");
    assert.equal(b.projects[0].git.base, "main", "missing settings are filled in");
    assert.deepEqual([b.gitInfo, b.hideTemplate, b.layouts.length], [false, true, 1]);
  }
  assert.deepEqual(parseBackup('{"projects":[]}'), { projects: [], layouts: [], gitInfo: true, hideTemplate: false });
  assert.throws(() => parseBackup("{ nope"), /not valid JSON/);
  assert.throws(() => parseBackup("[]"), /no list of projects/);
  assert.throws(() => parseBackup('{"name":"x"}'), /no list of projects/);
  assert.throws(() => parseBackup('{"format":"something-else","projects":[]}'), /not a projects backup/);
  assert.throws(() => parseBackup('{"format":"projects-backup","version":2,"projects":[]}'), /newer version/);
  assert.equal(parseBackup('{"projects":[null,"x",{"name":"ok","path":"/a"}]}').projects.length, 1, "junk entries are skipped");
});

test("mergeProjects adds what is missing (same name and folder counts as present) and keeps yours", () => {
  const mine = [normalize({ name: "api", path: "/r/api", startup: { agent: "claude" } }), normalize({ name: "Mine", path: "", template: true })];
  const theirs = [
    normalize({ name: "api", path: "/r/api/", startup: { agent: "codex" } }),
    normalize({ name: "api", path: "/r/other" }),
    normalize({ name: "blog", path: "~/blog" }),
    normalize({ name: "Template", path: "", template: true }),
  ];
  const r = mergeProjects(mine, theirs);
  assert.deepEqual(r.projects.map((p) => `${p.name}@${p.path}`), ["api@/r/api", "Mine@", "api@/r/other", "blog@~/blog"]);
  assert.deepEqual([r.added, r.skipped], [2, 2]);
  assert.equal(r.projects[0].startup.tabs[0].panes[0].agent, "claude", "your copy of api is kept");
  assert.equal(mergeProjects([], theirs).projects.filter((p) => p.template).length, 1, "a template is added when you have none");
  assert.deepEqual(mine.length, 2, "the input is not changed");
});

test("mergeLayouts adds layouts by new name; yours win", () => {
  const r = mergeLayouts([{ name: "a", panes: [1] }], [{ name: "a", panes: [2] }, { name: "b", panes: [] }, { panes: [] }, null]);
  assert.deepEqual(r.layouts.map((l) => l.name), ["a", "b"]);
  assert.deepEqual(r.layouts[0].panes, [1]);
  assert.equal(r.added, 1);
});

test("exportFileName puts the local date and time in the name", () => {
  assert.equal(exportFileName(new Date(2026, 10, 1, 13, 35, 7)), "projects-config-2026-11-01-133507.json");
  assert.equal(exportFileName(new Date(2027, 0, 9, 0, 5, 0)), "projects-config-2027-01-09-000500.json");
  assert.match(exportFileName(), /^projects-config-\d{4}-\d\d-\d\d-\d{6}\.json$/);
});

test("withLauncherBlocks puts the launcher beside spaces, status and tabs, only where they exist and never twice", async () => {
  const { withLauncherBlocks } = await import("../mods/projects/lib.js");
  const tree = { id: "root", children: [{ id: "side", children: [{ id: "spaces", type: "block", size: { weight: 1 }, min: 90 }] }, { id: "tabs", type: "block", size: { px: 42 } }] };
  const out = withLauncherBlocks(tree);
  assert.deepEqual(out.added, ["sidebar", "tabs"], "no status block here, so no status launcher");
  assert.equal(tree.children[1].id, "tabs", "the original is not changed");
  const section = out.tree.children[0].children[0];
  assert.equal(section.id, "spaces-section");
  assert.equal(section.min, 90);
  assert.deepEqual(section.children.map((c) => c.id), ["spaces", "projects-launch-sidebar"]);
  assert.deepEqual(out.tree.children[1].size, { px: 42 });
  assert.deepEqual(withLauncherBlocks(out.tree).added, [], "already there: nothing added");
});

test("normalize upgrades a legacy startup: agent, layout and string tabs become tabs", () => {
  const p = normalize({ path: "/a", startup: { agent: "claude --model opus", args: "-p", prompt: "hi", promptMode: "send", layout: "agent-terminal", tabs: ["lazygit", "npm run dev"] } });
  assert.deepEqual(p.startup.tabs.map((t) => t.name), ["agent", "lazygit", "npm"]);
  assert.deepEqual(p.startup.tabs[0].panes.map((x) => x.type), ["agent", "shell"]);
  assert.equal(p.startup.tabs[0].panes[0].agent, "claude --model opus");
  assert.equal(p.startup.tabs[0].panes[0].prompt, "hi");
  assert.equal(p.startup.tabs[0].panes[1].direction, "down");
  assert.equal(p.startup.tabs[1].command, "lazygit");
  assert.equal(p.startup.agentTiming, "after");
  for (const k of ["agent", "args", "prompt", "promptMode", "layout"]) assert.ok(!(k in p.startup), k);
});
test("normalize: a legacy layout defined by the user expands, an unknown one leaves the agent alone", () => {
  const mine = [{ name: "coding", panes: [{ type: "agent" }, { name: "files", type: "command", command: "yazi .", direction: "right" }] }];
  assert.deepEqual(normalize({ path: "/a", startup: { agent: "claude", layout: "coding" } }, mine).startup.tabs[0].panes.map((x) => x.name), ["agent", "files"]);
  assert.equal(normalize({ path: "/a", startup: { agent: "claude", layout: "nope" } }).startup.tabs[0].panes.length, 1);
});
test("normalize: a legacy plain shell with no layout is one shell tab; no startup at all is one shell tab", () => {
  assert.deepEqual(normalize({ path: "/a", startup: { agent: "" } }).startup.tabs[0].panes, [{ name: "agent", type: "shell", command: "", agent: "", args: "", prompt: "", promptMode: "arg", direction: "", from: "", folder: "" }]);
  assert.equal(normalize({ path: "/a" }).startup.tabs[0].name, "shell");
});
test("normalize fills a new-shape tab: neither command nor panes is a plain shell, panes: [] too", () => {
  const p = normalize({ path: "/a", startup: { tabs: [{ name: "x" }, { name: "y", panes: [] }, { name: "z", folder: "sub", command: "make" }] } });
  assert.deepEqual(p.startup.tabs.map((t) => [t.command, t.panes.length]), [["", 0], ["", 0], ["make", 0]]);
  assert.equal(p.startup.tabs[2].folder, "sub");
  assert.equal(p.description, "");
});
test("tabPlan fills names, directions and from, and turns a command tab into one pane", () => {
  const plan = tabPlan([{ name: "a", panes: [{ type: "agent", agent: "claude" }, { type: "shell" }, { type: "command", command: "top", direction: "right", from: "agent" }] }, { name: "b", command: "lazygit" }, { name: "c" }]);
  assert.deepEqual(plan[0].panes.map((x) => [x.name, x.direction, x.from]), [["agent", "", ""], ["pane2", "down", "agent"], ["pane3", "right", "agent"]]);
  assert.deepEqual(plan[1].panes, [{ name: "pane1", type: "command", command: "lazygit", agent: "", args: "", prompt: "", promptMode: "arg", direction: "", from: "", folder: "" }]);
  assert.equal(plan[2].panes[0].type, "shell");
});
test("tabPlan names the problem", () => {
  assert.throws(() => tabPlan([{ name: "a" }, { panes: [] }]), /Tab 2 needs a name/);
  assert.throws(() => tabPlan([{ name: "api", command: "x", panes: [{ type: "shell" }] }]), /either a command or panes/);
  assert.throws(() => tabPlan([{ name: "api", panes: [{ type: "shell" }, { name: "db", type: "shell", direction: "up" }] }]), /pane "db" needs direction/);
  assert.throws(() => tabPlan([{ name: "api", panes: [{ type: "shell" }, { name: "db", type: "x" }] }]), /unknown type "x"/);
  assert.throws(() => tabPlan([{ name: "api", panes: [{ type: "shell" }, { name: "db", type: "command" }] }]), /command pane "db" has no command/);
  assert.throws(() => tabPlan([{ name: "api", panes: [{ type: "shell" }, { name: "db", type: "shell", from: "y" }] }]), /splits "y"/);
  assert.throws(() => tabPlan([{ name: "api", panes: [{ name: "db", type: "shell" }, { name: "db", type: "shell" }] }]), /two panes are called "db"/);
});
test("tabsForLaunch: none keeps the project's tabs, a panes layout replaces tab 1's panes, a tabs layout replaces all; agent panes inherit the project's agent", () => {
  const p = normalize({ path: "/a", startup: { tabs: [{ name: "agent", panes: [{ type: "agent", agent: "codex", args: "-q" }] }, { name: "git", command: "lazygit" }] } });
  const layouts = [{ name: "side", panes: [{ type: "agent" }, { type: "shell", direction: "right" }] }, { name: "full", tabs: [{ name: "only", panes: [{ type: "agent" }] }] }];
  assert.equal(tabsForLaunch(p, layouts, ""), p.startup.tabs);
  const side = tabsForLaunch(p, layouts, "side");
  assert.deepEqual([side.length, side[0].panes.length, side[0].panes[0].agent, side[1].name], [2, 2, "codex", "git"]);
  const full = tabsForLaunch(p, layouts, "full");
  assert.deepEqual([full.length, full[0].name, full[0].panes[0].args], [1, "only", "-q"]);
  const noAgent = normalize({ path: "/a", startup: { tabs: [{ name: "s" }] } });
  assert.equal(tabsForLaunch(noAgent, layouts, "side")[0].panes[0].type, "shell");
  assert.throws(() => tabsForLaunch(p, layouts, "nope"), /No layout called "nope"/);
});
test("firstAgent finds the first agent pane across tabs, or null", () => {
  const tabs = normalize({ path: "/a", startup: { tabs: [{ name: "s" }, { name: "t", panes: [{ type: "shell" }, { type: "agent", agent: "claude", direction: "down" }] }] } }).startup.tabs;
  const f = firstAgent(tabs);
  assert.deepEqual([f.tab, f.index, f.pane.agent], [1, 1, "claude"]);
  assert.equal(firstAgent([]), null);
});
test("blankPane defaults every field and applies overrides", () => {
  assert.deepEqual(blankPane({ type: "agent", agent: "claude" }), { name: "", type: "agent", command: "", agent: "claude", args: "", prompt: "", promptMode: "arg", direction: "", from: "", folder: "" });
});
test("tabLabels marks split tabs with a pane count", () => {
  assert.deepEqual(tabLabels([{ name: "server", panes: [{}, {}] }, { name: "git", command: "lazygit", panes: [] }]), ["server ×2", "git"]);
});
test("expandPath and resolveFolder", () => {
  const env = { HOME: "/h", X: "x" };
  assert.equal(expandPath("~/a/$X/${X}b", "/h", env), "/h/a/x/xb");
  assert.equal(expandPath("$NOPE/a", "/h", env), "/a");
  assert.equal(expandPath("", "/h", env), "");
  assert.equal(resolveFolder("/p", "", "/h", env), "/p");
  assert.equal(resolveFolder("/p", "frontend", "/h", env), "/p/frontend");
  assert.equal(resolveFolder("/p/api", "../db", "/h", env), "/p/db");
  assert.equal(resolveFolder("/p", "/abs", "/h", env), "/abs");
  assert.equal(resolveFolder("/p", "~/w", "/h", env), "/h/w");
});
test("defaultTemplate, duplicateProject and startFromTemplate use the tab model", () => {
  const t = defaultTemplate();
  assert.deepEqual(t.startup.tabs[0].panes.map((x) => x.type), ["agent", "shell"]);
  assert.equal(t.startup.tabs[0].panes[0].agent, "claude");
  assert.equal(duplicateProject(t, []).startup.tabs[0].panes[0].agent, "claude");
  assert.equal(startFromTemplate(t).startup.tabs.length, 1);
});

test("tabPlan treats the empty direction normalize fills in as unset: down", () => {
  const p = normalize({ path: "/a", startup: { tabs: [{ name: "a", panes: [{ type: "agent", agent: "claude" }, { type: "shell" }] }] } });
  assert.equal(p.startup.tabs[0].panes[1].direction, "");
  assert.equal(tabPlan(p.startup.tabs)[0].panes[1].direction, "down");
  const side = tabsForLaunch(p, [{ name: "two", panes: [{ type: "agent" }, { type: "shell" }] }], "two");
  assert.equal(tabPlan(side)[0].panes[1].direction, "down");
});

// ---- final review fixes ----

test("tabPlan names only a tab's first agent pane agent; a later unnamed one is pane<N>", () => {
  const plan = tabPlan([{ name: "a", panes: [{ type: "agent", agent: "claude" }, { type: "agent", agent: "codex", direction: "right" }] }]);
  assert.deepEqual(plan[0].panes.map((x) => x.name), ["agent", "pane2"]);
});

test("a layout's agent pane on a project with no agent becomes a shell still called agent, so from: agent works", () => {
  const p = normalize({ path: "/r/x", startup: { tabs: [{ name: "shell" }] } });
  const tabs = tabsForLaunch(p, [{ name: "two", panes: [{ type: "agent" }, { type: "shell", direction: "down", from: "agent" }] }], "two");
  assert.deepEqual(tabPlan(tabs)[0].panes.map((x) => [x.name, x.type]), [["agent", "shell"], ["pane2", "shell"]]);
});

test("a panes layout replaces the panes of the tab that holds the agent", () => {
  const p = normalize({ path: "/r/x", startup: { tabs: [{ name: "web", command: "npm run dev" }, { name: "ai", panes: [{ type: "agent", agent: "claude" }] }] } });
  const tabs = tabsForLaunch(p, [], "agent-terminal");
  assert.deepEqual(tabs[0], p.startup.tabs[0]);
  assert.deepEqual(tabs[1].panes.map((x) => [x.type, x.agent]), [["agent", "claude"], ["shell", ""]]);
  assert.equal(tabs[1].name, "ai");
  assert.doesNotThrow(() => tabPlan(tabs));
});

test("spaceShows: a space shows a project in its folder or below it, not in a sibling sharing a prefix", () => {
  assert.equal(spaceShows("/r/api", "/r/api"), true);
  assert.equal(spaceShows("/r/api/web", "/r/api"), true);
  assert.equal(spaceShows("/r/api/web", "/r/api/"), true);
  assert.equal(spaceShows("/r/api2", "/r/api"), false);
  assert.equal(spaceShows("/r", "/r/api"), false);
  assert.equal(spaceShows(undefined, "/r/api"), false);
});

test("normalize skips blank legacy string tabs", () => {
  const p = normalize({ path: "/a", startup: { agent: "claude", tabs: ["", "  ", "lazygit"] } });
  assert.deepEqual(p.startup.tabs.map((t) => t.name), ["agent", "lazygit"]);
});

test("normalize drops a tab's command when it has panes", () => {
  const p = normalize({ path: "/a", startup: { tabs: [{ name: "x", command: "top", panes: [{ type: "shell" }] }] } });
  assert.equal(p.startup.tabs[0].command, "");
  assert.equal(p.startup.tabs[0].panes.length, 1);
  assert.doesNotThrow(() => tabPlan(p.startup.tabs));
});

test("normalize treats a startup that is not an object as absent", () => {
  for (const startup of ["claude", 3, null]) assert.equal(normalize({ path: "/a", startup }).startup.tabs[0].name, "shell");
});

test("normalize fills copy, worktree setup, quickSetup and quickLaunch, dropping blank lines", () => {
  const p = normalize({ path: "/a", worktree: { copy: [" .env ", "", ".claude/*"], setup: ["npm ci", "  "] } });
  assert.deepEqual([p.worktree.copy, p.worktree.setup, p.startup.quickSetup, p.quickLaunch], [[".env", ".claude/*"], ["npm ci"], false, false]);
  assert.deepEqual(normalize(p), p);
});
test("splitList takes newlines only; joinList writes lines", () => {
  assert.deepEqual(splitList("a\nb\nc\n\n"), ["a", "b", "c"]);
  assert.equal(joinList(["a", "b"]), "a\nb");
});
test("shq single-quotes a word, escaping embedded quotes", () => {
  assert.equal(shq("it's"), "'it'\\''s'");
  assert.equal(shq(""), "''");
});
test("setupVars gives braces and env in a fixed order", () => {
  const { vars, env } = setupVars({ main: "/m", folder: "/w", branch: "b", repo: "r", name: "N", home: "/h" });
  assert.deepEqual(vars, { main: "/m", folder: "/w", branch: "b", repo: "r", name: "N", home: "/h" });
  assert.deepEqual(Object.keys(env), ["PROJECTS_MAIN", "PROJECTS_FOLDER", "PROJECTS_BRANCH", "PROJECTS_REPO", "PROJECTS_NAME", "PROJECTS_HOME"]);
});
test("setupChain exports env, cds, runs each step in its own shell with braces expanded, and touches the marker", () => {
  const { vars, env } = setupVars({ main: "/m", folder: "/w", branch: "b", repo: "r", name: "N", home: "/h" });
  const c = setupChain({ steps: ["cp {main}/.env .env", "echo 'it''s $HOME' && true"], vars, env, folder: "/w", marker: "/w/.projects-setup-done" });
  assert.equal(c, `export PROJECTS_MAIN='/m'; export PROJECTS_FOLDER='/w'; export PROJECTS_BRANCH='b'; export PROJECTS_REPO='r'; export PROJECTS_NAME='N'; export PROJECTS_HOME='/h'; cd '/w' && sh -ec 'cp /m/.env .env' && sh -ec ${shq("echo 'it''s $HOME' && true")} && touch '/w/.projects-setup-done'`);
  assert.equal(setupChain({ steps: [], vars, env, folder: "/w" }), "");
  assert.ok(!setupChain({ steps: ["x"], vars, env, folder: "/w" }).includes("touch"));
});
test("setupChain runs in a real shell with env and braces", () => {
  const dir = scratch();
  const { vars, env } = setupVars({ main: "/m", folder: dir, branch: "b", repo: "r", name: "N", home: "/h" });
  execFileSync("sh", ["-c", setupChain({ steps: ["printf '%s' \"$PROJECTS_NAME-{branch}\" > out.txt"], vars, env, folder: dir })], { encoding: "utf8" });
  assert.equal(readFileSync(join(dir, "out.txt"), "utf8"), "N-b");
});
/** Runs a chain of `steps` in a scratch folder, started from another folder: { dir, ok, marked }. */
function runChain(steps) {
  const dir = scratch(); const elsewhere = scratch();
  const marker = join(dir, ".projects-setup-done");
  const { vars, env } = setupVars({ main: "/the/main", folder: dir, branch: "b", repo: "r", name: "N", home: "/h" });
  let ok = true;
  try { execFileSync("sh", ["-c", setupChain({ steps, vars, env, folder: dir, marker })], { cwd: elsewhere, encoding: "utf8", stdio: "pipe" }); } catch { ok = false; }
  return { dir, ok, marked: existsSync(marker) };
}
test("a step ending in a # comment does not swallow the next step, which sees $PROJECTS_MAIN", () => {
  const r = runChain(["echo hi # a comment", "printf '%s' \"$PROJECTS_MAIN\" > main.txt"]);
  assert.deepEqual([r.ok, r.marked], [true, true]);
  assert.equal(readFileSync(join(r.dir, "main.txt"), "utf8"), "/the/main");
});
test("a step with ; that fails part-way fails the chain and leaves no marker", () => {
  const r = runChain(["false; echo x", "touch after.txt"]);
  assert.deepEqual([r.ok, r.marked, existsSync(join(r.dir, "after.txt"))], [false, false, false]);
});
test("a step with a trailing & does not break the chain, and steps run in the folder", () => {
  const r = runChain(["sleep 0 &", "pwd -P > where.txt"]);
  assert.deepEqual([r.ok, r.marked], [true, true]);
  assert.equal(readFileSync(join(r.dir, "where.txt"), "utf8").trim(), realpathSync(r.dir));
});
test("a step with || keeps its own fallback and the chain goes on", () => {
  const r = runChain(["false || touch fell.txt", "touch next.txt"]);
  assert.deepEqual([r.ok, r.marked, existsSync(join(r.dir, "fell.txt")), existsSync(join(r.dir, "next.txt"))], [true, true, true, true]);
  assert.equal(runChain(["true || touch never.txt", "false"]).marked, false);
});
test("expandSetup fills only the setup variables and never a ${...} or a brace it does not know", () => {
  const vars = { main: "/m", folder: "/w", branch: "b", repo: "r", name: "N", home: "/h" };
  assert.equal(expandSetup("{main}/x {folder} {branch} {repo} {name} {home}", vars), "/m/x /w b r N /h");
  assert.equal(expandSetup("cp ${PROJECTS_MAIN}/x .", vars), "cp ${PROJECTS_MAIN}/x .");
  assert.equal(expandSetup("echo ${main}", vars), "echo ${main}");
  assert.equal(expandSetup("awk '{print}' f | jq '{x: .y}'", vars), "awk '{print}' f | jq '{x: .y}'");
  assert.equal(expand("{user}-{x}", { user: "u" }), "u-", "branch templates keep the old expand");
});
test("exportsPrefix exports each variable quoted, joined by ;", () => {
  assert.equal(exportsPrefix({ A: "x y", B: "it's" }), `export A='x y'; export B=${shq("it's")}`);
  assert.equal(exportsPrefix({}), "");
});
test("chainThenAgent execs the quoted agent with the prompt in the pane's folder and falls back to a shell; chainAlone only falls back", () => {
  assert.equal(chainThenAgent("cd '/w' && npm ci", ["claude", "--model", "opus"], "fix it's"), "cd '/w' && npm ci && exec 'claude' '--model' 'opus' 'fix it'\\''s' || exec \"$SHELL\"");
  assert.equal(chainThenAgent("cd '/w' && npm ci", ["claude"], "", "/w/backend"), "cd '/w' && npm ci && cd '/w/backend' && exec 'claude' || exec \"$SHELL\"");
  assert.equal(chainThenAgent("", ["claude"], "x"), "");
  assert.equal(chainAlone("cd '/w' && npm ci"), "cd '/w' && npm ci || exec \"$SHELL\"");
});
test("setupSummary counts copy and setup and names the timing", () => {
  assert.equal(setupSummary(normalize({ path: "/a", worktree: { copy: [".env"], setup: ["npm ci", "npm run build"] }, startup: { setup: ["docker compose up -d"], agentTiming: "after" } })), "1 copy · 3 setup · agent after setup");
  assert.equal(setupSummary(normalize({ path: "/a", startup: { agentTiming: "with" } })), "no setup");
  assert.equal(setupSummary(normalize({ path: "/a", startup: { setup: ["npm ci"], quickSetup: true, agentTiming: "after" } })), "1 setup · setup inline");
});

test("a setup command containing ;; stays one element", () => {
  assert.deepEqual(normalize({ path: "/a", startup: { setup: ["case x in a) ;; esac"] } }).startup.setup, ["case x in a) ;; esac"]);
});

test("normalize fills autoLayout", () => { assert.equal(normalize({ path: "/a" }).worktree.autoLayout, false); assert.equal(normalize({ path: "/a", worktree: { autoLayout: 1 } }).worktree.autoLayout, true); });
test("matchAutoLayout picks the most specific entry, ties by order", () => {
  const e = [{ repo: "*", branch: "", layout: "any" }, { repo: "*", branch: "release", layout: "rel" }, { repo: "API", branch: "", layout: "api" }, { repo: "api", branch: "release", layout: "api-rel" }, { repo: "api", branch: "", layout: "api2" }];
  assert.equal(matchAutoLayout(e, "api", "release").layout, "api-rel");
  assert.equal(matchAutoLayout(e, "api", "main").layout, "api");
  assert.equal(matchAutoLayout(e, "web", "release").layout, "rel");
  assert.equal(matchAutoLayout(e, "web", "main").layout, "any");
  assert.equal(matchAutoLayout([], "web", "main"), null);
});
test("tabsForAuto: a project gives its own tabs; a panes layout becomes one tab; agent panes take defaultAgent or become shells", () => {
  const p = normalize({ path: "/a", startup: { tabs: [{ name: "agent", panes: [{ type: "agent", agent: "codex" }] }] } });
  assert.equal(tabsForAuto({ project: p, layouts: [] })[0].panes[0].agent, "codex");
  const layouts = [{ name: "side", panes: [{ type: "agent" }, { type: "shell", direction: "right" }] }, { name: "full", tabs: [{ name: "a", panes: [{ type: "agent" }] }, { name: "git", command: "lazygit" }] }];
  const side = tabsForAuto({ layouts, entry: { repo: "*", branch: "", layout: "side" }, defaultAgent: { agent: "claude", args: "-q" } });
  assert.deepEqual([side.length, side[0].name, side[0].panes[0].agent, side[0].panes[0].args], [1, "agent", "claude", "-q"]);
  const full = tabsForAuto({ layouts, entry: { repo: "*", branch: "", layout: "full" }, defaultAgent: null });
  assert.deepEqual([full.length, full[0].panes[0].type, full[1].command], [2, "shell", "lazygit"]);
  assert.throws(() => tabsForAuto({ layouts, entry: { repo: "*", branch: "", layout: "nope" } }), /No layout called "nope"/);
});

test("repoNameFromKey is the folder holding the common .git, else the space's folder name", () => {
  assert.equal(repoNameFromKey("/src/api/.git", "/wt/api/feat"), "api");
  assert.equal(repoNameFromKey("/src/api.git", "/wt/feat"), "feat");
});
