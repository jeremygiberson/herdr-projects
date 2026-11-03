# projects

A Herdr app mod that shows a picker of your configured git checkouts. Pick one to open it as a space with its own worktree, agent and pane layout, started the way you set it up for that project.

Started from [project-presets](https://github.com/cgill27/project-presets) by cgill27, MIT; see LICENSE.

## Install

```bash
ln -s "$PWD/mods/projects" ~/.config/herdr-app/mods/projects
```

Then merge `keys.json` into `~/.config/herdr-app/keys.json`.

## The clickable Projects button

The picker's **Launcher: add to layout** button writes a copy of the shown layout with three small blocks (beside the sidebar's spaces, the status bar and the tab bar) and switches to it; the button then reads **Launcher: sidebar / status bar / tab bar / off** and each click moves the Projects button to the next place. Each block loads this same `projects` mod with a `slot` prop: that copy draws the button and also runs the auto-layout watcher (it sets up spaces opened outside the picker for auto-layout projects). **Launcher: off** hides every block, and a hidden block's copy may never start, so it turns the watcher off too: keep the button shown somewhere if you rely on auto-layout. A layout made before the launcher moved into this mod (its blocks name `projects-launcher`) is rewritten to load `projects` the next time you click the Launcher button.

## Projects file

Projects live in `~/.config/herdr-app/data/projects.json`; the editor writes it, and you can edit it by hand. A project's `startup.tabs` is the list of tabs its space opens with. A tab has a `folder` (relative to the project or worktree, or absolute) and either a `command` or `panes`; a pane is an `agent`, a `shell` or a `command`, split `right` or `down` from the previous one, and its `folder` is relative to its tab's folder. Folders are checked before anything is created.

```json
{
  "projects": [{
    "name": "Shop", "description": "storefront monorepo", "path": "~/dev/shop", "group": "work", "pinned": true,
    "worktree": {
      "mode": "ask", "branchTemplate": "{user}/{date}-{slug}", "root": "~/.herdr/worktrees/{repo}/{branch}",
      "spaceName": "{name} · {branch}", "repoSpace": false
    },
    "git": { "fetch": true, "remote": "origin", "base": "main", "fastForward": false },
    "startup": {
      "setup": ["docker compose up -d"],
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

## Setup and the agent

Enter on a project opens a launch screen: open as a worktree or the checkout, a branch name, an optional first prompt (Enter adds a line, ctrl+Enter launches), when the agent starts, and the layout. Three lists in the project say what to prepare first, one entry per line in the editor:

- `worktree.copy`: paths or globs relative to the checkout, copied into a new worktree before anything runs (`.env`, `.npmrc`). A file already in the worktree is kept, never overwritten.
- `worktree.setup`: commands that run once, when the worktree is new (`npm ci`).
- `startup.setup`: commands that run on every open, checkout or worktree (`docker compose up -d`).

Commands can use `{main}` (the project checkout), `{folder}` (the folder being set up), `{branch}`, `{repo}`, `{name}` and `{home}`; the same values are in the environment as `PROJECTS_MAIN`, `PROJECTS_FOLDER`, `PROJECTS_BRANCH` and so on. Only those six braces are filled: `${PROJECTS_MAIN}`, `awk '{print}'` and `jq '{x: .y}'` are left as written. Each command runs in its own shell, chained into one line (`sh -ec 'a' && sh -ec 'b'`) that a terminal runs, so a comment, `;`, `&` or `||` in a command stays inside it and a command like `a; b` fails when `a` does. The launch screen closes within seconds even when setup takes minutes; its busy screen lists each command as `will run: <command>`.

`startup.agentTiming` (or the Agent button on the launch screen, ctrl+alt+T) picks where that line runs:

- `after`: in the agent's own pane. The agent takes the pane over when every step has succeeded, with the prompt. If a step fails the pane stays at a shell with the output above it and no agent starts.
- `with`: the agent starts at once and the prompt goes in; setup runs beside it in a tab named "setup", which disappears when it succeeds and stays at a shell when it fails.

A new worktree is told by the marker file `.projects-setup-done`, written when its setup succeeds and hidden from git through `info/exclude` (shared by the checkout and all its worktrees). Opening the worktree again skips `copy` and `worktree.setup`. A worktree whose setup failed has no marker, so the next open tries again. `startup.quickSetup` runs the commands one by one inside the popup instead (30 s each, popup busy, with the same braces and `PROJECTS_*` environment, each shown as `$ <command>`); the marker is written after they succeed.

## Development

```bash
node --test test/*.test.mjs
herdr-app check mods/projects
cp ~/.config/herdr-app/gpui-kit.d.ts ~/.config/herdr-app/herdr.d.ts mods/projects/
```
