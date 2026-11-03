# Projects mod, phase 1: rename and tab model. Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** A `projects` Herdr app mod, started from a renamed copy of project-presets, where a project describes a whole workspace as a list of tabs with panes, each in its own folder, and opening it builds exactly that.

**Architecture:** The mod keeps project-presets's structure: `main.js` (the popup view), `git.js` (git and worktrees), `lib.js` (pure helpers, node-tested), `config.js` (the data file), `log.js`, `demo.js`. This phase adds `workspace.js`, the one place that turns a project's tabs into app commands, and moves the launch code there from `git.js`. `lib.js` gains the tab model: `normalize()` upgrades old entries, `tabPlan()` validates, `tabsForLaunch()` applies a layout pick. The editor gets a Tabs list; the detail card lists tabs. Everything runs in the app's own JavaScript runtime (gpui-kit), tested under node with the stubs project-presets ships.

**Tech Stack:** JavaScript ES modules on gpui-kit / gpui-base inside herdr-app 0.1.12 with hc 0.1.17; `node --test` with `test/helpers/{herdr-stub,gpui-stub,repo,hooks,setup}.mjs`; `herdr-app check`; git.

**Spec:** `docs/superpowers/specs/2026-11-02-projects-mod-design.md` (sections 3, 4.1, 7, 8, phase 1 of 9, 10, 11). This plan is phase 1 only; the launch screen, setup chain and agent timing (phase 2) and the watcher (phase 3) get their own plans.

## Global Constraints

- Host: `herdr-app 0.1.12`, `hc 0.1.17`. Mods run in the app's runtime: no `setTimeout`, no `structuredClone`, no top-level `await`; use `cx.timer` and `cx.spawn`. Check `~/.config/herdr-app/AGENTS.md` and the `.d.ts` files before using a built-in.
- `render()` never reads live herdr data (`spaces()`, `shared()`, `agents()`, `window()`); it draws from `this.snap`. Only `theme()` is read live.
- Pure logic lives in `lib.js` with no `herdr` import. `herdr` calls live in `git.js`, `config.js`, `workspace.js`, `log.js`, `main.js`.
- Style: 2-space indent, double quotes, semicolons, ES modules, as the copied code.
- Names (spec section 3): folders `mods/projects/` and `mods/projects-launcher/`; data `data/projects.json`; log `data/projects.log`, flag `data/projects.debug`, demo `data/projects.demo`; shared keys `projects.recent`, `projects.detail`, `projects.launcher`; launcher block ids `projects-launch-sidebar|status|tabs`; keys `ctrl-alt-p` and `cmd-alt-p` → `mod.open:projects`; log prefix `[projects]`; popup title `Projects`.
- Every old `project-presets.json` must load and launch unchanged after `normalize()` (spec anti-goal).
- Folders in tabs and panes: relative to the project folder (or the worktree), or absolute; `~`, `$HOME`, `$VAR` and `${VAR}` expand. Every folder is checked before anything is created.
- `ratio` and `label` are not modeled. The app splits evenly and has no pane rename.
- Never run `git worktree remove --force`.
- Each task ends with `node --test test/` green and, for tasks touching `mods/`, `herdr-app check mods/projects` (and `mods/projects-launcher` when touched) exiting 0.
- Commits: imperative subject under about 50 characters, body says why when not obvious. Commit after every task.

## Review Focus

Inputs the spec implies but no existing test exercises, most likely to bite first. Each has its test added to the owning task.

1. A hand-edited tab with neither `command` nor `panes`, or with `panes: []`, must become one plain shell pane, not a crash or an empty tab. (Task 2, `normalize` test.)
2. A tab or pane folder that does not exist must stop the launch before `space.new`, naming the tab and pane. (Task 3, workspace test.)
3. A prompt typed for a project with no agent pane anywhere must be reported in the busy notes ("no agent pane to prompt"), not silently dropped. (Task 3, workspace test.)
4. An old file whose `startup.layout` names a *user* layout defined in the same file's `layouts` must expand to that layout's panes, so `loadConfig` must hand the file's layouts to `normalize`. (Task 2, config test.)
5. Reordering tabs or panes in the editor must not lose typed-but-unsaved text in their boxes (inputs keyed by object identity, not index). (Task 5, UI test.)

---

### Task 1: Create the repo from project-presets and rename everything

**Files:**
- Create: `mods/projects/*` and `mods/projects-launcher/*` (copied from upstream and renamed), `test/*` (copied and renamed), `keys.json`, `LICENSE`, `.gitignore`, `README.md`, `RECIPE.md`
- Modify: `~/.config/herdr-app/keys.json` (two keys added), `~/.config/herdr-app/mods/` (two symlinks)
- Test: the copied `test/*.test.mjs` as they are

**Interfaces:**
- Consumes: upstream `https://github.com/cgill27/project-presets` at its current `main`.
- Produces: the module paths every later task imports: `mods/projects/{main,git,lib,config,log,demo}.js`, `mods/projects-launcher/main.js`, `test/helpers/*.mjs`, and the names in Global Constraints.

- [ ] **Step 1: Clone upstream into a temporary folder and copy the files in**

```bash
tmp=$(mktemp -d) && git clone -q --depth 1 https://github.com/cgill27/project-presets "$tmp/pp"
cd ~/gitprojects/herdr-projects
cp -R "$tmp/pp/mods" "$tmp/pp/test" . && cp "$tmp/pp/keys.json" "$tmp/pp/LICENSE" "$tmp/pp/.gitignore" "$tmp/pp/RECIPE.md" .
mv mods/project-presets mods/projects && mv mods/project-presets-launcher mods/projects-launcher
```

- [ ] **Step 2: Rename every occurrence, longest names first**

Apply, in this order, to every `*.js`, `*.mjs`, `*.json` and `*.md` under `mods/`, `test/`, and to `keys.json` and `RECIPE.md`:
1. `project-presets-launcher` → `projects-launcher`
2. `pp-launch-` → `projects-launch-`
3. `project-presets` → `projects`
4. `Project presets` → `Projects` (the two `mod.json` titles)

Leave element ids such as `pp-lay-`, `pp-add` and the stub's temp prefixes alone: they are internal.

- [ ] **Step 3: Verify nothing old remains**

Run: `grep -rn "project-presets\|Project presets\|pp-launch" mods test keys.json RECIPE.md`
Expected: no output.

- [ ] **Step 4: Copy the app's type files in (git-ignored) and run the tests**

```bash
cp ~/.config/herdr-app/gpui-kit.d.ts ~/.config/herdr-app/herdr.d.ts mods/projects/
cp ~/.config/herdr-app/gpui-kit.d.ts ~/.config/herdr-app/herdr.d.ts mods/projects-launcher/
node --test test/
```
Expected: every test passes; the pass count equals `grep -h '^test("' test/*.test.mjs | wc -l`.

- [ ] **Step 5: Check both mods load**

Run: `herdr-app check mods/projects && herdr-app check mods/projects-launcher`
Expected: both exit 0.

- [ ] **Step 6: Write README.md**

Content, in this order: one paragraph saying what the mod is (the spec's section 1 first paragraph, in the README's own words); a line "Started from [project-presets](https://github.com/cgill27/project-presets) by cgill27, MIT; see LICENSE."; **Install**: the two `ln -s "$PWD/mods/<name>" ~/.config/herdr-app/mods/<name>` lines and "merge `keys.json` into `~/.config/herdr-app/keys.json`"; **Development**: `node --test test/`, `herdr-app check mods/projects`, and the `.d.ts` copy lines from Step 4. Nothing else yet.

- [ ] **Step 7: Install into the app and bind the keys**

```bash
ln -s "$PWD/mods/projects" ~/.config/herdr-app/mods/projects
ln -s "$PWD/mods/projects-launcher" ~/.config/herdr-app/mods/projects-launcher
```
Add to the `global` section of `~/.config/herdr-app/keys.json`: `"ctrl-alt-p": "mod.open:projects"` and `"cmd-alt-p": "mod.open:projects"` (both free as of 2026-11-02). Then: `herdr-app status` shows no error for `keys.json` or either mod; `herdr-app do mod.open '{"name":"projects"}'` opens the picker; `herdr-app shot /tmp/projects-phase1-task1.png` shows it titled "Projects".

- [ ] **Step 8: Commit**

```bash
git add -A && git commit -m "Start the projects mod from project-presets, renamed"
```

### Task 2: The tab model in lib.js

**Files:**
- Modify: `mods/projects/lib.js` (`blankProject`, `normalize`, `defaultTemplate`, `duplicateProject`, `startFromTemplate`, `layoutPlan`, add the functions below)
- Modify: `mods/projects/config.js` (`loadConfig` passes layouts to `normalize`)
- Test: `test/lib.test.mjs`, `test/config.test.mjs`

**Interfaces:**
- Consumes: existing `expandHome(p, home)`, `splitArgs`, `commandName`, `allLayouts(user)`, `BUILTIN_LAYOUTS`, `layoutRects(layout)`.
- Produces, all exported from `lib.js`:
  - `normalize(p, layouts = [])` → project in the new shape (below). `layouts` is the file's user layouts, used only to expand a legacy `startup.layout`.
  - `blankProject(path = "")` → `startup: { setup: [], agentTiming: "after", tabs: [] }` and top-level `description: ""`.
  - `tabPlan(tabs)` → `Tab[]`, validated and filled; throws `Error` with the messages below.
  - `tabsForLaunch(project, layouts, pick)` → `tabs` for this launch: `pick` `""` or `null` means the project's own; a layout with `tabs` replaces them; a layout with only `panes` replaces tab 1's panes. In either layout case an agent pane with empty `agent` takes `agent`, `args`, `prompt`, `promptMode` from `firstAgent(project.startup.tabs)` when there is one, else becomes `{ type: "shell" }`.
  - `firstAgent(tabs)` → `{ tab: i, index: j, pane: Pane }` for the first `type: "agent"` pane (tab and pane positions, and the pane object itself), or `null`.
  - `blankPane(over = {})` → a `Pane` with every field defaulted (`type: "shell"`, `promptMode: "arg"`, the rest `""`) and `over` applied.
  - `tabLabels(tabs)` → `string[]`, `"server ×2"` for a tab with 2 panes, else the name.
  - `expandPath(text, home, env)` → string: `~`/`$HOME` via `expandHome`, then `$VAR` and `${VAR}` from `env` (unknown → `""`); `""` stays `""`.
  - `resolveFolder(base, text, home, env)` → absolute path: `""` → `base`; absolute → as is; else `base + "/" + expanded`, with `/./` and `..` segments collapsed.

The shapes:
```js
// Tab:  { name: string, folder: string, command: string, panes: Pane[] }   // command "" when panes.length > 0
// Pane: { name: string, type: "agent"|"shell"|"command", command: string, agent: string, args: string,
//         prompt: string, promptMode: "arg"|"send", direction: "right"|"down"|"", from: string, folder: string }
```
`normalize` rules for `startup` (spec 4.1 "Upgrade of old entries"):
- Legacy if `startup.tabs` is absent or holds strings, or any of `agent`, `args`, `prompt`, `promptMode`, `layout` is present.
- Legacy agent pane: `agent.trim()` → `{ type: "agent", name: "agent", agent, args, prompt, promptMode }`, else `{ type: "shell", name: "agent" }`.
- Legacy `layout`: a name found in `allLayouts(layouts)` → tab 1 is `{ name: "agent", panes: [agentPane with that layout's first pane's name, ...its other panes] }`; not found or `""` → tab 1 is the agent pane alone.
- Legacy string tabs → `{ name: commandName(cmd), command: cmd, panes: [] }` appended after tab 1.
- New-shape entries: fill every missing field with the defaults above; a tab with no `command` and no (or empty) `panes` gets `panes: []` and `command: ""` (a plain shell); `tabs: []` becomes `[{ name: "shell", folder: "", command: "", panes: [] }]`.
- Drop `agent`, `args`, `prompt`, `promptMode`, `layout` from `startup` afterwards.

`tabPlan` fills defaults and throws, in this wording: `Tab 2 needs a name`; `Tab "api": a tab has either a command or panes, not both`; `Tab "api": pane "db" needs direction "right" or "down"`; `Tab "api": pane "db" has an unknown type "x"`; `Tab "api": command pane "db" has no command`; `Tab "api": pane "db" splits "y", which does not come before it`; `Tab "api": two panes are called "db"`. A tab with `command` or nothing becomes one pane: `{ type: "command", command }` or `{ type: "shell" }`. Pane names default to `agent` for an agent pane else `pane<N>` (1-based). The first pane of a tab has `direction: ""` and `from: ""`; later panes default `direction` to `"down"` and `from` to the previous pane's name. `layoutPlan(layout)` becomes `tabPlan([{ name: layout.name, panes: layout.panes }])[0].panes.slice(1)` so the existing layout tests keep passing.

- [ ] **Step 1: Write the failing tests in `test/lib.test.mjs`**

```js
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
```
Then update the existing tests that assert the old shape: `"normalize gives every project an empty layout"` (line 185) becomes `"normalize gives every project tabs"` asserting `Array.isArray(normalize({ path: "/a" }).startup.tabs)`; `"the default template is a project with no folder and some starting settings"` (280), `"duplicateProject copies the settings…"` (297), `"duplicating the template…"` (312), `"startFromTemplate…"` (321) change their `startup.agent` / `startup.layout` assertions to the tab-model ones above; `"blankProject and normalize"` (106) asserts the new `startup` default.

- [ ] **Step 2: Run the tests to verify they fail**

Run: `node --test test/lib.test.mjs`
Expected: the new tests fail with `tabPlan is not a function` and shape mismatches; the updated old ones fail on `startup.tabs`.

- [ ] **Step 3: Implement in `mods/projects/lib.js`**

The signatures and rules in Interfaces. `layoutPlan` keeps its name and callers. `resolveFolder` collapses segments with a small loop over `split("/")` (no `path` module in the runtime).

- [ ] **Step 4: Run the tests to verify they pass**

Run: `node --test test/lib.test.mjs`
Expected: PASS, all.

- [ ] **Step 5: Write the failing config test in `test/config.test.mjs`**

```js
test("loadConfig hands the file's layouts to normalize, so a legacy layout name expands", async () => {
  mkdirSync(`${state.appHome}/data`, { recursive: true });
  writeFileSync(`${state.appHome}/data/projects.json`, JSON.stringify({ layouts: [{ name: "mine", panes: [{ type: "agent" }, { type: "shell", direction: "right" }] }], projects: [{ name: "a", path: "/a", startup: { agent: "claude", layout: "mine" } }] }));
  const c = await loadConfig();
  assert.equal(c.projects[0].startup.tabs[0].panes.length, 2);
});
```

- [ ] **Step 6: Run it, see it fail, implement, see it pass**

Run: `node --test test/config.test.mjs` → FAIL on `panes.length` (1 ≠ 2). Change `loadConfig` in `config.js` to `normalize(p, layouts)` with the file's `layouts` read first. Run again → PASS.

- [ ] **Step 7: Run everything and commit**

Run: `node --test test/` Expected: PASS (UI and git tests still pass because `normalize` upgrades their legacy `startup` overrides).

```bash
git add mods/projects/lib.js mods/projects/config.js test/lib.test.mjs test/config.test.mjs
git commit -m "Model a project as tabs with panes"
```

### Task 3: workspace.js, the one build path

**Files:**
- Create: `mods/projects/workspace.js`
- Modify: `mods/projects/git.js` (remove `launch`, `findNewSpace`, `buildLayout`, `liveTerminals`, `findNewTerminal`, `sendWhenReady`, `exclusive`, `lockSettings`, `sleep`; keep `folderExists`, `findSpace`, everything git)
- Modify: `test/helpers/herdr-stub.mjs` (`herdr-app do tab.new`, richer `herdr-app ls`)
- Create: `test/workspace.test.mjs` (the launch tests from `test/git.test.mjs` lines 248–365 move here and are adapted)
- Test: `test/workspace.test.mjs`, `test/git.test.mjs`

**Interfaces:**
- Consumes: `tabPlan`, `resolveFolder`, `firstAgent`, `splitArgs`, `inFolder` from `lib.js`; `folderExists`, `findSpace`, `projectFolder` from `git.js`; `exec`, `hc`, `run`, `focused`, `spaces`, `home` from `herdr`.
- Produces, exported from `workspace.js`:
  - `buildWorkspace({ project, folder, name, tabs, prompt, log })` → `Promise<{ space: string, agentTerminal: string | null }>`. `tabs` is the launch's tab list (from `tabsForLaunch`); `prompt` is the launch's prompt text (`""` for none); `log(message)` reports a busy-screen line. Throws before creating anything when `tabPlan` throws or a folder is missing: `Tab "web" pane 1: folder does not exist: /p/frontend`. Phase 2 adds `agentTiming` and `existing`; phase 1 always starts the agent at once.
  - `lockSettings` (moved, same shape `{ seconds }`), `sendWhenReady(terminal, folder, text)` (moved), `liveTerminals()` (moved).
  - Stub: `exec("herdr-app", ["do", "tab.new", json])` records to `state.tabsMade` and answers `{ space, tab, terminal }`, adding a terminal with `cwd: json.folder` and a tab `{ id, terminals: [{ terminal, pane: "pane-of-<tab>" }] }` under the space; `herdr-app ls` lists those tabs after the first. The `pane.split` branch pushes its terminal with the **same address the reply returns** (`t-pane-N`, today it pushes `t<nextId>`) and with `status: state.agentStatus`, so `sendWhenReady` can find a split agent's terminal.

Behavior of `buildWorkspace`, in order:
1. `plan = tabPlan(tabs)`.
2. `env` from `exec("env", [])` parsed line-by-line at the first `=`; cache per call.
3. For every tab and pane, `resolveFolder(folder, pane.folder || tab.folder, home(), env)`; `folderExists` each distinct one; the first missing throws as above. Nothing is created before this point.
4. Prompt check: if `prompt` and `firstAgent(plan) === null`, `log("no agent pane to prompt: the prompt is ignored")`.
5. Inside `exclusive`: repo-space opening as today; tab 1 pane 1 by `run("space.new", { name, folder: paneFolder, argv, task })` where `argv` is `agentArgv(pane, prompt)` for an agent (`[...splitArgs(agent), ...splitArgs(args)]` plus `prompt` as a last element when `promptMode === "arg"` and the pane is the first agent and it is not tab 1 pane 1; for tab 1 pane 1 the prompt goes in `task` instead), `["sh", "-c", command]` for a command, nothing for a shell. `findNewSpace` as today, returning also the first terminal.
6. Tab 1's other panes: `herdr-app do pane.split { direction, pane: ids[from], argv: inFolder(paneFolder, argv) }` as today's `buildLayout`, generalized; the reply's `terminal` is kept per pane.
7. Later tabs: `exec("herdr-app", ["do", "tab.new", JSON.stringify({ space, name, folder, argv })])`, then the tab's root pane id from `herdr-app ls` (the terminal's `pane`), then its splits as in 6.
8. `run("pane.focus", { pane })` on the first agent's pane, else tab 1 pane 1.
9. `send` mode: the first agent's terminal is the split or `tab.new` reply's `terminal`, or for tab 1 pane 1 `findNewTerminal` as today; then `sendWhenReady`. Return `{ space, agentTerminal }`.

- [ ] **Step 1: Move the launch tests and write the new ones in `test/workspace.test.mjs`**

Move tests at `test/git.test.mjs` lines 248–365 (from "launch without an agent opens a bare space" through "the repo's space is not reopened…") into the new file, importing `../mods/projects/workspace.js` and calling `buildWorkspace({ project, folder, name, tabs: project.startup.tabs, prompt, log })` in place of `launch(project, folder, name, layout)`. Where a test passed a `layout`, pass `tabs: tabsForLaunch(project, [layout], layout.name)`. Projects in these tests are built with `normalize` from legacy overrides, so their tabs come from the upgrade. Then add:

```js
test("a multi-tab project opens each later tab in its own folder with its command", async () => {
  const dir = realpathSync(makeRepo()); mkdirSync(join(dir, "web")); mkdirSync(join(dir, "api"));
  const p = normalize({ name: "Shop", path: dir, startup: { tabs: [{ name: "agent", panes: [{ type: "agent", agent: "claude" }] }, { name: "web", folder: "web", command: "npm run dev" }, { name: "api", folder: "api", panes: [{ command: "make run" }, { command: "psql", direction: "right" }] }] } });
  await buildWorkspace({ project: p, folder: dir, name: "Shop", tabs: p.startup.tabs, prompt: "", log: () => {} });
  assert.deepEqual(state.tabsMade.map((t) => [t.name, t.folder, t.argv]), [["web", `${dir}/web`, ["sh", "-c", "npm run dev"]], ["api", `${dir}/api`, ["sh", "-c", "make run"]]]);
  assert.equal(state.splits.length, 1);
  assert.equal(state.splits[0].argv[4], `${dir}/api`);
});
test("a missing tab or pane folder stops the launch before any space is made, naming it", async () => {
  const dir = realpathSync(makeRepo());
  const p = normalize({ name: "S", path: dir, startup: { tabs: [{ name: "agent", command: "" }, { name: "web", folder: "nope", command: "x" }] } });
  await assert.rejects(buildWorkspace({ project: p, folder: dir, name: "S", tabs: p.startup.tabs, prompt: "", log: () => {} }), /Tab "web" pane 1: folder does not exist: .*nope/);
  assert.equal(state.runs.length, 0);
});
test("a prompt with no agent pane anywhere is reported, not sent", async () => {
  const dir = realpathSync(makeRepo()); const notes = [];
  const p = normalize({ name: "S", path: dir, startup: { tabs: [{ name: "s" }] } });
  await buildWorkspace({ project: p, folder: dir, name: "S", tabs: p.startup.tabs, prompt: "do it", log: (m) => notes.push(m) });
  assert.ok(notes.some((n) => /no agent pane to prompt/.test(n)));
  assert.equal(state.sent.length, 0);
  assert.equal(state.runs.find((r) => r.command === "space.new").args.task, undefined);
});
test("an agent in a later pane gets an arg prompt on its command line and a send prompt into its own terminal", async () => {
  const dir = realpathSync(makeRepo());
  const mk = (promptMode) => normalize({ name: "S", path: dir, startup: { tabs: [{ name: "t", panes: [{ type: "shell" }, { type: "agent", agent: "claude", promptMode, direction: "right" }] }] } });
  await buildWorkspace({ project: mk("arg"), folder: dir, name: "S", tabs: mk("arg").startup.tabs, prompt: "hi", log: () => {} });
  assert.deepEqual(state.splits[0].argv.slice(-2), ["claude", "hi"]);
  reset();
  await buildWorkspace({ project: mk("send"), folder: dir, name: "S", tabs: mk("send").startup.tabs, prompt: "hi", log: () => {} });
  assert.equal(state.sent[0].terminal, "t-pane-1");
});
test("folders expand ~ and $VAR", async () => {
  const dir = realpathSync(makeRepo()); mkdirSync(join(dir, "sub"));
  process.env.PJ_TEST_SUB = "sub";
  const p = normalize({ name: "S", path: dir, startup: { tabs: [{ name: "a" }, { name: "b", folder: "$PJ_TEST_SUB", command: "x" }] } });
  await buildWorkspace({ project: p, folder: dir, name: "S", tabs: p.startup.tabs, prompt: "", log: () => {} });
  assert.equal(state.tabsMade[0].folder, `${dir}/sub`);
});
```

- [ ] **Step 2: Run to verify failure**

Run: `node --test test/workspace.test.mjs`
Expected: FAIL, `Cannot find module '../mods/projects/workspace.js'`.

- [ ] **Step 3: Extend the stub, create `workspace.js`, slim `git.js`**

Stub: `state.tabsMade = []` (reset too); the `tab.new` branch and `ls` listing described in Interfaces. `workspace.js`: the behavior list above; move the named functions out of `git.js` verbatim where they do not change. `main.js` still imports `launch` from `git.js` at this point: change that import to `buildWorkspace` from `./workspace.js` and the one call in `start()` to `await buildWorkspace({ project: p, folder, name, tabs: tabsForLaunch(p, this.layouts, this.layoutNameFor(p)), prompt: firstAgent(p.startup.tabs)?.pane.prompt ?? "", log })` so the app keeps working (the picker's own changes come in Task 4). `this.layouts` is the offered list (built-ins plus the user's), which is what `tabsForLaunch` looks a name up in.

- [ ] **Step 4: Run all tests to verify they pass**

Run: `node --test test/`
Expected: PASS. `git.test.mjs` has no launch tests left; `ui.test.mjs` launch tests (lines 198–240 upstream) still pass through the stub.

- [ ] **Step 5: Check the mod loads and commit**

Run: `herdr-app check mods/projects` → exit 0.

```bash
git add mods/projects/workspace.js mods/projects/git.js mods/projects/main.js test/workspace.test.mjs test/git.test.mjs test/helpers/herdr-stub.mjs
git commit -m "Build a workspace from a project's tabs in one place"
```

### Task 4: The picker and the detail card on the tab model

**Files:**
- Modify: `mods/projects/main.js` (`layoutNameFor`, `cycleLayout`, `footer`, `renderCard`, `renderTemplateCard`, `renderList`, `start`, `agentIcon`, `layoutThumb` call sites)
- Test: `test/ui.test.mjs`

**Interfaces:**
- Consumes: `tabsForLaunch`, `firstAgent`, `tabLabels`, `layoutRects` from `lib.js`; `buildWorkspace` from `workspace.js`.
- Produces: `layoutNameFor(p)` → `this.layoutPick ?? ""` where `""` now means "the project's own tabs"; the card's layout choices are `[{ name: "", label: "Project's tabs", panes: tabs[0].panes }, ...this.layouts]`; the "project default" caption sits under the `""` choice; `nextLayout` cycles `""` then each layout as before.

- [ ] **Step 1: Update and add UI tests**

Update: `"the card shows every layout as a picture, with the project's own lit"` (123), `"with no layout set, 'Agent only' is lit"` (130) → `"with nothing picked, the project's own tabs are lit"`, `"a pick counts only while it differs from the project's own layout"` (149), `"a project's layout is built when it opens"` (206), `"a layout picked at launch wins over the project's own, and 'Agent only' means no splits"` (215) → `"…and the project's own means its tabs"`, `"the card's layout pictures draw each layout's panes"` (664), `"with the card on, the buttons are in the card only once and the layout choice is the pictures"` (707): replace `"Agent only"` with `"Project's tabs"` and the legacy `startup.layout` reads with the first choice. `"an unknown layout name stops before anything is created…"` (231): set `v.layoutPick = "nope"` instead of a project `startup.layout`. Add:

```js
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
  enter(v); await cx.settle();
  assert.deepEqual(state.tabsMade.map((t) => t.name), ["web"]);
});
```

- [ ] **Step 2: Run to verify failure**

Run: `node --test test/ui.test.mjs`
Expected: the new and updated tests fail (no "Project's tabs" text, no `server ×2`).

- [ ] **Step 3: Implement in `main.js`**

`renderCard`: an `Agent` row from `firstAgent(p.startup.tabs)` (icon as today via the pane's `agent`), a `Tabs` row joining `tabLabels(p.startup.tabs)` with ` · `, a `Description` line under the title when set; `layoutThumb` for the `""` choice draws `layoutRects({ panes: tabs[0].panes })`. `agentIcon(t, p)` reads `firstAgent(p.startup.tabs)?.pane.agent ?? ""`. `renderList` row: unchanged. `footer`'s choice labels: `choice("", "Project's tabs")`. `start()`: `const tabs = tabsForLaunch(p, this.layouts, this.layoutNameFor(p))` (throws the "No layout called" error before anything is created), `prompt` = the first agent pane's `prompt` (phase 2 replaces this with the launch screen's box), then `buildWorkspace`. Keep the "Waiting for the agent…" note for `send` mode. The error text for a stale pick stays `No layout called "<name>". Layouts: …`.

- [ ] **Step 4: Run all tests, check the mod, try it**

Run: `node --test test/` → PASS. `herdr-app check mods/projects` → 0. In the app: open the picker, select a project, see the card's Tabs row and the "Project's tabs" picture; `herdr-app shot /tmp/projects-phase1-task4.png`.

- [ ] **Step 5: Commit**

```bash
git add mods/projects/main.js test/ui.test.mjs
git commit -m "Show and launch a project's tabs from the picker"
```

### Task 5: The editor's Tabs list, Description and Agent timing

**Files:**
- Modify: `mods/projects/main.js` (`TEXT`, `SECTION_FIELDS`, `openEditor`, `save`, `focusNextField`, `renderEdit`; new methods below)
- Test: `test/ui.test.mjs`

**Interfaces:**
- Consumes: `tabPlan`, `firstAgent`, `blankPane`, `allLayouts` from `lib.js`; `InputState`/`Input` from gpui-base.
- Produces, on the view:
  - `TEXT` loses `agent`, `args`, `prompt`, `layout`, `tabs`; gains `["description", "Description", (p) => p.description, (p, v) => (p.description = v)]` in the `project` section. `SECTION_FIELDS.startup = ["setup"]`.
  - `this.tabAt: number`, `this.paneAt: number | null` (selected tab and pane in the draft).
  - `this.inputs: WeakMap<object, Record<string, InputState>>` keyed by the tab or pane object; `boxFor(obj, field)` returns the existing state or makes one with `value: obj[field] ?? ""`.
  - Methods: `addTab()` pushes `{ name: "", folder: "", command: "", panes: [] }` and selects it; `removeTab()`; `moveTab(delta)`; `addPane()` pushes `blankPane({ direction: "down" })` to the selected tab (converting a `command` tab first: its command becomes `blankPane({ type: "command", command })` as pane 1 and `command` becomes `""`); `removePane()`; `movePane(delta)`; `setPaneType(type)`; `cycleDirection()` right ↔ down on the selected pane; `panesFromLayout(name)` replaces the selected tab's panes with `layout.panes.map(blankPane)`, carrying the tab's first agent pane's `agent`, `args`, `prompt`, `promptMode` into the layout's first agent pane; `collectTabs()` writes every box's value back into the draft objects.
  - Element ids: `pp-tab-add`, `pp-tab-del`, `pp-tab-up`, `pp-tab-down`, `pp-tab-<i>` (a row), `pp-pane-add`, `pp-pane-del`, `pp-pane-up`, `pp-pane-down`, `pp-pane-<j>` (a row), `pp-ptype-agent|shell|command`, `pp-pdir`, `pp-fromlay-<i>`, `pp-timing`, and the agent chips `pp-agent-shell`, `pp-agent-<i>` as today but writing the selected agent pane's `agent` box.
  - `save()` runs `collectTabs()` then `tabPlan(d.startup.tabs)` and shows its message as the error on failure.

Layout of the Startup section, top to bottom: Setup commands box (`;;` stays this phase); `Agent timing: after setup | with setup` button (`pp-timing`, toggles `d.startup.agentTiming`); label "Tabs"; the tab rows (name or "(unnamed)", folder, `command` or `N panes`), the selected one highlighted; the four tab buttons; under them the selected tab's fields: Name, Folder, Command (only when it has no panes), then "Panes" with its rows (`type`, command or agent, direction), the four pane buttons and `pp-fromlay-*` chips ("Panes from: Agent + terminal below", …); then the selected pane's fields: type chips, Direction button (not on pane 1), Folder, and for `command` a Command box, for `agent` the agent chips plus Agent command, Arguments, First prompt, Prompt delivery button as today. Tab moves between the boxes of the current section in document order (`focusNextField` walks a list `this.fieldOrder` rebuilt in `renderEdit`).

- [ ] **Step 1: Update and add UI tests**

Update `"the editor renders all four sections"` (324) to expect "Description" in Project and "Tabs" in Startup; `"the startup section offers every agent…"` (337) and `"clicking an agent chip fills the agent field; Hermes switches…"` (355) to first select pane 1 of tab 1 (`press`/click `pp-pane-0`) in a project whose tab 1 pane 1 is an agent, and to read the agent box through `v.boxFor(v.draft.startup.tabs[0].panes[0], "agent")`; `"a layout typed in the editor is saved with the project and used on the next open"` (546) becomes `"panes chosen from a layout in the editor are saved and built on the next open"` using `pp-fromlay-0`; `"saving keeps a folder's trailing space, the layouts and other keys"` (374) keeps passing. Add:

```js
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
```

- [ ] **Step 2: Run to verify failure**

Run: `node --test test/ui.test.mjs`
Expected: FAIL, `v.addTab is not a function` and the section text assertions.

- [ ] **Step 3: Implement in `main.js`**

The Interfaces block. `collectTabs()` iterates the draft's tabs and panes, reading each known box in `this.inputs.get(obj)` back into the object; fields with no box keep their value. Removing the selected tab selects the previous one (or none when empty: the list then shows "No tabs: a plain shell").

- [ ] **Step 4: Run all tests, check, try it**

Run: `node --test test/` → PASS. `herdr-app check mods/projects` → 0. In the app: Edit a project, add a tab with a folder and a command, add a pane, save, reopen the editor and see them; `herdr-app shot /tmp/projects-phase1-task5.png`.

- [ ] **Step 5: Commit**

```bash
git add mods/projects/main.js test/ui.test.mjs
git commit -m "Edit a project's tabs and panes in the editor"
```

### Task 6: Docs, demo hook and the phase's done-when checks

**Files:**
- Modify: `RECIPE.md` (What you see: the card's Tabs row and the editor's Tabs list; How it behaves: tabs and panes, folder checks; Built from: `workspace.js`, the data model block from spec 4; Watch out: `ratio`/`label` unsupported, `terminal.open` cannot target a pane; Done when: the phase 1 list below), `README.md` (a "Projects file" section with the spec's example JSON), `mods/projects/demo.js` header comment (unchanged keys, mention `"tab"`/`"pane"` selection: `{ "view": "edit", "section": "startup", "tab": 1, "pane": 0 }`), `mods/projects/main.js` `applyDemo` (honor `tab` and `pane`)
- Test: `test/ui.test.mjs` (one demo test)

**Interfaces:**
- Consumes: Task 5's `tabAt`, `paneAt`.
- Produces: nothing new for later phases.

- [ ] **Step 1: Write the failing demo test**

```js
test("a demo file can open the editor on a given tab and pane", async () => {
  const { v } = await open([proj("shop", "/r/shop", { startup: { tabs: [{ name: "a" }, { name: "b", panes: [{ type: "shell" }, { type: "shell", direction: "down" }] }] } })]);
  v.applyDemo({ view: "edit", project: "shop", section: "startup", tab: 1, pane: 1 });
  assert.deepEqual([v.mode, v.section, v.tabAt, v.paneAt], ["edit", "startup", 1, 1]);
});
```

- [ ] **Step 2: Run, fail, implement `applyDemo`'s two lines, pass**

Run: `node --test test/ui.test.mjs` → FAIL on `tabAt`. Add `if (d.tab != null) this.tabAt = d.tab; if (d.pane != null) this.paneAt = d.pane;` after `showSection` in `applyDemo`. Run again → PASS.

- [ ] **Step 3: Update RECIPE.md and README.md as listed in Files**

Done-when list for RECIPE.md (each one something the build does):
- `herdr-app check mods/projects` and `mods/projects-launcher` pass; `ctrl-alt-p` / `cmd-alt-p` opens a popup titled Projects.
- A `data/projects.json` copied from a project-presets file opens the same spaces it did there: the agent with its prompt, the layout's panes, the extra tabs.
- The Shop example from the spec (four tabs, two folders, a split api tab) opens four tabs named agent, web, api, git with web in `frontend/`, api in `backend/` split right into `backend/db`, and git running lazygit.
- A tab whose folder does not exist is refused with `Tab "web" pane 1: folder does not exist: …` and no space is created.
- The card lists `server ×2` for a split tab and shows the first agent pane's agent.
- The editor adds, removes and reorders tabs and panes, applies a shipped layout's panes to a tab, and Save refuses a nameless tab with `Tab 2 needs a name`.

- [ ] **Step 4: Run the done-when list in the app**

Make a throwaway repo with `frontend/`, `backend/`, `backend/db/`; add it as a project with the spec's Shop tabs (agent `claude`, commands you have, e.g. `top` in place of `npm run dev`); open it; `herdr-app ls` shows four tabs; `herdr-app shot /tmp/projects-phase1-done.png`. Then edit a tab's folder to `nope` and open again: the busy screen shows the folder error and `herdr-app ls` shows no new space. Record the outcomes in the commit body.

- [ ] **Step 5: Run everything and commit**

Run: `node --test test/ && herdr-app check mods/projects && herdr-app check mods/projects-launcher` → all green.

```bash
git add RECIPE.md README.md mods/projects/demo.js mods/projects/main.js test/ui.test.mjs
git commit -m "Document the tab model and the phase 1 checks"
```
