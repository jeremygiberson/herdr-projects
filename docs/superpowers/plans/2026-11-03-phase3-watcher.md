# Projects mod, phase 3: the resident watcher. Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** A space opened outside the picker (the app's New worktree menu, the native new-space shortcut inside a project's checkout) gets the project's copy, setup and tabs applied once, a few seconds after it appears.

**Architecture:** The host refuses imports across mod folders, so the resident copy is the `projects` mod itself: the layout's launcher block loads `mods/projects` with a `slot` prop, and that copy draws the Projects button and runs a watcher (`watch.js`) that diffs `spaces()` on a timer, matches a new one-pane space to a project (or a global `autoLayouts` entry), and builds into it through the existing `prepareSetup` and `buildWorkspace`, which gains an `existing` parameter. The launch lock moves to shared state so the picker copy and the resident copy serialize. The separate `projects-launcher` mod folder is retired.

**Tech Stack:** JavaScript ES modules on gpui-kit inside herdr-app 0.1.12 with hc 0.1.17; `node --test test/*.test.mjs` with the stubs in `test/helpers/`; `herdr-app check`; git; `hc send` (pastes a line and presses Enter).

**Spec:** `docs/superpowers/specs/2026-11-02-projects-mod-design.md`, section 6 (the watcher), 4.1 (`defaultAgent`), 8 (`existing`, the shared-state lock), phase 3 of 9, 11. One spec change this phase makes and records: the resident copy is the `projects` mod in the launcher block, not a separate mod (section 6's first paragraph and section 8's cross-folder note).

## Global Constraints

- Host: `herdr-app 0.1.12`, `hc 0.1.17`. Mods run in the app's runtime: no `setTimeout`/`structuredClone`; `cx.timer`/`cx.spawn` only; host objects only in event paths. Mods cannot import across folders. A mod copy starts the first time its block shows and stays alive while the block is in the layout, shown or hidden; its timers keep running while hidden.
- The picker's `render()` reads no live herdr data. The watcher is different by design: its work is driven by a 2 s timer that reads `spaces()` and compares ids; it never does git or app commands inside `render()`.
- Trigger is appearance, never focus. Every space present when the watcher starts is already seen. A space is considered once. Only local spaces (`machine === null`).
- Match: the space's folder equals a project's checkout or is a linked worktree of its repo (same `repoKey`: the realpath of `git rev-parse --git-common-dir`), and the project has `worktree.autoLayout: true`; else a global `autoLayouts` entry by repo basename and branch with precedence repo+branch > repo > `*`+branch > `*`. Only one project per repo may have `autoLayout` on; saving enforces it.
- The one-pane guard: the space has exactly one tab with `panes === 1`. Its pane is a plain shell (`program.shell`) or a running agent (listed by `agents()`); any other program is left alone.
- Spaces the picker itself opened are skipped: `buildWorkspace` records `projects.opening[folder] = Date.now()` in shared state before `space.new`, and the watcher ignores a new space whose folder has an entry younger than 60 s.
- The watcher path uses the project's `agentTiming` and no prompt. A running agent is adopted as the project's first agent pane and the chain goes to a setup tab (forced `with`). A plain shell gets the lead line typed into it with `hc send <terminal> -- <line>` once the shell is in front (`hc get` foreground is bash/sh/zsh/fish/dash).
- `prepareSetup` decides copy and worktree setup from the marker (`isNewWorktree`), so a worktree already marked gets only `startup.setup`; a checkout gets only `startup.setup`.
- The launch lock is `projects.lock` in shared state (`{ since }`); a holder older than 25 s is stale; both copies wait on it.
- Pure logic in `lib.js`; `herdr` calls in `watch.js`, `workspace.js`, `setup.js`, `git.js`, `config.js`, `main.js`. Test command `node --test test/*.test.mjs`; `herdr-app check mods/projects` after every task touching `mods/`. Style 2-space, double quotes, semicolons. Commit after every task.

## Review Focus

1. A new space on the project's checkout where the person already `cd`'d elsewhere before the watcher ran: the space's folder has moved, so it must not match (the folder is read once, at appearance). (Task 3 test: folder changed before the tick → no build.)
2. Two spaces appearing in the same tick (the app restores several at once): each is considered, builds serialize on the lock, and none is lost. (Task 3 test.)
3. A space whose only pane runs a non-shell, non-agent program (`top`): left alone, marked seen, never revisited. (Task 3 test.)
4. The picker launches into a project folder while the watcher is on: the watcher must not build a second time into that space. (Task 3 test using `projects.opening`.)
5. Saving a second project with `autoLayout` on the same repo turns the first one's off and tells the person. (Task 5 test.)

---

### Task 1: The model: `autoLayout`, `autoLayouts`, `defaultAgent`, `repoKey`

**Files:**
- Modify: `mods/projects/lib.js`, `mods/projects/config.js`, `mods/projects/git.js`, `test/lib.test.mjs`, `test/config.test.mjs`, `test/git.test.mjs`

**Interfaces:**
- `blankProject()`: `worktree.autoLayout: false`; `normalize` coerces with `Boolean`.
- `loadConfig()` also returns `autoLayouts` (array, default `[]`, each entry normalized to `{ repo: string, branch: string, layout: string }` with `repo` defaulting to `"*"` and `branch` to `""`) and `defaultAgent` (`{ agent: string, args: string }` or `null`); `saveConfig` keeps both as it keeps `layouts`.
- `matchAutoLayout(entries, repo, branch)` → the best entry or `null`: `repo` compares case-insensitively; precedence repo+branch (4) > repo (3) > `*`+branch (2) > `*` (1); ties by order in the list.
- `tabsForAuto({ project, layouts, entry, defaultAgent })` → tabs: with a `project`, `tabsForLaunch(project, layouts, "")`; else the layout named by `entry.layout` from `layouts` (a `tabs` layout as is; a `panes` layout as one tab named `agent`), with every agent pane lacking `agent` filled from `defaultAgent` or turned into a shell; throws `No layout called "<name>"` for an unknown one.
- `git.js`: `repoKey(folder)` → `Promise<string | null>`: the realpath of `git -C <folder> rev-parse --git-common-dir` (joined to `folder` when relative, then `realPath`), or `null` when not a repo. `branchOf(folder)` → `git rev-parse --abbrev-ref HEAD` or `null`.

- [ ] **Step 1: Write the failing tests**

```js
// lib
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
// config
test("loadConfig reads autoLayouts and defaultAgent with defaults, and saveConfig keeps them", async () => { /* write a file with autoLayouts: [{ layout: "x" }], defaultAgent: { agent: "claude" }; load → autoLayouts[0] deepEquals { repo: "*", branch: "", layout: "x" }, defaultAgent deepEquals { agent: "claude", args: "" }; save projects; re-read raw JSON still has both keys */ });
// git
test("repoKey is the same for a checkout and its linked worktree, and null outside a repo", async () => { /* makeRepo, worktree add; assert equal; scratch() → null */ });
test("branchOf reports the checked-out branch", async () => { /* main for makeRepo; the worktree's branch for the worktree */ });
```
Write the elided bodies fully in the style of the files' existing tests.

- [ ] **Step 2: Run to verify failure** → `node --test test/lib.test.mjs test/config.test.mjs test/git.test.mjs` FAIL.
- [ ] **Step 3: Implement.**
- [ ] **Step 4: Full suite, check, commit** — `git commit -m "Model auto-layout projects and global auto layouts"`.

### Task 2: `buildWorkspace({ existing })`, the shared lock and the opening marker

**Files:**
- Modify: `mods/projects/workspace.js`, `test/helpers/herdr-stub.mjs`, `test/workspace.test.mjs`

**Interfaces:**
- `exclusive(fn)` now takes the shared lock: read `shared("projects.lock")`; while it holds `{ since }` younger than 25 s, `sleep(0.25)` and re-read; then `setShared("projects.lock", { since: Date.now() })`, run `fn`, and clear it (`setShared("projects.lock", null)`) in `finally`. The module-level promise chain stays as a second guard inside one copy.
- Before `space.new`, `buildWorkspace` sets `shared("projects.opening")` to `{ ...old, [dirs[0][0]]: Date.now() }` (entries older than 5 min pruned).
- `buildWorkspace({ …, existing })` where `existing = { space, tab, pane, terminal, folder, agent }` (`agent` true when an agent already runs in that pane). With `existing`:
  - No `space.new`; `space`/first pane/first terminal come from `existing`; the `name` argument is unused.
  - `existing.agent` false (a plain shell): the line for pane (0,0) is `argvOf(0,0)` rendered as a shell line: a chain-then-agent line as is; a bare agent argv as `exec <quoted argv>`; a command as the command; a shell pane types nothing. It is typed with `hc(["send", terminal, "--", line])` once the shell is in front: poll `hc get <terminal> --json` up to 20 × 0.5 s until `"foreground":{"name":"<shell>"}` with a shell name, else log `couldn't type into the new space's shell` and skip the line. A `send`-mode prompt never applies (no prompt in this path).
  - `existing.agent` true: the plan's first agent pane counts as fulfilled by the existing pane; `agentTiming` is forced `"with"`; the chain (if any) goes to the setup terminal as in `with`; if the plan's first agent pane is not (0,0), that pane is built as a plain shell (no second agent); nothing is typed into the existing pane.
  - Tab 1's other panes split from `existing.pane`; later tabs as today; focus back to the existing pane.
- Stub: `hc(["send", …])` already records; `hc get` answers `foreground.name` from `state.foreground` (today `"claude"`); tests set `state.foreground = "zsh"` for the shell case. `shared`/`setShared` already exist.

- [ ] **Step 1: Write the failing tests**

```js
test("the shared lock is taken for a build and released after it; a stale lock is ignored", async () => { /* setShared("projects.lock", { since: Date.now() - 30000 }); build; assert shared("projects.lock") === null afterwards; and during the build (await a spawn that reads it mid-way) it holds a recent since */ });
test("buildWorkspace records the folder it is opening in projects.opening before space.new", async () => { /* build; assert shared("projects.opening")[dir] is a recent timestamp */ });
test("existing shell space, after timing: the chain-then-agent line is typed into the shell once it is in front, no space.new", async () => {
  const dir = realpathSync(makeRepo()); state.foreground = "zsh";
  const p = normalize({ name: "S", path: dir, startup: { tabs: [{ name: "agent", panes: [{ type: "agent", agent: "claude" }, { type: "shell", direction: "down" }] }, { name: "git", command: "lazygit" }] } });
  state.terminals.push({ address: "tX", cwd: dir, state: "live", status: null });
  await buildWorkspace({ project: p, folder: dir, name: "S", tabs: p.startup.tabs, prompt: "", agentTiming: "after", chain: "true", log: () => {}, existing: { space: "spX", tab: "tbX", pane: "paneX", terminal: "tX", folder: dir, agent: false } });
  assert.equal(state.runs.some((r) => r.command === "space.new"), false);
  const sent = state.sent.find((s) => s.terminal === "tX");
  assert.match(sent.text, /^true && cd '.*' && exec 'claude' \|\| exec "\$SHELL"$/);
  assert.equal(state.splits[0].pane, "paneX");
  assert.deepEqual(state.tabsMade.map((t) => [t.space, t.name]), [["spX", "git"]]);
});
test("existing shell space, with timing: exec agent is typed and the chain goes to the setup terminal", async () => { /* assert sent text === "exec 'claude'" and an hc run with herdr.space=spX */ });
test("existing agent space: nothing is typed, timing is forced with, the plan's agent pane elsewhere becomes a shell", async () => { /* plan: tab 1 [shell], tab 2 [agent]; existing.agent true; chain "true"; assert state.sent empty, setup terminal started, tab 2's tab.new argv is absent (shell) */ });
test("existing shell space whose shell never comes to the front: the line is skipped and logged, the rest still builds", async () => { /* state.foreground = "claude" (not a shell); assert no send, a log line, splits still made */ });
```

- [ ] **Step 2: Run to verify failure.**
- [ ] **Step 3: Implement** (`existing` handling as a small `adoptExisting()` helper beside `startSetupTerminal`; `typeLine(terminal, line)` with the readiness poll).
- [ ] **Step 4: Full suite, check, commit** — `git commit -m "Build into a space that already exists, under a shared lock"`.

### Task 3: `watch.js`, the watcher

**Files:**
- Create: `mods/projects/watch.js`, `test/watch.test.mjs`
- Modify: `test/helpers/herdr-stub.mjs` (`agents()`, `panes()`, `spaces()` with `tabs` and `machine`)

**Interfaces:**
- `export class Watcher { constructor({ loadConfig, prepareSetup, buildWorkspace, repoKey, branchOf, log }) }` with the real functions injected by `main.js` and stubs by tests.
- `start(cx)`: `this.seen = new Set(spaces().map((s) => s.id))`; `cx.timer.every(2000, (cx) => this.tick(cx))`.
- `tick(cx)`: for each local space not in `seen`: add to `seen`, and `cx.spawn(async () => this.consider(space))` (never awaited in the tick). `consider` runs the builds sequentially through a module-level promise chain so two new spaces in one tick build one after the other.
- `consider(space)`: guards in order, each logged at debug and returning: `space.machine !== null`; `space.tabs.length !== 1 || space.tabs[0].panes !== 1`; `shared("projects.opening")?.[space.folder]` younger than 60 s; the pane (from `panes()` with `tab === space.tabs[0].id`) is neither `program.shell` nor an agent (`agents().some((a) => a.space === space.id)`). Then `key = await repoKey(space.folder)` (null → return); `config = await loadConfig()`; a project with `worktree.autoLayout && (await repoKey(projectFolder(p))) === key` (the first in file order; Task 5 enforces one) → `{ project }`; else `matchAutoLayout(config.autoLayouts, basename(key's parent folder), await branchOf(space.folder))` → `{ entry }`; else return. `isWorktree = realpath(space.folder) !== realpath(projectFolder(project))` (for an entry: true when `space.folder` is not the repo's main checkout, i.e. `git rev-parse --git-common-dir` differs from `--git-dir`); `tabs = tabsForAuto(...)`; `{ chain } = await prepareSetup({ project: project ?? blankProject(space.folder), folder: space.folder, isWorktree, branch, repo, home, log })` (for an entry, copy and worktree setup are empty, so only the project case runs them); `await buildWorkspace({ project, folder: space.folder, name: space.name, tabs, prompt: "", agentTiming: project?.startup.agentTiming ?? "with", chain, log, existing: { space: space.id, tab: space.tabs[0].id, pane, terminal, folder: space.folder, agent } })`. Errors are caught and logged; a toast `notify({ title: "Projects", body: "<project> set up in <space>" })` on success and `notify({ level: "error", … })` on failure.
- Stub: `state.spaces[i]` entries gain `tabs: [{ id, panes }]` (default one tab, one pane) and `machine: null`; `panes()` returns `state.panes` (`{ pane, terminal, tab, cwd, program: { shell } }`); `agents()` returns `state.agents`.

- [ ] **Step 1: Write the failing tests** in `test/watch.test.mjs` with a fake `cx` (timers captured, `spawn` runs at once) and injected fakes for `loadConfig`/`prepareSetup`/`buildWorkspace`/`repoKey`/`branchOf` that record calls:

```js
test("spaces present at start are seen and never built", …);
test("a new one-pane shell space on an autoLayout project's checkout is built with the project's tabs, no prompt, the project's timing", …);
test("a new space on a linked worktree of the project matches too, and prepareSetup gets isWorktree true", …);
test("a space whose folder moved before the tick does not match", …);  // Review Focus 1
test("two spaces in one tick are both considered, one after the other", …);  // Review Focus 2
test("a pane running neither a shell nor an agent is left alone and never revisited", …);  // Review Focus 3
test("a space the picker is opening is skipped", …);  // Review Focus 4
test("a space with two tabs, or a remote space, is skipped", …);
test("an agent already running is adopted: existing.agent true", …);
test("a repo that is not a project falls back to autoLayouts and defaultAgent", …);
test("a build failure is logged and toasted, and the space is not retried", …);
```
Each with concrete fixtures and `assert.deepEqual` on the recorded `buildWorkspace` call.

- [ ] **Step 2: Run to verify failure.**
- [ ] **Step 3: Implement `watch.js` and the stub additions.**
- [ ] **Step 4: Full suite, check, commit** — `git commit -m "Watch for spaces opened outside the picker and set them up"`.

### Task 4: The resident copy and the retired launcher folder

**Files:**
- Modify: `mods/projects/main.js` (`init`, `render`, `setupLauncher`, new `renderLauncher`), `mods/projects/lib.js` (`withLauncherBlocks` emits `mod: "projects"`), `README.md`, `.gitignore` if needed
- Delete: `mods/projects-launcher/` (and the app symlink `~/.config/herdr-app/mods/projects-launcher`)
- Test: `test/ui.test.mjs`, `test/lib.test.mjs`

**Interfaces:**
- `init`: when `props()?.slot` is set, `this.role = "launcher"`: skip the picker's init (no search box, no reload, no `knownAgents`); create `this.watcher = new Watcher({ … real functions … })` and `this.watcher.start(cx)`; else `this.role = "picker"` and the existing init.
- `render`: `this.role === "launcher"` → `this.renderLauncher(t)`: the button code from the old launcher mod verbatim (sidebar / status / tabs variants, the hide-when-not-chosen rule with `layout.hide`), opening the picker with `run("mod.open", { name: "projects" })`. The watcher does nothing in render.
- `withLauncherBlocks` writes `content: { mod: "projects", props: { slot } }`; `setupLauncher` drops the "launcher mod isn't installed" check. An existing layout file referencing `projects-launcher` is rewritten by `setupLauncher`? No: `cycleLauncher`, when the layout's blocks reference `projects-launcher`, rewrites that layout file's three blocks to `mod: "projects"` once (a small `migrateLauncherBlocks(tree)` in `lib.js` with a test) and logs it.
- `applyDemo`: `"view": "launcher-setup"` calls `setupLauncher()` (for the in-app check).
- README: one symlink; the launcher section says the button and the watcher live in the same mod; "Launcher: off" also turns the watcher off (a hidden block's copy may never start), so keep it shown somewhere.
- Remove `mods/projects-launcher/` from the repo and the dangling symlink from the app home.

- [ ] **Step 1: Write the failing tests** (ui: construct the view with `props()` returning `{ slot: "sidebar" }` via a stub flag `state.props`; assert the button text "Projects" renders, no search box, `v.watcher` exists and its timer is registered; lib: `withLauncherBlocks` emits `mod: "projects"`; `migrateLauncherBlocks` rewrites `projects-launcher` to `projects` and reports whether it changed anything).
- [ ] **Step 2: Run to verify failure.**
- [ ] **Step 3: Implement; delete the folder and the symlink; `herdr-app check mods/projects`.**
- [ ] **Step 4: Full suite, commit** — `git commit -m "Run the watcher in the launcher block of the projects mod"`.

### Task 5: Editor toggle, save-time enforcement, card tag

**Files:**
- Modify: `mods/projects/main.js` (`renderEdit` worktree section, `save`, `renderCard`), `test/ui.test.mjs`

**Interfaces:**
- Worktree section: toggle `pp-autolayout` "Auto-layout: set up spaces opened outside the picker" → `d.worktree.autoLayout`.
- `save()`: when `d.worktree.autoLayout` is on, compute `repoKey(projectFolder(d))` and, for every other project with `autoLayout` on and the same key, set its `autoLayout` false and `notify({ title: "Projects", body: "Auto-layout moved from <other> to <this>" })`; save the whole list.
- Card: a tag `auto-layout` beside `pinned` when on; and, when on but the shown layout has no launcher block (`snap.launcherInLayout` false) or the launcher is `off`, a dim line `auto-layout needs the Projects button in the layout (Launcher: …)`.
- The template card: the toggle is allowed on the template (copied to new projects) but enforcement runs only on real projects.

- [ ] **Step 1: Write the failing tests** — toggle saved; enforcement moves the flag and toasts (`state.notified` in the stub records `notify`); card tag and hint line.
- [ ] **Step 2: Run to verify failure.** **Step 3: Implement.** **Step 4: Full suite, check, commit** — `git commit -m "Choose which project auto-lays out a repo"`.

### Task 6: Docs, spec update and the phase's done-when checks

**Files:**
- Modify: `RECIPE.md`, `README.md`, `mods/projects/demo.js`, `docs/superpowers/specs/2026-11-02-projects-mod-design.md` (section 6 first paragraph: the resident copy is the `projects` mod in the launcher block; section 8: shared code lives in one folder; section 3's names table: drop `projects-launcher`)

- [ ] **Step 1: Docs** per the files list; RECIPE "Done when" gets the list below.
- [ ] **Step 2: In-app check**, driven without keystrokes: write a throwaway project with `autoLayout: true`, `copy: [".env"]`, `worktree.setup: ["sleep 5"]`, `startup.setup: ["echo hi"]`, agent `claude`, timing `with`, into `~/.config/herdr-app/data/projects.json`; put the launcher block in the layout with the demo file `{ "view": "launcher-setup" }` (opens the picker, which writes `layouts/<name>-launcher.json` and switches to it); then:
  - `herdr-app do space.new '{"folder":"<checkout>"}'` (the native new space): within ~5 s the space gains the project's tabs and `echo hi` ran in a setup tab; `herdr-app ls` shows it.
  - Make a worktree the app's way: `herdr-app do tab.new` is not it; use the worktree mod's command path: `herdr-app do mod.open '{"name":"worktree","props":{"space":"<space id>","branch":"zz-auto","argv":["claude"]}}'` (the shipped worktree mod accepts `{branch, tab?, argv?}` to make one at once); the new space with Claude running gains a setup tab (copy + sleep + echo) and the project's other tabs; Claude is not restarted.
  - Open that worktree again later (close its space, reopen via the worktree mod's "open"): only `echo hi` runs.
  - Switch spaces and back: nothing happens. Reopen the app is not driven (would close your terminals); the seen-at-start rule is covered by tests.
  - Clean up: close the spaces you made, remove the worktree, delete the throwaway `projects.json` and demo file, switch back to the previous layout (`herdr-app do layout.switch '{"name":"main"}'`) and delete the `<name>-launcher.json` layout file you created so the person's app is as it was; record how to enable it in one click in the report.
- [ ] **Step 3: Full suite, both checks, commit** — `git commit -m "Document the watcher and prove it in the app"`.
