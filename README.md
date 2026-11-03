# projects

A Herdr app mod that shows a picker of your configured git checkouts. Pick one to open it as a space with its own worktree, agent and pane layout, started the way you set it up for that project.

Started from [project-presets](https://github.com/cgill27/project-presets) by cgill27, MIT; see LICENSE.

## Install

```bash
ln -s "$PWD/mods/projects" ~/.config/herdr-app/mods/projects
ln -s "$PWD/mods/projects-launcher" ~/.config/herdr-app/mods/projects-launcher
```

Then merge `keys.json` into `~/.config/herdr-app/keys.json`.

## Projects file

Projects live in `~/.config/herdr-app/data/projects.json`; the editor writes it, and you can edit it by hand. A project's `startup.tabs` is the list of tabs its space opens with. A tab has a `folder` (relative to the project or worktree, or absolute) and either a `command` or `panes`; a pane is an `agent`, a `shell` or a `command`, split `right` or `down` from the previous one. Folders are checked before anything is created.

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

## Development

```bash
node --test test/*.test.mjs
herdr-app check mods/projects
cp ~/.config/herdr-app/gpui-kit.d.ts ~/.config/herdr-app/herdr.d.ts mods/projects/
cp ~/.config/herdr-app/gpui-kit.d.ts ~/.config/herdr-app/herdr.d.ts mods/projects-launcher/
```
