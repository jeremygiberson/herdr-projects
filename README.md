# projects

A Herdr app mod that shows a picker of your configured git checkouts. Pick one to open it as a space with its own worktree, agent and pane layout, started the way you set it up for that project.

Started from [project-presets](https://github.com/cgill27/project-presets) by cgill27, MIT; see LICENSE.

## Install

```bash
ln -s "$PWD/mods/projects" ~/.config/herdr-app/mods/projects
ln -s "$PWD/mods/projects-launcher" ~/.config/herdr-app/mods/projects-launcher
```

Then merge `keys.json` into `~/.config/herdr-app/keys.json`.

## Development

```bash
node --test test/*.test.mjs
herdr-app check mods/projects
cp ~/.config/herdr-app/gpui-kit.d.ts ~/.config/herdr-app/herdr.d.ts mods/projects/
cp ~/.config/herdr-app/gpui-kit.d.ts ~/.config/herdr-app/herdr.d.ts mods/projects-launcher/
```
