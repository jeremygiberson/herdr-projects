# Phase 2 host spikes (2026-11-03)

## A. Setup terminal

Space used: `sp81550a276e356a15584ee1e485aaaef1` ("~").

Command (run in the background, because `hc run` blocks until the program exits):

```
hc run --cwd "$HOME" --label herdr.space=<space> --label herdr.tab=setup-<ts> --rm -- sh -c 'echo setup; sleep 8'
```

- A new tab appeared in that space within 2 seconds. Its tab id is the made-up label value
  (`setup-1793694827`) and its name was "2" (the unnamed default, by position). The terminal was
  `t18`, parent `t2`, `where: "~ / 2"`.
- `herdr-app do tab.rename '{"id":"setup-1793694827","name":"setup"}'` returned `{"ok": true}`
  and `herdr-app ls` then showed the tab named `setup`. Rename works, addressed by the made-up id.
- After the command exited (8 s) the tab disappeared by itself (`--rm`). `hc run` printed `setup`.
- Repeat with `sh -c 'false || exec "$SHELL"'`: the tab appeared the same way (`t19`), and 10+ seconds
  later the terminal was still live at an interactive zsh prompt (`jeremygiberson@Jeremys-MBP ~ %`).
  It stays until killed (`hc kill t19`; the tab was then gone).
- The `tab.new` fallback was not needed.

Decision for the plan: the `with` setup terminal uses labels (`herdr.space=<space>`, `herdr.tab=setup-<timestamp>`), started in the background and with `--rm` for the run-and-close case; rename the tab to "setup" with `tab.rename` using that tab id, and for the stay-at-a-shell-on-failure case use `sh -c '<cmd> || exec "$SHELL"'`.

## B. Textarea keys

Throwaway mod `zz-spike` (popup, `TextareaState.new({placeholder:"type", rows:3})`, root `.track_focus(h).on_key_down(...)`,
`change`/`submit` handlers). Console lines were not located; each event was appended to an on-screen log in the popup
and screenshotted. Keys were synthesised with CGEvent after clicking in the box (typing `x`, the key, then `y`).
Note: `mod.open` right after creating the folder returned "no mod folder" once; it loaded a few seconds later.

| Key | Root key handler saw it | `submit` fired | Newline inserted |
|---|---|---|---|
| Enter | no | yes | yes (`change` to `"x\n"` before `submit`) |
| Shift+Enter | no | yes | yes |
| Cmd+Enter | no | yes | yes |
| Ctrl+Enter | yes (`key enter {"control":true,...}`) | no | no |

Ordinary letters reach the handler (modifiers all false) and fire `change`.
So Enter inserts a newline and also fires `submit` (the value passed to `submit` already ends in `\n`);
Shift+Enter and Cmd+Enter behave exactly like Enter; only Ctrl+Enter is untouched by the textarea and bubbles to the key handler.

Decision for the plan: plain Enter inserts a newline and ctrl+Enter reaches the key handler, so the prompt box launches on ctrl+Enter (do not rely on `submit` or Cmd+Enter), and the hint says "Ctrl+Enter to launch"; do not use `submit` at all since it fires on every Enter.
