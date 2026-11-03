# Projects mod, phase 2: launch screen, setup and agent timing. Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Opening a project goes through a launch screen (branch, open as, optional prompt, agent timing, layout); a new worktree gets gitignored files copied in and its setup commands run in a visible terminal; the agent starts after setup or beside it, as chosen per launch.

**Architecture:** Setup never waits inside the popup. The setup commands become one shell line (the "chain") built by a pure function in `lib.js`; for `after` timing the chain runs in the agent's own pane and `exec`s into the agent when it succeeds; for `with` timing it runs in a separate terminal that closes on success and stays at a shell on failure. A new `setup.js` owns file copying and the new-worktree marker. `workspace.js` stays the single build path and learns the two timings. The picker's branch-name step becomes the launch screen; the editor gains the copy and setup boxes as multi-line text.

**Tech Stack:** JavaScript ES modules on gpui-kit / gpui-base (`TextareaState` / `Textarea` for multi-line boxes) inside herdr-app 0.1.12 with hc 0.1.17; `node --test test/*.test.mjs` with the stubs in `test/helpers/`; `herdr-app check`; git; `sh`.

**Spec:** `docs/superpowers/specs/2026-11-02-projects-mod-design.md`, sections 4.2, 4.3, 5, 7 (Copy, Worktree setup, Startup setup, Quick launch, multi-line boxes, card setup summary), 8 (`agentTiming`), phase 2 of 9, 10. Phase 3 (the watcher, `existing`, `autoLayout`) is not in this plan.

## Global Constraints

- Host: `herdr-app 0.1.12`, `hc 0.1.17`. Mods run in the app's runtime: no `setTimeout`, no `structuredClone`, no top-level `await`; `cx.timer` and `cx.spawn` only. `InputState.new` and `TextareaState.new` need a live host call: create them in `init` or an event handler, never in `render`.
- `render()` never reads live herdr data; it draws from `this.snap`. Only `theme()` is read live.
- **Nothing waits on a long step inside the popup.** The popup's tasks are cancelled when it closes, and it closes on any click outside it. `exec` is capped at 30 s. Setup therefore runs in terminals the mod starts and does not await (spec 4.2).
- The chain's failure path leaves a shell: every chain ends `|| exec "$SHELL"`. On success the `after` chain `exec`s the agent; the `with` chain's terminal exits and the app closes its pane.
- Variables in copy paths and setup commands, as braces and as env: `{main}` the project checkout, `{folder}` the folder being set up, `{branch}`, `{repo}`, `{name}`, `{home}`; env `PROJECTS_MAIN`, `PROJECTS_FOLDER`, `PROJECTS_BRANCH`, `PROJECTS_REPO`, `PROJECTS_NAME`, `PROJECTS_HOME`.
- The marker file is `.projects-setup-done` in the worktree; its name is added to the worktree's `git rev-parse --git-path info/exclude`. `copy` never overwrites an existing destination.
- Pure logic in `lib.js` (no `herdr` import); `herdr` calls in `setup.js`, `git.js`, `workspace.js`, `config.js`, `main.js`.
- Test command: `node --test test/*.test.mjs` (a bare directory fails on this Node). `herdr-app check mods/projects` after every task that touches `mods/`. Mods cannot import across folders.
- Every phase 1 data file keeps loading: new fields get defaults in `normalize`; `startup.setup` written with `;;` still parses.
- Style: 2-space indent, double quotes, semicolons, ES modules, short doc comments. Commit after every task; imperative subjects under about 50 characters.

## Review Focus

1. A setup command containing single quotes, `$VAR` or `&&` must reach the shell intact: the chain quotes nothing inside a step, only the values it exports and the paths it adds. (Task 2, `setupChain` test with `echo 'it''s $HOME' && true`.)
2. A copy pattern that matches nothing, or whose destination already exists, must be skipped and logged, never overwrite, and never abort the launch. (Task 3, `copyInto` tests.)
3. An `after` launch with a `send`-mode prompt must start the detached helper and return at once, never await readiness in the popup. (Task 4, workspace test asserting `hc run` was recorded and nothing was `sent`.)
4. An old file whose `startup.setup` was saved with `;;` must load as the same list and show one command per line in the editor. (Task 2 `splitList` test; Task 7 editor test.)
5. A branch typed with `/` is used verbatim, and an invalid one (`a//b`, trailing `.lock`) is refused with git's message rather than slugged. (Task 3, git tests.)

---

### Task 1: Spike the two host behaviors the plan depends on

**Files:**
- Create: `docs/superpowers/notes/2026-11-03-phase2-spike.md`
- Test: none (manual, in the running app)

**Interfaces:**
- Consumes: the running app, `hc`, `herdr-app do`.
- Produces: two recorded facts later tasks consume: (A) how a `with`-timing setup terminal can be placed in the new space and whether it closes on exit; (B) what a `TextareaState` does with Enter and modified Enter.

- [ ] **Step 1: Setup-terminal placement.** With any space open, note its id from `herdr-app ls`. Run:

```bash
hc run --cwd "$HOME" --label herdr.space=<space id> --label herdr.tab=setup-$(date +%s) --rm -- sh -c 'echo setup; sleep 8'
```
Record: does a new tab appear in that space (`herdr-app ls`), what is it named, does `herdr-app do tab.rename '{"id":"<its id>","name":"setup"}'` work on it, and does the tab disappear by itself when the command exits. Then repeat with `sh -c 'false || exec "$SHELL"'` and record that the tab stays at a shell. If labels with a made-up tab id do nothing, run instead `herdr-app do tab.new '{"space":"<id>","name":"setup","folder":"'$HOME'","argv":["sh","-c","echo setup; sleep 8"]}'` and record what remains in that tab after the command exits (a shell prompt, or the tab closes).

- [ ] **Step 2: Textarea keys.** Write a throwaway mod `~/.config/herdr-app/mods/zz-spike/main.js` (`mod.json`: `{ "place": "none", "overlay": { "kind": "popup", "width": 400, "height": 200 } }`) whose `init` makes `this.ta = TextareaState.new({ placeholder: "type", rows: 3 })`, `this.ta.on("submit", () => console.log("[spike] submit"))`, and whose root has `.track_focus(h).on_key_down((e) => console.log("[spike] key", e.key, JSON.stringify(e.modifiers)))` and renders `Textarea.new(this.ta)`. Open it with `herdr-app do mod.open '{"name":"zz-spike"}'`, click into the box, press Enter, Shift+Enter, ctrl+Enter and cmd+Enter, and read `herdr-app status` / the app log for the `[spike]` lines. Record for each key: did the key handler see it, did `submit` fire, did a newline appear (type text before and after and read `value()` by logging it on `change`). Delete the spike mod afterwards.

- [ ] **Step 3: Write the notes file** with both results under headings "A. Setup terminal" and "B. Textarea keys", each ending with one line "Decision for the plan: …" chosen as follows. (A) If a labeled `hc run` terminal appears as a tab in the space and its pane closes on exit, the `with` setup terminal uses labels (`herdr.space=<space>`, `herdr.tab=setup-<timestamp>`) and is renamed "setup" if rename works; else it uses `tab.new` with `argv` and the tab stays at a shell on success. (B) If plain Enter inserts a newline and ctrl/cmd+Enter reaches the key handler, the prompt box launches on ctrl+Enter / ⌘Enter and the hint says so; if plain Enter fires `submit` and Shift+Enter inserts a newline, the prompt box launches on Enter and the hint says Shift+Enter for a newline. Any other outcome: record it and choose the closest.

- [ ] **Step 4: Commit**

```bash
git add docs/superpowers/notes/2026-11-03-phase2-spike.md
git commit -m "Record the phase 2 host spikes"
```

### Task 2: The model and the setup chain in lib.js

**Files:**
- Modify: `mods/projects/lib.js` (`blankProject`, `normalize`, `splitList`, `joinList`, new functions), `test/lib.test.mjs`

**Interfaces:**
- Consumes: existing `expand(template, vars)`, `splitArgs`.
- Produces, exported from `lib.js`:
  - `blankProject()` gains `worktree.copy: []`, `worktree.setup: []`, `startup.quickSetup: false`, top-level `quickLaunch: false`. `normalize` fills them (arrays of strings, blanks dropped and trimmed).
  - `splitList(text)` splits on `;;` **or** newlines; `joinList(list)` joins with `"\n"`.
  - `shq(s)` → single-quoted shell word (`'` becomes `'\''`).
  - `setupVars({ main, folder, branch, repo, name, home })` → `{ vars, env }` where `vars` is the brace map and `env` is `{ PROJECTS_MAIN, … }` in that order.
  - `setupChain({ steps, vars, env, folder, marker })` → string or `""` when `steps` is empty. Shape, joined with `; ` and ` && `: `export K='v'` for each env entry; `cd '<folder>'`; each step with `{var}` expanded by `expand` and otherwise verbatim; `touch '<marker>'` when `marker` is given. Exactly: `export PROJECTS_MAIN='…'; export …; cd '<folder>' && step1 && step2 && touch '<marker>'`.
  - `chainThenAgent(chain, argv, prompt)` → `${chain} && exec ${argv.map(shq).join(" ")}${prompt ? " " + shq(prompt) : ""} || exec "$SHELL"`; with an empty `chain` returns `""` (the caller starts the agent normally).
  - `chainAlone(chain)` → `${chain} || exec "$SHELL"`.
  - `setupSummary(project)` → `"2 copy · 3 setup · agent after setup"` from `worktree.copy.length`, `worktree.setup.length + startup.setup.length`, and `agentTiming`; parts with zero are omitted; `"no setup"` when both are zero.

- [ ] **Step 1: Write the failing tests**

```js
test("normalize fills copy, worktree setup, quickSetup and quickLaunch, dropping blank lines", () => {
  const p = normalize({ path: "/a", worktree: { copy: [" .env ", "", ".claude/*"], setup: ["npm ci", "  "] } });
  assert.deepEqual([p.worktree.copy, p.worktree.setup, p.startup.quickSetup, p.quickLaunch], [[".env", ".claude/*"], ["npm ci"], false, false]);
});
test("splitList takes ;; or newlines; joinList writes lines", () => {
  assert.deepEqual(splitList("a ;; b\nc\n\n"), ["a", "b", "c"]);
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
test("setupChain exports env, cds, runs steps verbatim with braces expanded, and touches the marker", () => {
  const { vars, env } = setupVars({ main: "/m", folder: "/w", branch: "b", repo: "r", name: "N", home: "/h" });
  const c = setupChain({ steps: ["cp {main}/.env .env", "echo 'it''s $HOME' && true"], vars, env, folder: "/w", marker: "/w/.projects-setup-done" });
  assert.equal(c, "export PROJECTS_MAIN='/m'; export PROJECTS_FOLDER='/w'; export PROJECTS_BRANCH='b'; export PROJECTS_REPO='r'; export PROJECTS_NAME='N'; export PROJECTS_HOME='/h'; cd '/w' && cp /m/.env .env && echo 'it''s $HOME' && true && touch '/w/.projects-setup-done'");
  assert.equal(setupChain({ steps: [], vars, env, folder: "/w" }), "");
  assert.ok(!setupChain({ steps: ["x"], vars, env, folder: "/w" }).includes("touch"));
});
test("chainThenAgent execs the quoted agent with the prompt and falls back to a shell; chainAlone only falls back", () => {
  assert.equal(chainThenAgent("cd '/w' && npm ci", ["claude", "--model", "opus"], "fix it's"), "cd '/w' && npm ci && exec 'claude' '--model' 'opus' 'fix it'\\''s' || exec \"$SHELL\"");
  assert.equal(chainThenAgent("", ["claude"], "x"), "");
  assert.equal(chainAlone("cd '/w' && npm ci"), "cd '/w' && npm ci || exec \"$SHELL\"");
});
test("setupSummary counts copy and setup and names the timing", () => {
  assert.equal(setupSummary(normalize({ path: "/a", worktree: { copy: [".env"], setup: ["npm ci", "npm run build"] }, startup: { setup: ["docker compose up -d"], agentTiming: "after" } })), "1 copy · 3 setup · agent after setup");
  assert.equal(setupSummary(normalize({ path: "/a", startup: { agentTiming: "with" } })), "no setup");
});
```
Also run the chain in a real shell to prove the quoting: in the same file, `execFileSync("sh", ["-c", setupChain({ steps: ["printf '%s' \"$PROJECTS_NAME-{branch}\" > out.txt"], vars, env, folder: dir })], { encoding: "utf8" })` with `dir` from `scratch()`, then assert `out.txt` holds `N-b`.

- [ ] **Step 2: Run to verify failure**

Run: `node --test test/lib.test.mjs` Expected: FAIL, `shq is not a function` and the new fields missing.

- [ ] **Step 3: Implement in `lib.js`**

The signatures above. `normalize`'s list fill: `(Array.isArray(x) ? x : []).map((s) => String(s).trim()).filter(Boolean)`. Update the existing `"joinList and splitList round-trip"` test to the newline form.

- [ ] **Step 4: Run all tests, commit**

Run: `node --test test/*.test.mjs` Expected: PASS (the editor's Setup box still uses `joinList`, which now writes newlines; its existing test asserts the list, not the separator).

```bash
git add mods/projects/lib.js test/lib.test.mjs
git commit -m "Model copy and setup lists, and build the setup chain"
```

### Task 3: setup.js (copy, marker, exclude) and verbatim branch names

**Files:**
- Create: `mods/projects/setup.js`, `test/setup.test.mjs`
- Modify: `mods/projects/git.js` (`templateVars` / `createWorktree` / `previewBranch` for verbatim `/` names; remove `runSetup`), `test/git.test.mjs`

**Interfaces:**
- Consumes: `exec` from `herdr`; `expand`, `shq` from `lib.js`; `git` helper and `inspect` in `git.js`.
- Produces, exported from `setup.js`:
  - `MARKER = ".projects-setup-done"`.
  - `isNewWorktree(folder)` → `Promise<boolean>`: true when `<folder>/MARKER` does not exist.
  - `markerPath(folder)` → `${folder}/${MARKER}`.
  - `excludeMarker(folder)` → appends `MARKER` to the file named by `git -C <folder> rev-parse --git-path info/exclude` when not already there; resolves to the exclude file path; never throws (logs).
  - `copyInto({ main, dest, patterns, vars, log })` → `Promise<{ copied: string[], skipped: string[], missing: string[] }>`. Each pattern has `{var}`s expanded, is a glob relative to `main` (expanded by `sh` inside `main`), and each match is copied with `cp -R` to the same relative path under `dest`, creating parent folders; an existing destination is skipped; a pattern with no match is `missing`. Implemented as one `exec("sh", ["-c", SCRIPT, "sh", main, dest, ...patterns])` whose stdout is lines `copied <rel>` / `skipped <rel>` / `missing <pattern>`. `log` gets one summary line: `copied 2 files, skipped 1 existing, 1 pattern matched nothing`.
- `git.js`:
  - `createWorktree(project, text, log)` and `previewBranch(project, text)`: when `text` contains `/`, the wanted branch is `text.trim()` verbatim (still validated by `git check-ref-format --branch`, still suffixed `-2`… on collision); otherwise as today.
  - `runSetup` stays in `git.js` untouched this task (`main.js` still calls it); Task 5 deletes it along with its three tests.

The copy script, for the implementer (fixed; copy it):
```sh
main=$1; dest=$2; shift 2
cd "$main" || exit 1
for pat in "$@"; do
  found=0
  for f in $pat; do
    [ -e "$f" ] || continue
    found=1
    if [ -e "$dest/$f" ]; then echo "skipped $f"; continue; fi
    mkdir -p "$dest/$(dirname "$f")" && cp -R "$f" "$dest/$f" && echo "copied $f" || echo "failed $f"
  done
  [ "$found" = 1 ] || echo "missing $pat"
done
```

- [ ] **Step 1: Write the failing tests in `test/setup.test.mjs`** (same header as `git.test.mjs`: `./helpers/setup.mjs`, `makeRepo`, `scratch`)

```js
test("copyInto copies matches by relative path, creates folders, skips existing files and reports misses", async () => {
  const main = makeRepo(); const dest = scratch("pp-dest"); const notes = [];
  mkdirSync(join(main, ".claude"), { recursive: true });
  writeFileSync(join(main, ".env"), "A=1\n"); writeFileSync(join(main, ".env.local"), "B=2\n"); writeFileSync(join(main, ".claude", "settings.local.json"), "{}");
  mkdirSync(join(dest, ".claude"), { recursive: true }); writeFileSync(join(dest, ".claude", "settings.local.json"), "mine");
  const r = await copyInto({ main, dest, patterns: [".env*", ".claude/settings.local.json", "nope/*"], vars: {}, log: (m) => notes.push(m) });
  assert.deepEqual(r, { copied: [".env", ".env.local"], skipped: [".claude/settings.local.json"], missing: ["nope/*"] });
  assert.equal(readFileSync(join(dest, ".env"), "utf8"), "A=1\n");
  assert.equal(readFileSync(join(dest, ".claude", "settings.local.json"), "utf8"), "mine");
  assert.match(notes[0], /copied 2 files, skipped 1 existing, 1 pattern matched nothing/);
});
test("copyInto expands {var}s in patterns and copies a folder", async () => {
  const main = makeRepo(); const dest = scratch("pp-dest");
  mkdirSync(join(main, "cfg", "b"), { recursive: true }); writeFileSync(join(main, "cfg", "b", "x"), "x");
  const r = await copyInto({ main, dest, patterns: ["{d}"], vars: { d: "cfg" }, log: () => {} });
  assert.deepEqual(r.copied, ["cfg"]);
  assert.equal(readFileSync(join(dest, "cfg", "b", "x"), "utf8"), "x");
});
test("isNewWorktree, markerPath and excludeMarker", async () => {
  const repo = makeRepo();
  assert.equal(await isNewWorktree(repo), true);
  writeFileSync(markerPath(repo), "");
  assert.equal(await isNewWorktree(repo), false);
  const file = await excludeMarker(repo);
  assert.match(readFileSync(file, "utf8"), /\.projects-setup-done\n/);
  await excludeMarker(repo);
  assert.equal(readFileSync(file, "utf8").split(".projects-setup-done").length, 2);
});
test("excludeMarker on a linked worktree writes the worktree's own exclude file", async () => {
  const repo = makeRepo(); const wt = join(scratch("pp-wt"), "w");
  sh(repo, "worktree", "add", "-q", wt, "-b", "w");
  const file = await excludeMarker(wt);
  assert.ok(file.includes("worktrees"), file);
});
```
And in `test/git.test.mjs`:
```js
test("a branch typed with a slash is used verbatim, else the template applies", async () => {
  const dir = realpathSync(makeRepo({ name: "Ada" }));
  const p = project(dir);
  assert.equal(await G.previewBranch(p, "feat/login"), "feat/login");
  assert.equal(await G.previewBranch(p, "login"), "ada/login");
  const wt = await G.createWorktree(p, "feat/login", note);
  assert.equal(wt.branch, "feat/login");
});
test("an invalid verbatim branch is refused with git's reason", async () => {
  const p = project(realpathSync(makeRepo()));
  await assert.rejects(G.createWorktree(p, "a//b", note), /is not a valid branch name/);
  await assert.rejects(G.createWorktree(p, "x/y.lock", note), /is not a valid branch name/);
});
```

- [ ] **Step 2: Run to verify failure**

Run: `node --test test/setup.test.mjs test/git.test.mjs` Expected: FAIL, cannot find `setup.js`; preview returns `ada/feat-login`.

- [ ] **Step 3: Implement `setup.js` and the git.js changes**

`copyInto` parses stdout lines into the three lists (a `failed` line is logged and counted as neither). `excludeMarker` reads the file with `readTextFile`, appends with `writeTextFile(path, text + MARKER + "\n", old)`; both are `herdr` functions.

- [ ] **Step 4: Run all tests, check, commit**

Run: `node --test test/*.test.mjs` → PASS. `herdr-app check mods/projects` → 0.

```bash
git add mods/projects/setup.js mods/projects/git.js test/setup.test.mjs test/git.test.mjs
git commit -m "Copy gitignored files into a new worktree, and take slash branches verbatim"
```

### Task 4: Agent timing in workspace.js

**Files:**
- Modify: `mods/projects/workspace.js` (`buildWorkspace` signature and body), `test/helpers/herdr-stub.mjs` (`hc run`), `test/workspace.test.mjs`
- Create: `mods/projects/bin/send-prompt.sh`, `test/send-prompt.test.mjs`

**Interfaces:**
- Consumes: `chainThenAgent`, `chainAlone`, `shq` from `lib.js`; spike note A's decision; `appHome()` from `herdr`.
- Produces:
  - `buildWorkspace({ project, folder, name, tabs, prompt, agentTiming, chain, log })`: `agentTiming` `"after" | "with"` (default `"with"`); `chain` the setup chain text or `""`.
    - `after` with a non-empty `chain` and a lead agent: the lead pane's argv becomes `["sh", "-c", chainThenAgent(chain, agentArgv(lead.pane), arg ? prompt : "")]`; no `task` is passed; `send`-mode prompt: the mod starts the helper (below) right after the lead terminal is known and returns without awaiting readiness; `log("setup continues in the agent pane")`.
    - `after` with an empty `chain`: behaves as `with`.
    - `with` with a non-empty `chain`: the lead starts as today; after the space is found, the chain runs in a setup terminal per spike decision A: either `hc(["run", "--cwd", folder, "--label", "herdr.space=<space>", "--label", "herdr.tab=setup-<Date.now()>", "--rm", "--no-parent", "--no-notify", "--", "sh", "-c", chainAlone(chain)])` then `tab.rename` if the spike said it works, or `appDo("tab.new", { space, name: "setup", folder, argv: ["sh", "-c", chainAlone(chain)] })`. `log("setup runs in the setup tab")`.
    - `with` without a chain: unchanged from phase 1.
    - A lead agent in a later pane keeps working: the chain wraps whatever argv that pane gets (through `inFolder`, which `exec`s `sh -c …`).
    - No lead agent and a chain: the chain runs in a setup terminal as in `with`, whatever `agentTiming` says.
  - `mods/projects/bin/send-prompt.sh <terminal> <prompt-file> [timeout-seconds]`: polls `hc get <terminal> --json` every 2 s; when the output contains `"status":"idle"` or `"status":"done"` it runs `hc send <terminal> "$(cat prompt-file)"`, deletes the prompt file and exits 0; `"status":"blocked"` or a missing terminal exits 1; after `timeout` (default 1800) exits 2. Pure POSIX sh, no jq.
  - The helper is started with `hc(["run", "--bg", "--rm", "--no-parent", "--no-notify", "--", "sh", "<appHome>/mods/projects/bin/send-prompt.sh", terminal, promptFile])` after writing `prompt` to `<appHome>/data/projects/prompt-<Date.now()>.txt` with `writeTextFile` (the `data/projects/` folder exists; the app makes it).
  - Stub: `hc(["run", …])` records `{ args }` to `state.hcRuns` and answers `{ code: 0, stdout: JSON.stringify({ address: "t-run-<n>" }) }`; `reset` clears it.

- [ ] **Step 1: Write the failing tests**

In `test/workspace.test.mjs` (helpers as the file already has; `proj`-style projects via `normalize`):
```js
test("after timing: the agent pane runs the chain and execs the agent with its arg prompt; no task is passed", async () => {
  const dir = realpathSync(makeRepo());
  const p = normalize({ name: "S", path: dir, startup: { tabs: [{ name: "agent", panes: [{ type: "agent", agent: "claude", args: "--model opus" }] }] } });
  const notes = [];
  await buildWorkspace({ project: p, folder: dir, name: "S", tabs: p.startup.tabs, prompt: "fix it", agentTiming: "after", chain: `cd '${dir}' && npm ci`, log: (m) => notes.push(m) });
  const sn = state.runs.find((r) => r.command === "space.new").args;
  assert.deepEqual(sn.argv.slice(0, 2), ["sh", "-c"]);
  assert.match(sn.argv[2], /npm ci && exec 'claude' '--model' 'opus' 'fix it' \|\| exec "\$SHELL"$/);
  assert.equal(sn.task, undefined);
  assert.ok(notes.includes("setup continues in the agent pane"));
  assert.equal(state.hcRuns.length, 0);
});
test("after timing with a send prompt starts the detached helper and does not wait or send", async () => {
  const dir = realpathSync(makeRepo());
  const p = normalize({ name: "S", path: dir, startup: { tabs: [{ name: "agent", panes: [{ type: "agent", agent: "hermes", promptMode: "send" }] }] } });
  state.agentStatus = "working";
  await buildWorkspace({ project: p, folder: dir, name: "S", tabs: p.startup.tabs, prompt: "go", agentTiming: "after", chain: "true", log: () => {} });
  assert.equal(state.sent.length, 0);
  const run = state.hcRuns[0].args;
  assert.ok(run.includes("--bg") && run.some((a) => a.endsWith("bin/send-prompt.sh")), run.join(" "));
  const file = run[run.length - 1];
  assert.equal(readFileSync(file, "utf8"), "go");
});
test("with timing runs the chain in a setup terminal beside the agent, which starts at once", async () => {
  const dir = realpathSync(makeRepo());
  const p = normalize({ name: "S", path: dir, startup: { tabs: [{ name: "agent", panes: [{ type: "agent", agent: "claude" }] }] } });
  const notes = [];
  await buildWorkspace({ project: p, folder: dir, name: "S", tabs: p.startup.tabs, prompt: "hi", agentTiming: "with", chain: "true", log: (m) => notes.push(m) });
  const sn = state.runs.find((r) => r.command === "space.new").args;
  assert.deepEqual([sn.argv, sn.task], [["claude"], "hi"]);
  assert.ok(notes.includes("setup runs in the setup tab"));
  // One of the two spike mechanisms: a labeled hc run, or a tab.new named setup; either way the chain ends in a shell fallback.
  const viaHc = state.hcRuns.find((r) => r.args.includes("run") && r.args.some((a) => a.startsWith("herdr.space=")));
  const viaTab = state.tabsMade.find((t) => t.name === "setup");
  const line = viaHc ? viaHc.args.at(-1) : viaTab?.argv?.[2];
  assert.match(line ?? "", /^true \|\| exec "\$SHELL"$/);
});
test("after timing with no chain behaves like with; no agent with a chain runs it in the setup terminal", async () => {
  const dir = realpathSync(makeRepo());
  const p = normalize({ name: "S", path: dir, startup: { tabs: [{ name: "agent", panes: [{ type: "agent", agent: "claude" }] }] } });
  await buildWorkspace({ project: p, folder: dir, name: "S", tabs: p.startup.tabs, prompt: "", agentTiming: "after", chain: "", log: () => {} });
  assert.deepEqual(state.runs.find((r) => r.command === "space.new").args.argv, ["claude"]);
  reset();
  const q = normalize({ name: "S", path: dir, startup: { tabs: [{ name: "s" }] } });
  const notes = [];
  await buildWorkspace({ project: q, folder: dir, name: "S", tabs: q.startup.tabs, prompt: "", agentTiming: "after", chain: "true", log: (m) => notes.push(m) });
  assert.ok(notes.includes("setup runs in the setup tab"));
});
```
In `test/send-prompt.test.mjs` (plain node, no stubs): a fake `hc` on PATH, written by the test to `<tmp>/bin/hc`, mode 0o755:
```sh
#!/bin/sh
case "$1" in
  get) printf '{"address":"%s","status":"%s"}\n' "$2" "$(cat "$STATE_FILE")" ;;
  send) printf '%s' "$3" >> "$SENT_FILE" ;;
esac
```
The test runs the helper with `execFileSync("sh", [SCRIPT, "t1", promptFile, String(timeout)], { env: { ...process.env, PATH: \`${tmp}/bin:${process.env.PATH}\`, STATE_FILE, SENT_FILE }, encoding: "utf8" })` where `SCRIPT` is the repo's `mods/projects/bin/send-prompt.sh`, and reads the exit code from the thrown error's `status` when non-zero.
```js
test("send-prompt.sh waits for idle, sends the file's text once, and removes the file", () => {
  writeFileSync(STATE_FILE, "working"); writeFileSync(promptFile, "hello");
  spawn("sh", ["-c", `sleep 3; echo idle > "${STATE_FILE}"`], { detached: true, stdio: "ignore" }).unref();
  run(10); // execFileSync as above; throws on non-zero
  assert.equal(readFileSync(SENT_FILE, "utf8"), "hello");
  assert.equal(existsSync(promptFile), false);
});
test("send-prompt.sh gives up on blocked (exit 1) and on timeout (exit 2)", () => {
  writeFileSync(STATE_FILE, "blocked"); writeFileSync(promptFile, "x");
  assert.equal(exitCode(() => run(10)), 1);
  writeFileSync(STATE_FILE, "working");
  assert.equal(exitCode(() => run(3)), 2);
  assert.equal(existsSync(SENT_FILE), false);
});
```
with `exitCode(fn)` returning `0` or the caught error's `status`.

- [ ] **Step 2: Run to verify failure**

Run: `node --test test/workspace.test.mjs test/send-prompt.test.mjs` Expected: FAIL (`agentTiming` ignored: argv is `["claude"]`; the script does not exist).

- [ ] **Step 3: Implement**

`workspace.js` per Interfaces; the stub's `hc run`; the script. Keep the phase 1 behavior for every test that passes no `agentTiming`/`chain`.

- [ ] **Step 4: Run all tests, check, commit**

Run: `node --test test/*.test.mjs` → PASS. `herdr-app check mods/projects` → 0.

```bash
git add mods/projects/workspace.js mods/projects/bin/send-prompt.sh test/workspace.test.mjs test/send-prompt.test.mjs test/helpers/herdr-stub.mjs
git commit -m "Start the agent after setup or beside it"
```

### Task 5: The launch sequence in start()

**Files:**
- Modify: `mods/projects/main.js` (`start`, the `runSetup` import and call), `mods/projects/git.js` (delete `runSetup`), `test/ui.test.mjs`, `test/git.test.mjs` (delete the three `runSetup` tests)

**Interfaces:**
- Consumes: `createWorktree`, `prepareMain`, `worktreeSpaceName`, `templateVars`, `inspect` from `git.js`; `copyInto`, `isNewWorktree`, `markerPath`, `excludeMarker` from `setup.js`; `setupVars`, `setupChain` from `lib.js`; `buildWorkspace` from Task 4.
- Produces: `start(p, { worktree, branchText = "", prompt = "", agentTiming = p.startup.agentTiming, pick = this.layoutNameFor(p) })`. Sequence, each step a busy note:
  1. `tabs = tabsForLaunch(...)`, `tabPlan(tabs)` (as today).
  2. Checkout path with an open space: `space.select` and dismiss (as today).
  3. Worktree: `createWorktree(p, branchText, log)`; then `isNew = await isNewWorktree(wt.folder)`; `vars`/`env` from `setupVars({ main: projectFolder(p), folder: wt.folder, branch: wt.branch, repo: wt.vars.repo, name: p.name, home: home() })`; if `isNew && p.worktree.copy.length`: `copyInto({ main, dest: wt.folder, patterns: p.worktree.copy, vars, log })`; `steps = (isNew ? p.worktree.setup : []).concat(p.startup.setup)`; `chain = setupChain({ steps, vars, env, folder: wt.folder, marker: isNew && steps.length ? markerPath(wt.folder) : undefined })`; if `isNew` and the chain has a marker: `await excludeMarker(wt.folder)`.
  4. Checkout: `prepareMain(p, log)`; `vars` with `folder: main`, `branch` from `inspect(main).branch`; `chain = setupChain({ steps: p.startup.setup, vars, env, folder: main })` (no marker, no copy).
  5. `startup.quickSetup` true: run the steps through `exec("sh", ["-c", step], { cwd })` one by one with the phase 1 `runSetup` semantics (stop at first failure, 30 s each) and pass `chain: ""` to `buildWorkspace` (the old behavior, kept behind the flag).
  6. `buildWorkspace({ project: p, folder, name, tabs, prompt, agentTiming, chain, log })`, then dismiss (as today; for a `with`-timing `send` prompt the popup still waits as in phase 1, since the agent started at once).
- The old call sites `this.start(r.p, mode === "always")` and the name step's `this.start(p, true, value)` become the object form (the launch screen replaces the name step in Task 6; for this task keep `askName` and pass `{ worktree: true, branchText }`).

- [ ] **Step 1: Write the failing UI tests** (in `test/ui.test.mjs`, launches through `enter(v)` as the existing launch tests do; use real repos from `makeRepo`/`makeClone`)

```js
test("opening a new worktree copies the listed files, runs worktree and startup setup once, and marks the worktree", async () => {
  const dir = realpathSync(makeRepo()); writeFileSync(join(dir, ".env"), "A=1\n");
  const root = scratch("pp-wt");
  const { v, cx } = await open([proj("api", dir, { worktree: { mode: "always", copy: [".env"], setup: ["npm ci"], branchTemplate: "{slug}", root: `${root}/{branch}` }, startup: { setup: ["echo hi"], agentTiming: "after", ...AG("claude") } })]);
  enter(v); await cx.settle();
  const wt = state.runs.find((r) => r.command === "space.new").args.folder;
  assert.equal(readFileSync(join(wt, ".env"), "utf8"), "A=1\n");
  const line = state.runs.find((r) => r.command === "space.new").args.argv[2];
  assert.match(line, /npm ci && echo hi && touch '.*\.projects-setup-done' && exec 'claude'/);
  assert.match(readFileSync(excludeFile(wt), "utf8"), /projects-setup-done/);
  assert.ok(v.notes.some((n) => /copied 1 file/.test(n)));
});
test("a worktree that already carries the marker gets only the startup setup: no copy, no worktree setup, no touch", async () => {
  const dir = realpathSync(makeRepo()); const wt = join(scratch("pp-wt"), "w"); sh(dir, "worktree", "add", "-q", wt, "-b", "w");
  writeFileSync(join(wt, ".projects-setup-done"), ""); writeFileSync(join(dir, ".env"), "A=1\n");
  const { v, cx } = await open([proj("wt", wt, { worktree: { mode: "never", copy: [".env"], setup: ["echo X"] }, startup: { setup: ["echo Y"], agentTiming: "after", ...AG("claude") } })]);
  enter(v); await cx.settle();
  const line = state.runs.find((r) => r.command === "space.new").args.argv[2];
  assert.match(line, /echo Y && exec/); assert.doesNotMatch(line, /echo X|touch/);
  assert.equal(existsSync(join(wt, ".env")), false);
});
test("quickSetup runs the steps inline before the agent and passes no chain", async () => {
  const dir = realpathSync(makeRepo());
  const { v, cx } = await open([proj("api", dir, { worktree: { mode: "never" }, startup: { setup: ["touch ran.txt"], quickSetup: true, agentTiming: "after", ...AG("claude") } })]);
  enter(v); await cx.settle();
  assert.equal(existsSync(join(dir, "ran.txt")), true);
  assert.deepEqual(state.runs.find((r) => r.command === "space.new").args.argv, ["claude"]);
  assert.ok(v.notes.some((n) => n === "$ touch ran.txt"));
});
test("a slash in the branch box is used verbatim", async () => {
  const dir = realpathSync(makeRepo()); const root = scratch("pp-wt");
  const { v, cx } = await open([proj("api", dir, { worktree: { mode: "ask", root: `${root}/{branch}` }, startup: AG("claude") })]);
  enter(v); await cx.settle();
  v.nameInput.set_value("feat/x"); enter(v); await cx.settle();
  assert.match(state.runs.find((r) => r.command === "space.new").args.name, /feat\/x/);
});
```
with a file-local helper `excludeFile(wt)`: `const p = sh(wt, "rev-parse", "--git-path", "info/exclude"); return p.startsWith("/") ? p : join(wt, p);`. The helper `enter(v)` at this task still submits `nameInput` in mode `"name"`; Task 6 changes it.

- [ ] **Step 2: Run to verify failure**

Run: `node --test test/ui.test.mjs` Expected: FAIL (no `.env` copied; argv is `["claude"]`).

- [ ] **Step 3: Implement `start()`; delete `runSetup` and its tests**

- [ ] **Step 4: Run all tests, check, commit**

Run: `node --test test/*.test.mjs` → PASS. `herdr-app check mods/projects` → 0.

```bash
git add mods/projects/main.js mods/projects/git.js test/ui.test.mjs test/git.test.mjs
git commit -m "Copy, set up and mark a new worktree before the agent"
```

### Task 6: The launch screen

**Files:**
- Modify: `mods/projects/main.js` (`activate`, `askName` → `openLaunch`, `renderName` → `renderLaunch`, `keys`, `footer`, `applyDemo`), `test/ui.test.mjs`

**Interfaces:**
- Consumes: Task 5's `start(p, opts)`; spike note B's decision; `TextareaState`/`Textarea` from gpui-base (stub them in `test/helpers/gpui-stub.mjs` like `InputState`/`Input`, with `set_rows`, `set_auto_grow`, `value`, `set_value`, `on`, `focus`).
- Produces:
  - `this.mode === "launch"` replaces `"name"`. `openLaunch(p, { mainOnly })` sets `this.target`, `this.launch = { worktree: !mainOnly && p.worktree.mode !== "never", agentTiming: p.startup.agentTiming }`, makes `this.nameInput` (as today, only shown when `worktree`; empty for `always` mode too, since the template fills `{slug}` with the time when nothing is typed), `this.promptBox = TextareaState.new({ placeholder: "First prompt (optional)", value: firstAgent(p.startup.tabs)?.pane.prompt ?? "", rows: 3 })`, and focuses the branch box when shown else the prompt box.
  - `activate(mainOnly)`: a template → duplicate (as today); `p.quickLaunch && (mainOnly || p.worktree.mode !== "ask")` → `start` at once with defaults; otherwise `openLaunch`.
  - `launchNow()` → `start(this.target, { worktree: this.launch.worktree, branchText: this.nameInput?.value() ?? "", prompt: this.promptBox.value().trim(), agentTiming: this.launch.agentTiming })`.
  - Screen (`renderLaunch`), top to bottom: title `Open · <name>` with the back/Esc hint; **Open as** row: two buttons `pp-open-worktree` / `pp-open-checkout`, the chosen one primary (Checkout only when the folder is a checkout; `never`-mode projects start on Checkout); **Branch** box with the live preview and the `from <remote>/<base>` line (only when Open as is Worktree); **Prompt** label with the hint from spike B (`Enter: newline · ⌘⏎ launches` or `Shift+Enter: newline · Enter launches`) and `Textarea.new(this.promptBox)`; **Agent** row: button `pp-timing-launch` labelled `Agent: after setup` / `Agent: with setup` toggling `this.launch.agentTiming`, with the hint `ctrl+alt+T` (⌘⌥T); hidden (and timing forced `with`) when the project has no setup commands for this launch (`worktree.setup` counts only for Open as Worktree); **Layout**: the existing `footer(t, p, false)` selector; a **Launch** primary button `pp-launch`.
  - Keys in mode `launch`: `ctrl+alt+T` / ⌘⌥T toggles timing; `ctrl+alt+L` cycles layout (as the name step did); Enter per spike B (the branch box's `submit` launches; `keys()` launches on Enter or modified Enter per the decision); `alt+b` back; Esc closes.
  - `applyDemo`: `"view": "launch-screen"` opens the screen on the named project (`"view": "launch"` keeps launching at once with defaults).

- [ ] **Step 1: Update and add UI tests.** Update every test that uses `v.mode === "name"`, `askName`, `renderName` or the `enter(v)` helper's name branch to the launch screen (`enter` becomes: `v.mode === "launch" ? v.launchNow() : v.search.emit("submit")`). Add:

```js
test("Enter on an ask project opens the launch screen with Open as Worktree, the prompt prefilled, and the project's timing", async () => {
  const { v, cx } = await open([proj("api", realpathSync(makeRepo()), { startup: { agentTiming: "after", setup: ["npm ci"], ...AG("claude", { prompt: "hello" }) } })]);
  enter(v); await cx.settle();
  assert.equal(v.mode, "launch");
  assert.deepEqual([v.launch.worktree, v.launch.agentTiming, v.promptBox.value()], [true, "after", "hello"]);
  const t = texts(v);
  for (const s of ["Open · api", "Worktree", "Checkout", "Branch", "Prompt", "Agent: after setup", "Launch"]) assert.ok(t.includes(s), s);
});
test("the launch screen launches with what was chosen: checkout, a typed prompt, timing toggled", async () => {
  const dir = realpathSync(makeRepo());
  const { v, cx } = await open([proj("api", dir, { worktree: { mode: "never" }, startup: { setup: ["true"], agentTiming: "after", ...AG("claude") } })]);
  enter(v); await cx.settle();
  v.promptBox.set_value("do the thing"); press(v, cx, "t", CTRL_ALT);
  assert.equal(v.launch.agentTiming, "with");
  v.launchNow(); await cx.settle();
  const sn = state.runs.find((r) => r.command === "space.new").args;
  assert.deepEqual([sn.argv, sn.task], [["claude"], "do the thing"]);
});
test("an empty prompt starts the agent bare", async () => {
  const dir = realpathSync(makeRepo());
  const { v, cx } = await open([proj("api", dir, { worktree: { mode: "never" }, startup: AG("claude", { prompt: "hello" }) })]);
  enter(v); await cx.settle(); v.promptBox.set_value(""); v.launchNow(); await cx.settle();
  const sn = state.runs.find((r) => r.command === "space.new").args;
  assert.deepEqual([sn.argv, sn.task, state.sent.length], [["claude"], undefined, 0]);
});
test("a project with no setup commands hides the Agent row and launches with", async () => {
  const dir = realpathSync(makeRepo());
  const { v, cx } = await open([proj("api", dir, { worktree: { mode: "never" }, startup: { agentTiming: "after", ...AG("claude") } })]);
  enter(v); await cx.settle();
  assert.doesNotMatch(texts(v), /Agent: /);
  v.launchNow(); await cx.settle();
  assert.deepEqual(state.runs.find((r) => r.command === "space.new").args.argv, ["claude"]);
});
test("quickLaunch skips the screen for always and never modes but not for ask", async () => {
  const dir = realpathSync(makeRepo()); const root = scratch("pp-wt");
  const mk = (name, mode) => proj(name, dir, { quickLaunch: true, worktree: { mode, root: `${root}/{branch}` }, startup: AG("claude") });
  const { v, cx } = await open([mk("never", "never"), mk("always", "always"), mk("ask", "ask")]);
  for (const [name, expected] of [["never", "busy"], ["always", "busy"], ["ask", "launch"]]) {
    v.search.set_value(name); v.at = 0; enter(v); await cx.settle();
    assert.equal(v.mode, expected, name);
    v.mode = "list"; reset(); // next project; a fresh stub state for each launch
  }
});
test("the demo view launch-screen opens the screen", async () => {
  const { v } = await open([proj("api", realpathSync(makeRepo()))]);
  v.applyDemo({ view: "launch-screen", project: "api" });
  assert.equal(v.mode, "launch");
});
test("Shift+Enter on the list opens the launch screen on the checkout path", async () => {
  const { v, cx } = await open([proj("api", realpathSync(makeRepo()), { worktree: { mode: "ask" } })]);
  press(v, cx, "enter", { shift: true }); await cx.settle();
  assert.deepEqual([v.mode, v.launch.worktree], ["launch", false]);
});
```

- [ ] **Step 2: Run to verify failure**

Run: `node --test test/ui.test.mjs` Expected: FAIL (`mode` is `"name"`; no `launchNow`).

- [ ] **Step 3: Implement**

The Interfaces block. Keep `renderLaunch` flat: rows of label + control; the hint strings exactly as spike B decided.

- [ ] **Step 4: Run all tests, check, try in the app, commit**

Run: `node --test test/*.test.mjs` → PASS. `herdr-app check mods/projects` → 0. In the app: `projects.demo` `{ "view": "launch-screen", "project": "<a project>" }`, open the picker, `herdr-app shot /tmp/projects-phase2-launch.png`, type in the prompt box and press the launch key the hint names, confirm the space opens; close the space and delete the demo file.

```bash
git add mods/projects/main.js test/ui.test.mjs test/helpers/gpui-stub.mjs
git commit -m "Choose branch, prompt, timing and layout on a launch screen"
```

### Task 7: Editor boxes and the card's setup summary

**Files:**
- Modify: `mods/projects/main.js` (`TEXT`, `SECTION_FIELDS`, `openEditor`, `renderEdit`, `renderTabs` for the timing button's caption, `renderCard`), `test/ui.test.mjs`

**Interfaces:**
- Consumes: `setupSummary`, `splitList`, `joinList` from `lib.js`; `TextareaState`/`Textarea`.
- Produces:
  - `TEXT` gains `["copy", "Copy from the checkout", (p) => joinList(p.worktree.copy), (p, v) => (p.worktree.copy = splitList(v)), "one path or glob per line, relative to the checkout; existing files are kept"]` and `["wtSetup", "Worktree setup", (p) => joinList(p.worktree.setup), (p, v) => (p.worktree.setup = splitList(v)), "one command per line; runs once, when the worktree is new"]` in the worktree section after `spaceName`; `setup`'s note becomes `"one command per line; runs on every open, after the worktree setup"`. `SECTION_FIELDS.worktree` and `.startup` list them.
  - Multi-line fields: `copy`, `wtSetup`, `setup` are `TextareaState`s (`rows: 3`, `set_auto_grow(3, 8)`) drawn with `Textarea.new`; `openEditor` makes them in `this.fields` like the others; `focusNextField` keeps working (the state objects are in `fieldOrder`).
  - Startup section: `pp-timing` caption under the button reads `agent starts once the setup commands finish` / `agent starts at once; setup runs in its own tab`; a `pp-quicklaunch` toggle `Quick launch: Enter opens at once with these defaults` setting `d.quickLaunch`; a `pp-quicksetup` toggle `Run setup inline (30 s per command, blocks the popup)` setting `d.startup.quickSetup`.
  - Card: a `Setup` row with `setupSummary(p)` after the `Tabs` row.

- [ ] **Step 1: Write the failing UI tests**

```js
test("the editor shows copy and worktree setup as one path or command per line and saves them as lists", async () => {
  const dir = realpathSync(makeRepo());
  const { v, cx } = await open([proj("api", dir, { worktree: { copy: [".env"], setup: ["npm ci"] }, startup: { setup: ["a ;; b"] } })]);
  press(v, cx, "e", { alt: true }); v.showSection("worktree");
  assert.equal(v.fieldState("copy").value(), ".env"); assert.equal(v.fieldState("wtSetup").value(), "npm ci");
  v.fieldState("copy").set_value(".env\n.claude/*"); v.fieldState("wtSetup").set_value("npm ci\nnpm run build");
  v.showSection("startup"); assert.equal(v.fieldState("setup").value(), "a\nb");
  await v.save(cx);
  const saved = JSON.parse(readFileSync(dataFile(), "utf8")).projects[0];
  assert.deepEqual([saved.worktree.copy, saved.worktree.setup, saved.startup.setup], [[".env", ".claude/*"], ["npm ci", "npm run build"], ["a", "b"]]);
});
test("quick launch and inline setup toggles are saved", async () => {
  const dir = realpathSync(makeRepo());
  const { v, cx } = await open([proj("api", dir)]);
  press(v, cx, "e", { alt: true }); v.showSection("startup");
  for (const id of ["pp-quicklaunch", "pp-quicksetup"]) findAll(rendered(v), (e) => e.op?.("id")?.[0] === id)[0].op("on_click")[0]({}, cx);
  await v.save(cx);
  const saved = JSON.parse(readFileSync(dataFile(), "utf8")).projects[0];
  assert.deepEqual([saved.quickLaunch, saved.startup.quickSetup], [true, true]);
});
test("the card summarises setup", async () => {
  const { v } = await open([proj("a", "/r/a", { worktree: { copy: [".env"], setup: ["x", "y"] }, startup: { agentTiming: "after" } }), proj("b", "/r/b")]);
  assert.match(texts(v), /1 copy · 2 setup · agent after setup/);
  v.at = 1; assert.match(texts(v), /no setup/);
});
```

- [ ] **Step 2: Run to verify failure** → FAIL (`fieldState("copy")` undefined).

- [ ] **Step 3: Implement**

- [ ] **Step 4: Run all tests, check, commit**

```bash
git add mods/projects/main.js test/ui.test.mjs
git commit -m "Edit copy and setup lists, and summarise setup on the card"
```

### Task 8: Docs, spec notes and the phase's done-when checks

**Files:**
- Modify: `RECIPE.md`, `README.md`, `mods/projects/demo.js` (header: `launch-screen`), `docs/superpowers/specs/2026-11-02-projects-mod-design.md` (section 5's prompt-box key per spike B; section 4.3's setup-terminal mechanism per spike A, one sentence each)

**Interfaces:** none new.

- [ ] **Step 1: Update RECIPE.md** — What you see: the launch screen (rows, buttons, hints) and the editor's new boxes; How it behaves: the sequence in Task 5, both timings, the marker, copy-never-overwrites, verbatim slash branches, quick launch, inline setup; Built from: `setup.js`, `bin/send-prompt.sh`, the `hc run` and `hc get` calls, the chain shape; Watch out: the popup cancels tasks on close (why nothing waits), a leftover prompt file in `data/projects/` if the helper dies, `exec`'s 30 s cap on inline setup; Done when: the list below.
- [ ] **Step 2: Update README.md** with a "Setup and the agent" section: the three lists, the variables, the two timings, the marker.
- [ ] **Step 3: Run the done-when list in the app** (throwaway repo under a temp folder with a `.env` and a `package.json` whose `npm ci` is replaced by `sleep 20` as the setup step; throwaway `projects.json`; cleanup afterwards exactly as phase 1's Task 6 did):
  - Ask mode with `copy: [".env"]`, `worktree.setup: ["sleep 20"]`, prompt typed, Agent after setup: the new space shows the sleep running in the agent pane; `hc ls` shows the pane's foreground change to the agent after 20 s; `.env` is in the worktree; `.projects-setup-done` exists and `git status` in the worktree is clean.
  - Same project, Agent with setup: the agent answers while a setup tab runs the sleep; the setup tab's pane closes (or returns to a shell, per spike A) when it ends.
  - Open the same worktree again (Open worktree, or a `never`-mode project pointing at it): the busy screen lists only the startup setup, no copy, no touch.
  - An empty prompt starts the agent bare. A branch typed `feat/x` creates `feat/x`.
  - A failing setup step (`false`) leaves the agent pane at a shell with the output above it and no agent.
  Record the outcomes with `herdr-app ls` / `hc ls` excerpts and screenshots in the commit body.
- [ ] **Step 4: Run everything and commit**

Run: `node --test test/*.test.mjs && herdr-app check mods/projects && herdr-app check mods/projects-launcher` → all green.

```bash
git add RECIPE.md README.md mods/projects/demo.js docs/superpowers/specs/2026-11-02-projects-mod-design.md
git commit -m "Document setup, timing and the launch screen"
```
