# Projects

A project picker for the Herdr app. You keep a list of local git checkouts, each with its own settings: whether selecting it opens the checkout or a fresh worktree, how the branch is named, what git does first, and what starts in the new space. `ctrl-alt-p` (`cmd-alt-p` on macOS) opens a fuzzy-searchable list; Enter does what that project is set up to do.

![Projects](preview.png)

## What you see

A popup, 680px wide, top-aligned 40px down, up to 80% of the window high, on the theme's `popover` background.

- Title "Projects" with "Esc" on the right (other screens say "alt+b back · Esc closes").
- A 36px search box with an `accent` border.
- One 48px row per project (a scrolling list with a scrollbar; the wheel and the arrow keys scroll): a marker (`●` in the agent-status color when the project's folder already has a space, `★` when pinned, else `·`), the name, the folder shortened with `~`, the group at the right, then `checkout`, `worktree?` or `worktree` for the project's mode.
- A toolbar under the search box (`renderToolbar`): Add project, then Duplicate, Worktrees (not for a template), Edit and Delete (only when a project is listed), "acts on <name>" for the highlighted project, and at the right Import / export… and Show/Hide details. It wraps if the popup is narrow. The footer is only the line of key hints (and, without the card, the layout choice); the detail card has no action buttons of its own except Create worktree / Checkout (Use template for the template).

Ordering with an empty search: projects with an open space, pinned ones, recently used, then by name. With a query: best fuzzy match first (subsequence match on name, group and folder name; consecutive and word-start letters score higher).

The editor replaces the list in the same popup, in four sections chosen by buttons under the title. **Project:** Name, Folder (+ Browse…), Group, Pin to top. **Worktree:** the mode button (ask / always / never), Branch name, Worktree folder, Space name, and an "Open the repo's space first" toggle. **Git:** Fetch first, Fast-forward checkout, Remote, Base branch. **Startup:** an Agent button per installed agent from `knownAgents()` plus Shell, Agent command, Agent arguments, First prompt with a Prompt delivery button, Pane layout, Setup commands, Extra tabs. Buttons: Delete (asks for a second click), Cancel, Save. Tab moves between the fields of the current section.

## How it behaves

- A single click highlights a row; a double-click (two clicks on the same row within 450 ms) or **Enter** opens it, following the project's mode:
  - `never`: focus the project's space if its folder already has one, otherwise fetch (if on), fast-forward (if on and safe), run setup, open a space on the checkout.
  - `always`: create a worktree and open a space on it. The `{slug}` part is the time (HHMMSS).
  - `ask`: a name step appears with a live preview of the resulting branch; Enter creates it. Empty name uses the time.
- **Shift+Enter** always means the main checkout, whatever the mode (same steps as `never`).
- With alt, ctrl or cmd held (⌘ on macOS): **w** (or the Worktrees button) opens worktree cleanup, **d** (or Delete) removes the project from the list after a second press, **n** (or Add project) adds a project, **e** (or Edit) edits the highlighted one, **s** saves, **Tab** moves between fields, **alt+b** (**⌘⌥B** on a Mac: herdr owns ⌘B, so the Mac gets the cmd+alt chord like the layout and details keys) goes back one screen (not a bracket key: herdr binds alt-[ and alt-] to tabs and acts on them before the popup sees them); **Esc** closes the popup (herdr closes a popup on Esc itself and never gives the key to the mod, so the mod's own Esc branch only runs outside a popup; the debug log showed no `key escape` line).
- While working, the popup lists progress lines (`git fetch origin…`, `git worktree add …`, `$ <setup command>`) and Esc does nothing; for a "typed after start" prompt it stays open, with a "Waiting for the agent…" line, until the prompt is sent, then closes. An error stays on screen until Esc.
- Worktree creation: `git fetch <remote>` (a failure is logged and the local ref is used), then `git worktree add --no-track -b <branch> <folder> <remote>/<base>`. A taken branch or folder gets `-2`, `-3`… up to `-20`.
- Fast-forward only happens on the checkout when it is on the base branch, clean, and can fast-forward.
- **Worktree cleanup** has a filter box (fuzzy, on branch and folder name) over a scrolling list of the repo's linked worktrees (`git worktree list --porcelain`, main checkout excluded) with the branch, folder, and badges: `open` (a space shows it), `uncommitted`, `locked`, `merged` (branch is an ancestor of `<remote>/<base>`) or `unmerged`. Enter or a click ticks the highlighted row; m (or Tick merged) ticks every merged, clean, unlocked one, and again unticks them; r (or the Remove button, labelled with the count) asks for confirmation and the second press removes the ticked ones with `git worktree remove` (never `--force`, so dirty ones are refused and reported). A merged branch is then deleted with `git branch -d`; an unmerged one is kept. The space showing a removed worktree is closed with `space.close`.
- **Space name and repo space** (worktree modes only): the new worktree's space is named from `worktree.spaceName` (variables `{name}` the project's display name, `{branch}`, `{slug}`, `{user}`, `{date}`, `{repo}`; an empty result falls back to `<name> · <branch>`). When `worktree.repoSpace` is on and no space shows the project's main checkout, a plain-shell space named after the project is opened on it first, then the worktree space, which herdr nests under it. If the repo's space is already open nothing extra is created.
- **Sections and the detail card:** without a search the list has headers (Open now: a space shows the folder; Pinned; Everything else), 30 px high among 48 px rows (`v_virtual_list` takes per-item sizes); headers are dropped while searching or when only one group is non-empty. Each row has an avatar tile in the space's color (`shared("space.colors")`, palette as in the `spaces` mod; an outline when no space is open), a status stripe that pulses (`loop("opacity")`) while the agent works, the matched letters in bold accent, and chips from `gitSummary` (branch, changed files from `status --porcelain`, linked worktrees), loaded three projects at a time after the list shows, unless `"gitInfo": false` is in the data file (it runs git in every project on every open). A 340 px card beside the list shows the highlighted project (agent, branch, changes, worktrees, last opened from `projects.recent`, a mini drawing of each layout from `layoutRects`, what Enter does, and the Open/Checkout/Worktrees/Edit/Delete buttons). The card is ON by default (shared state `projects.detail`; ctrl+alt+I / ⌘⌥I or the Hide details button turn it off). On older herdr-core versions the popup burned a full core and a draw could be cut off ("This view could not be re-rendered … interrupted"); the herdr-core update fixed that, and with it the original card, layout pictures and buttons measured 2–3% CPU; the buttons then sit under the list and the layout choice is the footer's text chips. `mod.json` overlay width is 1060. A render builds as few elements as it can: hints are one row of bold keys and plain strings, card rows are a label and a string, background redraws are batched into one every 250 ms, and buttons have no hover callback (each cost tens of ms).
- **Pane layouts:** `projects.json` may hold a `layouts` list beside `projects` (kept when the editor saves). Two ship (`agent-terminal`, `agent-side-terminal`); a user layout of the same name replaces one. A layout is `panes`: the first is the agent, each next one has `direction` (`right`/`down`), a `type` (`shell`, `command` + `command`, `agent`), an optional `name`, and `from` (the pane to split; default the previous one). A project's `startup.layout` names one; ctrl+alt+**L** (⌘⌥**L**) in the list or the name step steps none, then each layout for that launch (a selector under the list shows them all, the one in use lit; it bolds with an accent ring for a second after a change). After `space.new`, each extra pane is made with `herdr-app do pane.split {direction, pane, argv}` (its `pane` reply is the next pane's id); `argv` wraps the command so it starts in the project folder, since a split takes none. Focus returns to the agent (`pane.focus`). Sizes are not set. An unknown layout name or a broken layout is shown before anything is created; a failed split is logged and ends the layout, the space and extra tabs still open.
- **Import and export config:** alt/ctrl/cmd+X (or the Import / export… button) opens `mode = "backup"` (`renderBackup`): a file box (`this.backupPath`, default `~/Downloads/` + `exportFileName()` = `projects-config-YYYY-MM-DD-HHMMSS.json`, set afresh on each open) and Export / Import: merge / Import: replace. `exportData` writes `{ format: "projects-backup", version: 1, exportedAt, gitInfo, hideTemplate, layouts, projects }` with the home folder written as `~` in each project's `path` and `worktree.root` (`portablePath`); `parseBackup` also accepts a plain data file and rejects bad JSON, a missing `projects` list, another `format` and a newer `version`, each with its own message. Export to an existing file and Import: replace both need a second click (`this.backupConfirm`, cleared when the box changes); replace first writes the current file text to `<data file>.bak`, then `saveConfig(projects, raw, { layouts, gitInfo, hideTemplate })`. Merge uses `mergeProjects` (same name + folder counts as present; yours win; an incoming template is skipped when you have one) and `mergeLayouts` (by name). After an import `folderExists` flags projects whose folder is missing here. The demo file accepts `"view": "backup"` with `text`, `note`, `bad`.
- **Template and duplicate:** a project with `"template": true` is a template: no folder, never launched, always the last row under a "Template" header (tagged `template`, shown on its card with Use template / Edit / Delete). When the file has none and `"hideTemplate"` is not true, the picker shows an unsaved default template (`defaultTemplate()`: Claude Code, `agent-terminal`, ask mode) that becomes a real entry the first time it is saved. Enter (or Use template, or Shift+Enter) on a template opens the editor on `duplicateProject(template)`: name "New project", no folder, the template's settings; saving that needs a folder and runs the usual git-checkout check. Editing a template skips the folder check. **alt/ctrl/cmd+U** (or the Duplicate button) opens the editor on `duplicateProject(project)`: `<name> copy` (`uniqueName` adds 2, 3…), the same folder, not pinned. Add project starts from a *saved* template (`startFromTemplate`: its settings without name, folder or pin), never from the unsaved default. Deleting a template (either kind) writes `"hideTemplate": true` next to `projects` (kept by `saveConfig(projects, raw, extra)`); removing the key brings the default back. The template is skipped by git lookups, worktrees, launching and space matching.
- **Delete** (the button or **d**) shows "Remove \"<name>\" from the list?" in red; pressing d or clicking Delete again removes the project from `projects.json`, any other key cancels. The folder and its worktrees are left alone. The editor's Delete button has its own two-click confirmation.
- Selecting a project records it in shared state `projects.recent` for ordering.

## Built from

- `mods/projects/`: `main.js` (the View: list, name step, busy, editor and worktree modes), `git.js` (every git call, worktree creation and removal, launching), `config.js`, `lib.js` (pure helpers, tested with node), `log.js` (error and debug log), `demo.js` (optional screenshot hook), `mod.json` (`place: "none"`, popup overlay 680 x 0.8, `at: "top"`, `offset: 40`).
- `keys.json`: `"global": { "ctrl-alt-p": "mod.open:projects", "cmd-alt-p": "mod.open:projects" }` (ctrl-alt-p for Linux and Windows, cmd-alt-p for macOS; cmd-p is herdr's built-in space picker there, so it is not used), merged into the person's file. Ask before replacing a key they already use; `cmd-alt-p` is already the macOS default, so a clash there means choosing another key.
- Config file `~/.config/herdr-app/data/projects.json` (hand-editable, written with `writeTextFile` and its expected previous text):

```json
{ "projects": [{
  "name": "API", "path": "~/code/api", "group": "work", "pinned": true,
  "worktree": { "mode": "ask|always|never", "branchTemplate": "{user}/{date}-{slug}",
                "root": "~/.herdr/worktrees/{repo}/{branch}",
                "spaceName": "{name} · {branch}", "repoSpace": false },
  "git": { "fetch": true, "remote": "origin", "base": "main", "fastForward": false },
  "startup": { "agent": "claude", "args": "--model opus", "prompt": "", "promptMode": "arg|send",
               "setup": ["npm ci"], "tabs": ["lazygit"] }
}] }
```

- Template variables: `{user}` (slug of `git config user.name`, else the local part of `user.email`, else `user`), `{date}` (YYYY-MM-DD), `{slug}` (slug of the typed name, else HHMMSS), `{repo}` (checkout folder name), `{project}` (slug of the name), `{branch}` (folder template only).
- `herdr` functions: `knownAgents`, `window` (the platform, for ⌘ or alt hints), `exec`, `hc`, `run`, `focused`, `spaces`, `home`, `appHome`, `readTextFile`, `writeTextFile`, `pickFolder`, `props`, `theme`, `shared`, `setShared`, `closeOverlay`. `fs/promises` for the log and the demo file.
- Commands: `space.new {name, folder, argv, task}`, `space.select {id}`, `space.close {id}`, `tab.new {space, name, folder, argv}`, `pane.focus {pane}`, and `herdr-app do pane.split` through `exec`. `hc ls --json`, `hc get <t> --json` and `hc send <t> <text>` for typed-after-start prompts.
- Programs run: `git`, `test`, `sleep`, `hc`, `herdr-app` (pane splits), and `sh -c` for setup commands and extra tabs.
- Widgets from `gpui-base`: `InputState`, `Input`, `v_virtual_list`, `VirtualListScrollHandle` and `Scrollbar` (a handler can't be registered inside a virtual list's row renderer, so each list has one `on_item_click`; a double-click is two clicks timed by the mod).
- Colors: only theme names (`t.selected`, `t.dim`, …) or hex; a string like `"transparent"` is rejected and the whole view stops rendering.
- Logs: errors always go to `~/.config/herdr-app/data/projects.log`; `projects.debug` next to it turns on key, click and command logging. `projects.demo` (JSON) opens the picker in a given view for screenshots; see CONTRIBUTING.md.

## Watch out

- **`render()` must not read live herdr data.** Herdr draws a view again whenever data it read changes (spaces, agents, terminals, focus, shared state), which is constant while an agent works, and a draw that takes a while is cut off when the next one is asked for ("This view could not be re-rendered … interrupted"). The picker copies spaces, space colors, recent projects and the platform into `this.snap` (`takeSnapshot`), refreshes it every 3 s, and asks for a draw only if it changed; a draw reads the copy. Only the theme is read live. With the draw reading live data, the popup was interrupted on every open and lagged for seconds per key press; with the copy it passed 3 of 3 trials with the card off and 2 of 3 with it on.

- Setup commands and extra tabs run arbitrary shell from the config file. Tell the person before installing a shared config.
- `exec` stops after 30 seconds, so a slow `git fetch` or setup command is cut off; the picker logs it and carries on.
- A failed setup command stops the remaining ones but the space still opens.
- The first prompt goes to the agent as a command-line argument (`space.new {task}`) by default, which `hermes` and some other agents reject as an unknown subcommand. The Prompt button switches the project to "typed after start": the agent is started bare and the prompt is sent with `hc send` once `hc ls --json` shows it idle (6 s after start if it never reports a status, never while blocked). Picking the Hermes agent button sets this automatically.
- The agent command and its arguments are split into words, with '…' and "…" keeping spaces together; there's no other shell syntax. The first prompt is only sent when an agent is set.
- Herdr nests a worktree space under its repo's space only while a space on the main checkout is open (its sidebar groups by git common dir). With `repoSpace` off and no such space open, worktree spaces sit at the top level. Closing the repo's space later makes its worktrees top-level again.
- Layout splits use the focused pane right after `space.new` as the agent's pane; the typed-prompt terminal is found before the splits are made, since they also start in the folder.
- Extra tabs rely on the new space being the focused one right after `space.new`; the terminal for a typed prompt is found as the new live terminal that starts in the new folder, so two launches into one folder at once could confuse it.
- Local folders only: no `machine` field yet.
- Click handling and `cmd` shortcuts on macOS are untested: Herdr may use some cmd keys itself (e.g. cmd-n), so the buttons are the fallback.
- Typed-after-start needs `hc` on the PATH; an unknown agent counts as ready once something other than a shell has been in the foreground for 6 s.
- Shift+Enter relies on the search box passing Enter's key event through; plain Enter works either way.

## Done when

- `herdr-app check mods/projects` passes.
- `ctrl-alt-p` (or `cmd-alt-p` on macOS) opens the picker; typing `dmo` ranks a project named Demo first.
- Adding a project with Add project and Browse… writes it to `data/projects.json`; a folder that isn't a git checkout is refused with a message.
- With mode `ask`, typing "fix login" shows `<user>/<date>-fix-login` and Enter creates that worktree under the configured root, from `<remote>/<base>`, in a new space.
- Selecting the same project again with `always` gives `…-2`, not an error.
- Worktrees → m → r twice (with alt, ctrl or cmd held) removes merged, clean worktrees and their branches, closes their spaces, and refuses one with uncommitted changes.
- Delete asks once, then removes the project from the file.
- With no projects the list shows only the Template; Enter on it opens the editor on a new project with its settings, and saving without a folder is refused; alt+u on a project opens a copy named `<name> copy` with the same folder.
- With "Open the repo's space first" on, opening a worktree for a project with no open space creates a space named after the project and, under it, the worktree space; with the worktree's Space name set to `{slug}` the nested row shows only the slug. Opening a second worktree creates no second repo space.
- With mode `never`, Enter focuses an already-open space instead of making another.
- With 15 or more projects the list scrolls with the wheel and a scrollbar, the arrow keys keep the highlight in view, a single click only highlights, and a double-click opens.
- The editor's four section buttons switch between Project, Worktree, Git and Startup; Save writes every section's fields.
- For a project set to "typed after start" with a prompt, the agent opens empty and the prompt is typed into it once ready (checked with hermes).
- Opening the picker shows sections, git chips on the rows and the detail card; ctrl+alt+I hides the card and the next opening keeps it; the buttons and the layout choice are still there.
- With a layout that has a file-manager pane and a terminal, opening the project shows those panes beside the agent, all in the project folder; ctrl+alt+L before Enter changes it for that launch, and picking "none" opens the agent alone.
- The log at `data/projects.log` contains only errors until `projects.debug` exists.
