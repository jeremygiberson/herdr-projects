# Design: the `projects` mod for the Herdr app

Date: 2026-11-02
Status: design for review, nothing built
Supersedes: project-presets-plus-proposal.md (the first proposal)

## 1. What this is

A project picker for the Herdr app (`~/.config/herdr-app`, `herdr-app 0.1.12`, `hc 0.1.17`) where a project describes a whole workspace: every tab, every pane, every startup command, each in its own folder. Opening a project opens its checkout or a fresh git worktree, sets the worktree up (copy gitignored files, install, build) and starts an agent, with or without a first prompt, either after setup finishes or alongside it. Worktrees opened from the app's own New worktree menu get the same treatment.

It is a personal mod named **`projects`**, started from a copy of cgill27's `project-presets` (MIT; attribution kept in the folder) and then changed freely. herdr-plus is a feature reference only: nothing of its file format, directory layout or CLI is carried over.

## 2. Goals, non-goals, anti-goals

**Goals**
- Keep project-presets's UI and behaviors that work: the popup, fuzzy list with Open now / Pinned sections and live agent status, detail card, editor, template and duplicate, import/export, worktree creation and cleanup, agent chips, typed-after-start prompts, snapshot rendering, node tests, debug log.
- A tabs-and-panes workspace model per project, with folders per tab and pane.
- Setup that survives a long install, runs where you can see it, and can gate the agent or run beside it.
- A launch screen where the per-launch choices are made: branch name, prompt (optional), agent timing, layout.
- Auto-apply to worktrees not created by the picker.

**Non-goals**
- herdr-plus compatibility of any kind: no TOML, no `projects/` directory, no importer.
- Quick Actions. Not planned.
- Headless open (opening a project by name from a shell or script without the picker, what herdr-plus's `herdr-plus open <name>` does). Not needed now; section 9 notes how it would be added if that changes.
- Remote machines. Local folders only, as today.
- Upstream contribution. This mod does not need to stay mergeable into project-presets.

**Anti-goals**
- A slower picker. The render-snapshot rule and batched redraws stay.
- A config that stops loading after an upgrade. `normalize()` must upgrade any file project-presets wrote.
- An agent that starts on a half-built tree when the person asked for "after setup".

## 3. Names and files

| project-presets | projects |
|---|---|
| `mods/project-presets/` | `mods/projects/` |
| `mods/project-presets-launcher/` | `mods/projects-launcher/` (the button and the resident watcher) |
| `data/project-presets.json` | `data/projects.json` |
| `data/project-presets.log`, `.debug`, `.demo` | `data/projects.log`, `.debug`, `.demo` |
| shared `project-presets.recent` / `.detail` / `.launcher` | `projects.recent` / `.detail` / `.launcher` |
| layout block ids `pp-launch-*` | `projects-launch-*` |
| keys `mod.open:project-presets` | `mod.open:projects` on `ctrl-alt-p` / `cmd-alt-p` (unchanged keys) |

The repo is a folder laid out like the app home (`mods/projects/`, `mods/projects-launcher/`, `keys.json`, `RECIPE.md`, `preview.png`, `test/`), installed by symlink as project-presets recommends.

## 4. The data model

One JSON file, `data/projects.json`, hand-editable, written with the expected-previous-text check. Everything project-presets stores stays valid; `normalize()` fills and upgrades.

```json
{
  "layouts": [ ... ],
  "projects": [{
    "name": "Shop", "description": "storefront monorepo", "path": "~/dev/shop", "group": "work", "pinned": true,
    "worktree": {
      "mode": "ask", "branchTemplate": "{user}/{date}-{slug}", "root": "~/.herdr/worktrees/{repo}/{branch}",
      "spaceName": "{name} · {branch}", "repoSpace": false,
      "copy": [".env", ".env.local", ".claude/settings.local.json"],
      "setup": ["npm ci", "npm run build"],
      "autoLayout": true
    },
    "git": { "fetch": true, "remote": "origin", "base": "main", "fastForward": false },
    "startup": {
      "setup": ["docker compose up -d"],
      "agentTiming": "after",
      "tabs": [
        { "name": "agent", "panes": [
            { "type": "agent", "agent": "claude", "args": "--model opus", "prompt": "", "promptMode": "arg" },
            { "type": "shell", "direction": "down" } ] },
        { "name": "web", "folder": "frontend", "command": "npm run dev" },
        { "name": "api", "folder": "backend", "panes": [ { "command": "make run" }, { "command": "psql shop", "direction": "right", "folder": "db" } ] },
        { "name": "git", "command": "lazygit" }
      ]
    }
  }]
}
```

### 4.1 Tabs and panes

- A tab has `name`, optional `folder` (relative to the project folder or the worktree, or absolute; `~` and `$VAR` expand), and either `command` or `panes`, not both. Neither means a plain shell.
- A pane has `type` (`agent` | `shell` | `command`; inferred when absent: `agent` field means agent, `command` means command, else shell), `command`, `direction` (`right` | `down`, default `down`), `from` (an earlier pane's name to split instead of the previous one), `folder` (default the tab's; a relative pane folder resolves against the tab's folder, so `"db"` under a tab in `backend` is `backend/db`).
- The first tab is just a tab. An agent is a pane type; the agent pane may be anywhere. Several agent panes are allowed. The launch screen's prompt and the `after` setup chain go to the first one; later agent panes start bare, at once.
- An agent pane carries its own `agent`, `args`, `promptMode`. In a named `panes` layout an agent pane may leave `agent` empty: inside a project it then inherits the project's first agent pane's settings; in a non-project repo (the `autoLayouts` list, 6) it uses the file's top-level `"defaultAgent": { "agent": "claude", "args": "" }`, or a plain shell when that is absent.
- Every folder is checked to exist before anything is created. A missing one is reported on the busy screen and nothing opens.
- `ratio` and `label` are not in the model. The app splits evenly and has no pane rename.

**Upgrade of old entries** in `normalize()`: `startup.agent/args/prompt/promptMode` plus `startup.layout` become tab 1 (the named layout expands to its panes with the agent first); `startup.tabs` strings become `{ name: <first word>, command }`. Saving writes the new form.

**Named layouts** (`layouts` in the file, the ctrl+alt+L cycling, the thumbnails) stay. A layout may hold `panes` (applies to the first tab, as today) or `tabs` (a whole workspace shape that replaces the project's tabs for that launch). The two shipped pane layouts stay.

### 4.2 Setup

- `worktree.copy`: paths relative to the main checkout, globs allowed, copied into a new worktree before any command. Explicit list only. Missing sources are logged and skipped.
- `worktree.setup`: commands run once, when a worktree is new. "New" means no `.projects-setup-done` marker file in the worktree; the chain writes the marker after its last step succeeds. The marker name is added to `.git/info/exclude` of the worktree so it never shows as a change. A worktree that existed before the mod did counts as new on its first open, which re-runs an install on a built tree; that is harmless, and `copy` protects hand-edited files: **copy never overwrites** an existing destination, it skips it and logs.
- `startup.setup`: commands run on every open, checkout or worktree.
- Variables in every command, as braces and as env: `{main}` the project checkout, `{folder}` the folder being set up (checkout or worktree), `{branch}`, `{repo}`, `{name}`, `{home}`; env `PROJECTS_MAIN`, `PROJECTS_FOLDER`, and so on.
- **Nothing waits inside the popup.** The popup closes on Esc or any click beside it, and the app cancels a closed view's tasks, so the mod never blocks on a long step. Instead the setup commands are chained into one shell line, `cmd1 && cmd2 && … && touch .projects-setup-done`, and that line is what a terminal runs. The mod's own work is over in seconds: git, copy, create the space and tabs, start terminals. Where the chain runs depends on the agent timing (4.3). On failure the chain ends with `|| exec "$SHELL"` so the pane stays open at a shell with the output above it; on success it continues into the agent or exits.
- `copy` happens in the mod before any terminal starts (a handful of `cp` calls through `exec`, well under its 30 s cap), as does `worktree.copy`'s `.git/info/exclude` line.
- Order for a new worktree: create, copy, then `worktree.setup` and `startup.setup` as one chain, then tabs. For a checkout or an existing worktree: `startup.setup` chain, then tabs.

### 4.3 Agent timing and the optional prompt

`startup.agentTiming` is the project default, chosen per launch on the launch screen:

- `after`: the agent pane starts only when every setup step has exited cleanly. Its prompt, if any, goes with it. For a task that needs deps installed, docker up, a build done.
- `with`: the space opens with the agent pane at once and the prompt is delivered immediately; setup runs beside it in its own tab. For research or planning tasks.

The prompt is always optional. A project's stored `prompt` is only the prefill of the launch screen's prompt box; an empty box starts the agent bare. The existing `promptMode` (`arg` | `send`) is unchanged.

**How `after` works:** the setup chain and the agent share the agent's pane. The agent pane's `argv` is one shell line: `<chain> && exec <agent command and args> [prompt]`. Setup output scrolls by in the pane, and when the last step succeeds the agent takes it over, prompt included for `arg` mode. If a step fails the pane drops into a shell with the output above it and no agent starts. Nothing has to survive the popup, pane order is stable, and there is one space-creation path. For `send` mode behind setup, the prompt still needs typing once the agent is idle: the mod starts a detached helper, `hc run --bg --rm --no-parent --no-notify -- sh -c '<poll hc ls --json for the agent pane idle, then hc send>'`, which outlives the popup. The helper is a shell script shipped in the mod folder.

**How `with` works:** the agent pane starts the agent at once (`argv` and `task` on `space.new`, as today); the setup chain runs in a separate tab named "setup" started with `hc run --cwd <folder> --label herdr.space=<id> --label herdr.tab=<id> --rm`. Its pane closes by itself on success and stays at a shell on failure.

## 5. The launch screen

Enter on a project no longer launches straight away unless the project has `"quickLaunch": true`. It opens a launch screen in the popup, replacing today's branch-name step:

- **Branch** (worktree modes only): the branch-name box with the live preview, as today. A typed name containing `/` is used verbatim instead of the template.
- **Open as**: Worktree / Checkout, defaulted from `worktree.mode` (`never` → Checkout). Shift+Enter still means Checkout.
- **Prompt**: a multi-line box, prefilled from the project's prompt. Empty is fine. Shift+Enter inserts a newline here (so on this screen Checkout is the Open as toggle, not Shift+Enter); Enter anywhere on the screen launches.
- **Agent**: `after setup` / `with setup`, defaulted from `agentTiming`, one key toggles (proposal: `ctrl+alt+T`, ⌘⌥T). Hidden when the project has no setup commands for this launch (then it is always "with").
- **Layout**: the current ctrl+alt+L selector.
- Enter launches; `alt+b` (⌘⌥B) goes back; Esc closes the popup.

`always` mode goes to the same screen with the branch box prefilled by the template. The busy screen that follows lists the steps as today: fetch, worktree add, copy, each setup command (with "see the setup tab" while a long one runs), tabs, agent, prompt.

## 6. The resident watcher (projects-launcher)

The app has no event hooks, so auto-layout for worktrees the picker did not create needs a mod copy that is always in the layout. The launcher block already is one (alive while in the layout, shown or hidden). It gains a watcher:

- `render()` only diffs `spaces()` ids and folders against what it saw and queues a check; no git in render.
- **Seen at start.** The first list of spaces the copy sees (on app start, mod reload, or the block entering the layout) is taken as already seen and never acted on. Only spaces that appear after that count. This is what keeps the watcher from laying out every open space on launch; the one-pane guard below is the second line of defense, not the first.
- **Trigger is appearance, not focus.** A space is considered once, when its id first shows up. Switching to it later does nothing.
- For a new local space whose folder, at the moment it appears, is **a project's checkout or a linked worktree of it** (repo identity from `git rev-parse --git-common-dir` of both; a space's folder follows its terminal, so a space opened elsewhere and cd'd into the project later is not matched), where that project has `autoLayout: true`, and which has exactly one tab with one pane, run sections 4.2 and 4.1 as the picker would, with no prompt (there is no launch screen in this path). On the checkout only `startup.setup` applies; `copy` and `worktree.setup` are for worktrees. Two cases for that one pane:
  - **A plain shell** (the app's New worktree → Terminal, or the native new-space shortcut pressed inside the checkout): the watcher types the chain into it with `hc send`, with the agent's `exec` on the end for `after` timing, or starts the agent there and the chain in a setup tab for `with`. Then the remaining panes and tabs.
  - **An agent already running** (the app's New worktree → Claude, the likelier menu path): the watcher adopts it as the project's first agent pane and runs copy and the chain in a setup tab beside it, forced `with`, since the agent cannot be gated once started. Then the remaining panes and tabs. The picker's card says "auto-layout: agent starts with setup from the app's menu".
- Only one project per repo may have `autoLayout` on: saving a project with it on turns it off on other projects sharing the repo's common dir, and the editor says so. The watcher therefore never has to choose.
- Spaces the picker just opened are recorded in shared state `projects.opening` and skipped.
- Takes the same launch lock as the picker so two builds never interleave.
- The "Launcher: add to layout" step from project-presets remains the way the block gets into the layout; the picker's toolbar says when auto-layout is inactive because the block is missing.

A global `"autoLayouts": [{ "repo": "*", "branch": "release", "layout": "deploy" }]` list at the file's top level covers repos that are not projects, choosing a named layout by repo and branch with herdr-plus's precedence (repo+branch, repo, wildcard+branch, wildcard). Tabs and panes only: a non-project repo has no `copy` or `setup`, by intent. An agent pane in such a layout uses its own `agent` or the top-level `defaultAgent` (4.1). This is the one herdr-plus idea kept beyond the tab model.

## 7. Editor changes

- Project section: add Description.
- Worktree section: add Copy (one path per line), Worktree setup (one command per line), Auto-layout toggle.
- Startup section: Startup setup (one per line), Agent timing button, Quick launch toggle, and a **Tabs** list: one row per tab (name, folder, command or "N panes") with Add, Remove, Up, Down; a tab's row expands to its panes with the same controls and, on an agent pane, the agent chips and Agent command / Arguments / Prompt / Prompt delivery fields that exist today.
- `;;`-separated fields become one-per-line boxes (my call; `;;` still parses on load).
- Detail card: tab names with `×N` for split tabs, the first tab's thumbnail as today, and the setup summary ("2 copy · 2 setup · agent after setup").

## 8. One build path

`workspace.js` exports `buildWorkspace({ project, folder, prompt, agentTiming, layout, existing, log })` and is the only code that turns a project into app commands. Used by the picker's launch and by the watcher (`existing` describes a space and pane the watcher found; absent for the picker). It owns: folder checks, copy, the setup chain text, `space.new`, `tab.new { space, name, folder, argv }`, pane splits, the agent start for both timings, prompt delivery, `pane.focus` back to the agent. Since the two mods are separate folders, `workspace.js`, `git.js` and `lib.js` live in `mods/projects/` and the launcher imports them by relative path (`../projects/workspace.js`); verify in phase 1 that a cross-folder import loads, else the launcher gets copies kept in sync by the tests. The launch lock becomes shared state (`projects.lock` with a timestamp) rather than a module variable, so the two mods serialize against each other. Mapping notes:

- Tab 1: `space.new { name, folder, argv }` where `argv` is the agent command for `with`, or the chain-then-exec line for `after`, with `task` for an `arg` prompt. Later tabs: `tab.new`. Later panes: `herdr-app do pane.split {direction, pane, argv}` with the `inFolder` wrapper as today (`terminal.open` cannot target a pane on 0.1.12, checked).
- `argv` is the split command, not `sh -c`, so the app's interactive-shell launcher keeps a shell after the command exits.
- The `exclusive` lock, `findNewSpace`, `findNewTerminal`, `sendWhenReady` carry over unchanged.

## 9. Phases

1. **Rename and model.** Copy project-presets to `projects` and `projects-launcher` with every name in section 3 changed; tests pass; `herdr-app check` passes; the picker opens on the same keys. Then the tab model, `normalize` upgrade, `description`, `buildWorkspace`, folder pre-flight, editor Tabs list, card tab labels. Done when an old `project-presets.json` renamed to `projects.json` launches unchanged, and the Shop example opens four tabs in the right folders.
2. **Launch screen, setup and timing.** `copy`, `worktree.setup`, `startup.setup` in a visible terminal with variables and the marker file; the launch screen with optional prompt, Open as, agent timing, layout; verbatim `/` branches. Done when a project with `copy: [".env"]`, `setup: ["npm ci"]` opened in ask mode with a prompt and `after` shows the install in a pane, then starts the agent with the prompt only after it exits; the same launch with `with` has the agent answering while the install runs; an empty prompt starts the agent bare.
3. **Watcher and autoLayouts.** The resident copy in the launcher, `autoLayout` per project, the global list. Done when New worktree from the app's space menu on a project with `autoLayout` gets copy, setup and tabs once, within a few seconds of appearing, and reopening that worktree only runs `startup.setup`; the native new-space shortcut pressed inside the project's checkout gets `startup.setup` and the tabs; switching away and back changes nothing; restarting the app with that space open changes nothing.

Later, if wanted: headless open (a request file under `data/projects.requests/` watched by the resident copy, plus a tiny shell script; or a `projects-launcher.open:<name>` key through `nextCommand()`). Not in scope now.

Each phase: `node --test test/`, `herdr-app check` on both mods, a run in the app with `herdr-app shot` for the UI, and the RECIPE.md updated.

## 10. Host limits and risks

- No pane ratio and no pane label in the app; neither is modeled.
- No events: auto-layout depends on the launcher block being in the layout.
- The popup's tasks die when it closes, so no step may wait on a long process; the chain-and-exec design and the detached `send` helper exist for that reason. The busy screen shows the quick steps, then says "setup continues in the agent pane" and closes.
- The `after` chain shares the agent's pane with setup output; the agent's own screen replaces it. Scrollback keeps the setup log.
- Esc closes the popup before the mod sees it; the launch screen uses `alt+b` to go back.
- In the watcher's plain-shell case the chain is typed with `hc send` into a fresh shell; type it after the prompt appears (`hc read`) and check the echo before Enter, as the typed-prompt path does.
- Two launches into one folder at once stay unsupported; the shared-state lock serializes them, including across the two mods.

## 11. Calls I made, to check while reading

- Start from a copy of project-presets's code rather than a rebuild from its recipe (fastest path to a working base; MIT).
- The agent is a pane type; several allowed; the launch prompt and the setup gate apply to the first.
- `after` timing runs setup and the agent in one pane as a single shell line (`chain && exec agent`), so nothing waits inside the popup; `with` puts the chain in a separate setup tab that closes on success and stays at a shell on failure.
- A `send`-mode prompt behind setup is delivered by a detached `hc run --bg` helper script.
- The watcher path uses the project's default timing and no prompt; a worktree the app opened with an agent already running is adopted and set up beside it (forced `with`).
- The watcher matches a project's checkout as well as its worktrees, acts once on appearance (never on focus), and treats every space present when it starts as already seen.
- Only one project per repo can have `autoLayout`; saving enforces it.
- A marker file decides "new worktree" for `worktree.setup`; its name is excluded via `.git/info/exclude`; a pre-existing worktree counts as new on first open; `copy` never overwrites.
- Agent panes in layouts inherit the project's first agent, or a top-level `defaultAgent`, or become a shell.
- Shift+Enter is a newline in the prompt box; Checkout on the launch screen is the Open as toggle.
- Shared code lives in `mods/projects/` and the launcher imports it across folders (to verify), with a shared-state lock between the mods.
- Multi-line boxes replace `;;` in the editor.
- `ctrl+alt+T` / ⌘⌥T toggles agent timing on the launch screen.
- Phase order: model, then launch screen and setup, then watcher.
