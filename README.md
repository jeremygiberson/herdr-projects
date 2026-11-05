# projects

A Herdr app mod that shows a picker of your configured git checkouts. Pick one to open it as a space with its own worktree, agent and pane layout, started the way you set it up for that project.

Started from [project-presets](https://github.com/cgill27/project-presets) by cgill27, MIT; see LICENSE.

## Install

```bash
ln -s "$PWD/mods/projects" ~/.config/herdr-app/mods/projects
```

Then merge `keys.json` into `~/.config/herdr-app/keys.json`. Its `mod:projects` section sends Esc to the picker as a command; without it herdr closes the dialog on Esc and the picker never sees the key.

## The clickable Projects button

The picker's **Launcher: add to layout** button writes a copy of the shown layout with three small blocks (beside the sidebar's spaces, the status bar and the tab bar) and switches to it; the button then reads **Launcher: sidebar / status bar / tab bar / off** and each click moves the Projects button to the next place. Each block loads this same `projects` mod with a `slot` prop: that copy draws the button and also runs the auto-layout watcher (it sets up spaces opened outside the picker for auto-layout projects). **Launcher: off** hides every block, and a hidden block's copy may never start, so it turns the watcher off too: keep the button shown somewhere if you rely on auto-layout. A layout made before the launcher moved into this mod (its blocks name `projects-launcher`) is rewritten to load `projects` the next time you click the Launcher button.

## Auto-layout

Auto-layout sets up a space you open outside the picker (the app's New space, or New worktree from its menu) the way the picker would. To turn it on: put the launcher button in the layout (Launcher in the picker's toolbar, any place but off), then switch **Auto-layout** on in the project's editor. Only one project per repo can have it; turning it on moves it from the other with a toast.

When a new space appears (a 2 s poll; switching to a space does nothing, and spaces open at app start, or restored while the app loads, are left alone) whose folder is the project's checkout or one of its worktrees, has one tab with one pane, and that pane is a shell or an agent (one still at its trust prompt counts), the watcher builds the project's tabs into it. A running agent stays and setup runs beside it in a "setup" tab; a shell gets the agent line typed into it, but only at a bare prompt: if you have started typing there, the line is skipped and the toast counts it as a problem. A worktree new to the project also gets `copy` and `worktree.setup`; the checkout gets only `startup.setup`. There is no prompt. A project in a subfolder of its repo is built in that subfolder, of the checkout or of the worktree.

The watcher runs in the launcher block's copy of the mod, and a copy runs only once its block has been drawn: if the chosen place's block never shows in a session (the sidebar collapsed since startup, with the button in the sidebar), there is no watcher until it does. Pick the status bar or tab bar if you keep the sidebar collapsed.

Repos that are not projects can be covered by an `autoLayouts` list at the top level of `projects.json`, and `defaultAgent` fills agent panes in those layouts. Both are JSON-only (no editor):

```json
{
  "projects": [],
  "autoLayouts": [
    { "repo": "*", "branch": "release", "layout": "deploy" },
    { "repo": "notes", "layout": "agent-terminal" }
  ],
  "defaultAgent": { "agent": "claude", "args": "" }
}
```

`repo` is a repo name or `*`, `branch` is optional, `layout` is a layout by name: a panes layout (one tab) or a tabs layout. The best match wins: repo and branch, then repo, then `*` with branch, then `*`. These layouts get tabs and panes only, no copy or setup. A repo that is a project is never covered by this list, even with the project's auto-layout off.

## Launch from another mod

Another mod can open the picker straight onto the launch screen for a branch, for example to start work on a ticket. It opens the projects mod as an overlay and passes a `launch` prop:

```js
openOverlay({
  mod: "projects", kind: "dialog", width: 0.8, height: 0.8,
  props: {
    launch: {
      v: 1,
      branch: "jeremy/sc-1234/fix-the-thing",   // required
      checkout: "new",                          // "new" (default) or "existing"
      name: "sc-1234 · Fix the thing",          // ignored: the project's space-name template wins
      prompt: "Read the shortcut story …",      // optional: fills the first-prompt box
      source: { kind: "shortcut", id: "sc-1234", url: "https://app.shortcut.com/…", title: "Fix the thing" },
      repo:   { names: ["vizion-api"], urls: ["https://github.com/org/vizion-api"], folder: null } // hints
    },
    backTo: { mod: "shortcut", props: { screen: "story", id: 1234 } }  // optional: Esc reopens this mod
  }
})
```

The `repo` hints are matched against your projects. If exactly one project matches, the launch screen opens with the branch and prompt filled in. If none or several match, the picker shows the project list with a banner, "Starting ‹source.id› on ‹branch›: pick a project", and the launch screen opens once you choose one. A `v` the picker doesn't know shows a red message and nothing else.

With `checkout: "existing"` the picker checks out the local branch, or tracks `<remote>/<branch>` if only the remote has it. It never adds a `-N` suffix. If a worktree is already on that branch it is reused, and its open space is selected instead of making a new one.

`launch.name` is ignored: the project's space-name template decides the space name.

When `backTo` is given, Esc on the launch screen closes the picker and reopens that mod with the given props. Without it, Esc goes back to the project list as usual. Esc reaches the picker through the `mod:projects` section of `keys.json` (see Install), so that section must be merged for `backTo` to work.

## Projects file

Projects live in `~/.config/herdr-app/data/projects.json`; the editor writes it, and you can edit it by hand. A project's `agent` is what its agent panes run: a command, arguments, environment lines (`KEY=value`, set for the agent only), a default prompt (it prefills the launch screen) and how the prompt is delivered. Its `startup.tabs` is the list of tabs its space opens with. A tab has a `folder` (relative to the project or worktree, or absolute) and either a `command` or `panes`; a pane is an `agent`, a `shell` or a `command`, split `right` or `down` from the previous one, and its `folder` is relative to its tab's folder. An agent pane that names no `agent` of its own runs the project's agent; when the project names none either, the first installed agent. So picking "Agent + terminal right" on a project with only a terminal tab still starts an agent. Folders are checked before anything is created.

```json
{
  "projects": [{
    "name": "Shop", "description": "storefront monorepo", "path": "~/dev/shop", "group": "work", "pinned": true,
    "worktree": {
      "mode": "ask", "branchTemplate": "{user}/{date}-{slug}", "root": "~/.herdr/worktrees/{repo}/{branch}",
      "spaceName": "{name} · {branch}", "repoSpace": false
    },
    "git": { "fetch": true, "remote": "origin", "base": "main", "fastForward": false },
    "agent": { "command": "claude", "args": "--model claude-sonnet-5-5", "env": ["CLAUDE_CODE_DISABLE_1M_CONTEXT=1"], "prompt": "", "promptMode": "arg" },
    "startup": {
      "setup": ["docker compose up -d"],
      "tabs": [
        { "name": "agent", "panes": [
            { "type": "agent" },
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

Commands can use `{main}` (the project checkout), `{folder}` (the folder being set up), `{branch}`, `{repo}`, `{name}` and `{home}`; the same values are in the environment as `PROJECTS_MAIN`, `PROJECTS_FOLDER`, `PROJECTS_BRANCH` and so on. Only those six braces are filled: `${PROJECTS_MAIN}`, `awk '{print}'` and `jq '{x: .y}'` are left as written. The lines run as one `sh -e` script from the folder being set up, like a shell script: a `cd` on one line reaches the lines after it, a comment, `;`, `&` or `||` stays on its line, and the first failing line stops the script. The script runs in your own shell as an interactive login shell (`$SHELL -ilc`), so it finds whatever your terminals find: a tool that `.zshrc` or `.bashrc` puts on the PATH (nvm's node and pnpm, pyenv) works. Tab commands and command panes run the same way. The launch screen closes within seconds even when setup takes minutes; its busy screen says how many commands the new space will run.

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
