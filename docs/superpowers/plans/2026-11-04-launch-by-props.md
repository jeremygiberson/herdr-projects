# Projects Launch-by-Props Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Let another mod open the projects picker with a `launch` prop (branch, checkout mode, prompt, source, repo hints) so it resolves the project, prefills its launch screen, and can check out an existing branch instead of creating one.

**Architecture:** A parsed launch request is held on the picker until the project list has loaded; it then either opens the launch screen prefilled on the one matching project or shows the list with a banner until a project is picked. `createWorktree` gains an `existing` mode that fetches and checks out a branch that already exists locally or on the remote. Esc on a props-driven launch returns to the mod named in `backTo`, as the github mod does.

**Tech Stack:** JavaScript ES modules on gpui-kit / gpui-base inside herdr-app 0.1.13 with hc 0.1.18; `node --test test/*.test.mjs` with the stubs in `test/helpers/`; `herdr-app check mods/projects`; git.

**Spec:** `~/gitprojects/herdr-shortcut/docs/superpowers/specs/2026-11-04-shortcut-mod-design.md`, sections 7 (the launch contract) and 8.3 (this mod's entry). Read both before any task.

## Global Constraints

- Test command: `node --test test/*.test.mjs` (a bare directory fails on this Node). `herdr-app check mods/projects` after every task that touches `mods/`.
- Mods cannot import across folders; no `setTimeout`; never keep `cx` beyond the handler that received it (the picker already stores `this.cx` once in `init`, keep that pattern).
- Contract version is `1`. Unknown versions are refused with a visible message, never guessed.
- `checkout` is `"new"` (default) or `"existing"`; in existing mode there is no `-N` suffixing.
- A launch request never touches a ticket; nothing in this mod calls out to Shortcut or GitHub.
- The launch is not fired automatically from props: the launch screen opens prefilled and waits for Enter / ctrl+Enter (spec section 8.3 step 3).
- `launch.name` is ignored; the project's `worktree.spaceName` template names the space.
- Work on a branch `launch-by-props` off `main`; one commit per task.

## Review Focus

- A `launch` prop with `branch` missing or empty: the picker must show the list with a red banner "Launch request has no branch" and otherwise behave normally (Task 1 test `parseLaunch rejects a missing branch`).
- `checkout: "existing"` for a branch that exists only on the remote, with `git.fetch` off: the fetch is skipped as configured, the remote ref is still looked up, and the message names the remote when neither ref exists (Task 2 test `existing: remote-only branch is tracked`).
- A repo hint that matches two projects with the same basename in different groups: the list with the banner, never the first match (Task 1 test `resolveLaunchProject: two matches are candidates`).
- Esc from the prefilled launch screen with `backTo` set: the picker closes and the named mod is reopened as a dialog with its props, and without `backTo` Esc goes back to the list as today (Task 4 test `Esc with backTo reopens the other mod`).
- The worktree path for an existing branch already exists and is that branch's worktree: it is reused, setup treats it as not new, and when a local space already shows that folder it is selected instead of a second space (Task 2 test `existing: a worktree already on that branch is reused`, Task 3 test `a reused worktree with an open space selects it`).

---

### Task 1: Parse and resolve a launch request (`lib.js`)

**Files:**
- Modify: `mods/projects/lib.js` (append after `resolveFolder`, line ~234)
- Test: `test/lib.test.mjs`

**Interfaces:**
- Produces:
  - `parseLaunch(raw) → { ok: true, launch: { v: 1, branch: string, checkout: "new"|"existing", prompt: string|null, source: { kind, id, url, title }|null, repo: { names: string[], urls: string[], folder: string|null } } } | { ok: false, error: string }`
  - `resolveLaunchProject(projects, launch, home) → { project } | { candidates: project[] }` where `candidates` may be empty.
  - `launchBanner(launch) → string`: `Starting ${source.id ?? branch} on ${branch}: pick a project` (uses `branch` alone when `source` is null: `Starting ${branch}: pick a project`).

- [ ] **Step 1: Write the failing tests**

```js
// test/lib.test.mjs (append)
test("parseLaunch fills defaults and keeps hints", () => {
  const r = parseLaunch({ v: 1, branch: "me/sc-1/x", prompt: "hi", source: { kind: "shortcut", id: "sc-1" }, repo: { names: ["api"] } });
  assert.deepEqual(r, { ok: true, launch: { v: 1, branch: "me/sc-1/x", checkout: "new", prompt: "hi", source: { kind: "shortcut", id: "sc-1", url: null, title: null }, repo: { names: ["api"], urls: [], folder: null } } });
});
test("parseLaunch rejects a missing branch", () => {
  assert.deepEqual(parseLaunch({ v: 1 }), { ok: false, error: "Launch request has no branch" });
  assert.deepEqual(parseLaunch({ v: 1, branch: "  " }), { ok: false, error: "Launch request has no branch" });
});
test("parseLaunch refuses an unknown version and a bad checkout", () => {
  assert.deepEqual(parseLaunch({ v: 2, branch: "b" }), { ok: false, error: "Unknown launch request version 2" });
  assert.deepEqual(parseLaunch({ v: 1, branch: "b", checkout: "sideways" }), { ok: false, error: 'Unknown checkout "sideways"' });
});
test("resolveLaunchProject: folder inside the worktree root, then names and url basenames, case-insensitively", () => {
  const home = "/h";
  const api = normalize({ name: "API", path: "/h/src/vizion-api", worktree: { root: "/h/wt/{repo}/{branch}" } });
  const web = normalize({ name: "Web", path: "/h/src/web" });
  const L = (repo) => parseLaunch({ v: 1, branch: "b", repo }).launch;
  assert.deepEqual(resolveLaunchProject([api, web], L({ folder: "/h/wt/vizion-api/b" }), home), { project: api });
  assert.deepEqual(resolveLaunchProject([api, web], L({ names: ["api"] }), home), { project: api });
  assert.deepEqual(resolveLaunchProject([api, web], L({ urls: ["https://github.com/org/VIZION-API"] }), home), { project: api });
  assert.deepEqual(resolveLaunchProject([api, web], L({}), home), { candidates: [] });
});
test("resolveLaunchProject: two matches are candidates", () => {
  const a = normalize({ name: "api", path: "/h/a/api", group: "x" }), b = normalize({ name: "api", path: "/h/b/api", group: "y" });
  assert.deepEqual(resolveLaunchProject([a, b], parseLaunch({ v: 1, branch: "b", repo: { names: ["api"] } }).launch, "/h"), { candidates: [a, b] });
});
test("launchBanner names the source when there is one", () => {
  assert.equal(launchBanner(parseLaunch({ v: 1, branch: "me/x", source: { kind: "shortcut", id: "sc-9" } }).launch), "Starting sc-9 on me/x: pick a project");
  assert.equal(launchBanner(parseLaunch({ v: 1, branch: "me/x" }).launch), "Starting me/x: pick a project");
});
```

- [ ] **Step 2: Run to verify they fail**

Run: `node --test test/lib.test.mjs`
Expected: FAIL, `parseLaunch is not a function` (and the other two names).

- [ ] **Step 3: Implement the three functions in `mods/projects/lib.js`**

Folder matching: `expandHome` both the project path and the worktree root prefix (the root template up to the first `{`), compare with `realPath`-free string prefix (`folder === path || folder.startsWith(prefix)`); use `basename` for url and path basenames, strip a trailing `.git` from urls.

- [ ] **Step 4: Run to verify they pass**

Run: `node --test test/lib.test.mjs`
Expected: PASS

- [ ] **Step 5: Commit**

```bash
git add mods/projects/lib.js test/lib.test.mjs
git commit -m "Parse and resolve a launch-by-props request"
```

---

### Task 2: `createWorktree` existing mode (`git.js`)

**Files:**
- Modify: `mods/projects/git.js:91-120` (`createWorktree`)
- Test: `test/git.test.mjs`

**Interfaces:**
- Consumes: `makeRepo`, `makeClone`, `commit`, `sh` from `test/helpers/repo.mjs`.
- Produces: `createWorktree(project, slugText, log, { existing = false } = {}) → { folder, branch, vars, reused: boolean }`. In existing mode `branch = slugText.trim()` verbatim; `reused` is true when the path already was that branch's worktree.

- [ ] **Step 1: Write the failing tests**

```js
// test/git.test.mjs (append, in the createWorktree section)
test("existing: a local branch is checked out, no suffixing", async () => {
  const dir = realpathSync(makeRepo()); sh(dir, "branch", "feat/one");
  const p = project(dir);
  const wt = await G.createWorktree(p, "feat/one", note, { existing: true });
  assert.equal(wt.branch, "feat/one"); assert.equal(wt.reused, false);
  assert.equal(sh(wt.folder, "rev-parse", "--abbrev-ref", "HEAD"), "feat/one");
});
test("existing: remote-only branch is tracked", async () => {
  const origin = makeRepo(); sh(origin, "branch", "feat/remote");
  const dir = realpathSync(makeClone(origin));
  const wt = await G.createWorktree(project(dir, { git: { fetch: true, remote: "origin" } }), "feat/remote", note, { existing: true });
  assert.equal(sh(wt.folder, "rev-parse", "--abbrev-ref", "feat/remote@{upstream}"), "origin/feat/remote");
  const off = project(realpathSync(makeClone(origin)), { git: { fetch: false } });
  await assert.rejects(G.createWorktree(off, "feat/none", note, { existing: true }), /branch "feat\/none" not found locally or on origin/);
});
test("existing: a worktree already on that branch is reused", async () => {
  const dir = realpathSync(makeRepo()); sh(dir, "branch", "feat/two");
  const p = project(dir);
  const first = await G.createWorktree(p, "feat/two", note, { existing: true });
  const again = await G.createWorktree(p, "feat/two", note, { existing: true });
  assert.deepEqual([again.folder, again.reused], [first.folder, true]);
});
test("existing: a taken path on another branch fails rather than suffixing", async () => {
  const dir = realpathSync(makeRepo()); sh(dir, "branch", "a"); sh(dir, "branch", "b");
  const p = project(dir, { worktree: { root: `${scratch("pp-wt")}/same` } });
  await G.createWorktree(p, "a", note, { existing: true });
  await assert.rejects(G.createWorktree(p, "b", note, { existing: true }), /already holds a worktree on a/);
});
```

- [ ] **Step 2: Run to verify they fail**

Run: `node --test test/git.test.mjs`
Expected: FAIL (branch suffixing / `-b` on an existing branch errors).

- [ ] **Step 3: Implement the option in `createWorktree`**

Existing mode after `fetchRemote`: compute `path` from `w.root` with `branch`; if `path` exists, read `git worktree list --porcelain` (reuse `parseWorktrees`) and return `{ folder: path, branch, vars, reused: true }` when that path is on `refs/heads/<branch>`, else throw `"${path} already holds a worktree on ${otherBranch}"`; else if `rev-parse --verify --quiet refs/heads/<branch>` → `git worktree add <path> <branch>`; else if `refs/remotes/<remote>/<branch>` → `git worktree add --track -b <branch> <path> <remote>/<branch>`; else throw `branch "${branch}" not found locally or on ${g.remote}`. `log` lines as the new branch path does. The new-branch path is unchanged and returns `reused: false`.

- [ ] **Step 4: Run to verify they pass**

Run: `node --test test/git.test.mjs`
Expected: PASS

- [ ] **Step 5: Commit**

```bash
git add mods/projects/git.js test/git.test.mjs
git commit -m "createWorktree: check out an existing local or remote branch"
```

---

### Task 3: Launch screen prefill and the existing checkout through `start` (`main.js`)

**Files:**
- Modify: `mods/projects/main.js` (`init` ~94-150, `activate` 476, `openLaunch` 488, `launchNow` 522, `start` 552, `prepareLaunch` 595, `renderLaunch` 1530, `renderList` 1435)
- Modify: `test/helpers/herdr-stub.mjs` (add `openOverlay` recording into `state.overlays`)
- Test: `test/ui.test.mjs`

**Interfaces:**
- Consumes: `parseLaunch`, `resolveLaunchProject`, `launchBanner` (Task 1); `createWorktree(..., { existing })` (Task 2).
- Produces on the picker: `this.pending` (the parsed launch or null), `this.banner` (string or null, drawn above the toolbar in `renderList` in `t.accent`, errors stay in `this.error`), `this.launch.existing` (boolean), `openLaunch(p, { mainOnly, prefill: { branch, prompt, existing } })`, `start(p, { ..., existing })`, `prepareLaunch(p, { worktree, branchText, existing }, log)`.

- [ ] **Step 1: Write the failing tests**

```js
// test/ui.test.mjs (append). `open()` takes an extra `props` argument: change its signature to open(projects, layouts, opts, props = {}) and pass props to v.init via the stub's props() (set state.props = props before init).
test("launch props: one matching project opens the launch screen prefilled", async () => {
  const dir = makeRepo();
  const { v } = await open([proj("Api", dir)], null, { detail: false }, { launch: { v: 1, branch: "me/sc-1/x", prompt: "Read sc-1", source: { kind: "shortcut", id: "sc-1" }, repo: { names: ["api"] } } });
  assert.equal(v.mode, "launch");
  assert.equal(v.nameInput.value(), "me/sc-1/x");
  assert.equal(v.promptBox.value(), "Read sc-1");
  assert.equal(v.launch.existing, false);
  assert.match(texts(v), /branch: me\/sc-1\/x/);
});
test("launch props: no match shows the list with the banner, and picking a project prefills", async () => {
  const dir = makeRepo();
  const { v } = await open([proj("Api", dir), proj("Web", makeRepo())], null, { detail: false }, { launch: { v: 1, branch: "me/x", checkout: "existing" } });
  assert.equal(v.mode, "list");
  assert.match(texts(v), /Starting me\/x: pick a project/);
  v.at = 1; enter(v);
  assert.equal(v.mode, "launch"); assert.equal(v.target.name, "Web");
  assert.equal(v.launch.existing, true);
  assert.match(texts(v), /checks out the existing branch me\/x/);
});
test("launch props: an unknown version is refused with a banner in red", async () => {
  const { v } = await open([proj("Api", makeRepo())], null, { detail: false }, { launch: { v: 7, branch: "b" } });
  assert.equal(v.mode, "list");
  assert.equal(v.error, "Unknown launch request version 7");
});
test("a reused worktree with an open space selects it", async () => {
  const dir = realpathSync(makeRepo()); sh(dir, "branch", "feat/x");
  const p = proj("Api", dir, { worktree: { root: `${scratch("pp-wt")}/{branch}` } });
  const { v, cx } = await open([p], null, { detail: false }, { launch: { v: 1, branch: "feat/x", checkout: "existing" } });
  v.launchNow(); await cx.settle();
  const folder = state.runs.find((r) => r[0] === "space.new")[1].folder;
  state.spaces.push({ id: "s9", folder, machine: null, tabs: [] }); state.runs.length = 0;
  const again = await open([p], null, { detail: false }, { launch: { v: 1, branch: "feat/x", checkout: "existing" } });
  again.v.launchNow(); await again.cx.settle();
  assert.deepEqual(again.v.error, null);
  assert.deepEqual(state.runs.map((r) => r[0]), ["space.select"]);
});
```

- [ ] **Step 2: Run to verify they fail**

Run: `node --test test/ui.test.mjs`
Expected: FAIL (mode stays `list`, no banner).

- [ ] **Step 3: Implement in `main.js`**

In `init` (picker role): `const raw = props()?.launch; if (raw) { const r = parseLaunch(raw); if (r.ok) this.pending = r.launch; else this.error = r.error; }` and `this.backTo = props()?.backTo ?? null`. In `reload`'s success path, when `this.pending` and the list is loaded: `const r = resolveLaunchProject(this.projects, this.pending, homeOf())`; one project → `this.openLaunch(r.project, { prefill })` and clear `pending`; otherwise `this.banner = launchBanner(this.pending)`. In `activate` (Enter on a row) when `this.pending`: open with the same prefill and clear `pending` and `banner`. `openLaunch` with `prefill`: `nameInput.set_value(branch)` (worktree forced on), `promptBox.set_value(prompt)` when `prompt != null`, `this.launch.existing = existing`, then `refreshPreview`. `renderLaunch`: when `this.launch.existing` the branch row's note reads `checks out the existing branch ${branch} (local or ${remote}/…) · Enter launches` instead of the "from …/base after a fetch" note. `launchNow` passes `existing: this.launch.existing`; `start` and `prepareLaunch` forward it to `createWorktree`. In `start`, after `prepareLaunch`, when the worktree was reused (`prepareLaunch` returns `reused`) and `spaces().find((s) => !s.machine && s.folder === folder)` exists: `this.dismiss(); return run("space.select", { id })`. Stub: `export const openOverlay = (spec) => { state.overlays.push(spec); }` and `state.props` served by `props()`.

- [ ] **Step 4: Run to verify they pass**

Run: `node --test test/*.test.mjs && herdr-app check mods/projects`
Expected: all PASS; check prints no error.

- [ ] **Step 5: Commit**

```bash
git add mods/projects/main.js test/ui.test.mjs test/helpers/herdr-stub.mjs
git commit -m "Open the launch screen prefilled from a launch prop"
```

---

### Task 4: `backTo` on Esc, docs, install

**Files:**
- Modify: `mods/projects/main.js` (`keys` 1170-1181, imports line 8: add `openOverlay`)
- Modify: `README.md` (new section "Launch from another mod" after "Auto-layout"), `RECIPE.md` (no new steps unless the install copies change)
- Test: `test/ui.test.mjs`

**Interfaces:**
- Consumes: `this.backTo` (Task 3).

- [ ] **Step 1: Write the failing test**

```js
test("Esc with backTo reopens the other mod", async () => {
  const { v, cx } = await open([proj("Api", makeRepo())], null, { detail: false }, { launch: { v: 1, branch: "b", repo: { names: ["api"] } }, backTo: { mod: "shortcut", props: { screen: "story", id: 1 } } });
  press(v, cx, "escape");
  assert.equal(state.closed, 1);
  assert.deepEqual(state.overlays, [{ mod: "shortcut", kind: "dialog", width: 0.8, height: 0.8, props: { screen: "story", id: 1 } }]);
});
test("Esc without backTo goes back to the list as before", async () => {
  const { v, cx } = await open([proj("Api", makeRepo())], null, { detail: false }, { launch: { v: 1, branch: "b", repo: { names: ["api"] } } });
  press(v, cx, "escape");
  assert.equal(v.mode, "list"); assert.equal(state.closed, 0);
});
```

- [ ] **Step 2: Run to verify it fails**

Run: `node --test test/ui.test.mjs`
Expected: FAIL (`state.overlays` empty).

- [ ] **Step 3: Implement**

In `keys`, the `escape || back` branch: when `this.mode === "launch" && this.backTo` → `this.dismiss(); openOverlay({ mod: this.backTo.mod, kind: "dialog", width: 0.8, height: 0.8, props: this.backTo.props ?? {} }); return;`. README section: the props shape from spec section 7 (copy the `launch` object), what the picker does with it (one match / banner / unknown version), `checkout: "existing"`, and that `launch.name` is ignored.

- [ ] **Step 4: Run everything**

Run: `node --test test/*.test.mjs && herdr-app check mods/projects`
Expected: PASS, no check errors.

- [ ] **Step 5: Install and verify in the app**

Run the install step from `RECIPE.md` (copy `mods/projects` into `~/.config/herdr-app/mods/projects`), then from a shell:

```bash
herdr-app do mod.open '{"name":"projects"}'
```

and in a second check, open it with props via the demo file path RECIPE describes, or temporarily a `herdr-app do` of `openOverlay` if the app exposes one; otherwise a one-line throwaway mod `mods/zz-spike/main.js` that calls `openOverlay({ mod: "projects", kind: "dialog", props: { launch: { v: 1, branch: "me/test", prompt: "hi", repo: { names: ["<a project name>"] } } } })` in `init` and is removed afterwards. Expected: the launch screen appears prefilled. `herdr-app shot` for the record. Add a line to `~/.config/herdr-app/CUSTOMIZATIONS.md` under the projects mod entry: "launch-by-props entry added (2026-11-04)".

- [ ] **Step 6: Commit**

```bash
git add mods/projects/main.js test/ui.test.mjs README.md
git commit -m "Return to the opening mod on Esc; document launch-by-props"
```
