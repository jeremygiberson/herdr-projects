// Everything that touches git or starts a space. `log(msg)` reports progress to the picker.
import { exec as rawExec, hc, run, focused, spaces, home } from "herdr";
import { log } from "./log.js";
import { splitArgs, slug, branchName, expandHome, expand, basename, dateStamp, timeStamp, parseWorktrees, layoutPlan, inFolder } from "./lib.js";

/** exec, logged in debug mode: command, folder, exit code and the first line of stderr. */
async function exec(command, args = [], options = {}) {
  try {
    const r = await rawExec(command, args, options);
    log("debug", `exec ${command} ${args.join(" ")}`, { cwd: options.cwd, code: r.code, err: r.stderr.split("\n")[0] });
    return r;
  } catch (e) {
    log("error", `exec ${command} ${args.join(" ")} could not run: ${e.message}`, { cwd: options.cwd });
    throw e;
  }
}
const git = (cwd, args) => exec("git", args, { cwd });
const out = (r) => r.stdout.trim();

// herdr's home() crosses into the app on every call, and the picker asks for a folder per project per render.
let homeDir;
const homeOf = () => (homeDir ??= home());

export const projectFolder = (p) => expandHome(p.path, homeOf());

/** Checks the folder is a git checkout. Returns { top, branch }. Throws with the reason. */
export async function inspect(folder) {
  let r;
  try {
    r = await git(folder, ["rev-parse", "--show-toplevel", "--abbrev-ref", "HEAD"]);
  } catch {
    throw new Error(`Can't open ${folder}`);
  }
  if (r.code !== 0) throw new Error(`${folder} is not a git checkout`);
  const [top, branch] = out(r).split("\n");
  return { top, branch };
}

/** {user} is git config user.name, falling back to user.email's local part. */
export async function gitUser(folder) {
  for (const [key, pick] of [["user.name", (s) => s], ["user.email", (s) => s.split("@")[0]]]) {
    const r = await git(folder, ["config", key]);
    if (r.code === 0 && out(r)) return slug(pick(out(r)));
  }
  return "user";
}

export async function templateVars(project, slugText) {
  const folder = projectFolder(project);
  const { top } = await inspect(folder);
  return {
    user: await gitUser(folder),
    date: dateStamp(),
    slug: slug(slugText) || timeStamp(),
    repo: basename(top),
    project: slug(project.name),
    name: project.name,
  };
}

/** What the branch will be called, before collisions are resolved. */
export async function previewBranch(project, slugText) {
  return branchName(project.worktree.branchTemplate, await templateVars(project, slugText));
}

/** git fetch, tolerating failure (offline): the local ref is used instead. */
async function fetchRemote(folder, g, log) {
  if (!g.fetch) return;
  log(`git fetch ${g.remote}…`);
  try {
    const r = await git(folder, ["fetch", g.remote]);
    if (r.code !== 0) log(`fetch failed, using local refs: ${out({ stdout: r.stderr }).split("\n")[0]}`);
  } catch {
    log("fetch timed out, using local refs");
  }
}

export async function baseRef(folder, g) {
  for (const ref of [`${g.remote}/${g.base}`, g.base]) {
    if ((await git(folder, ["rev-parse", "--verify", "--quiet", `${ref}^{commit}`])).code === 0) return ref;
  }
  throw new Error(`No base branch ${g.remote}/${g.base} or ${g.base} in this checkout`);
}

const exists = async (path) => (await exec("test", ["-e", path])).code === 0;

/** Whether a folder exists on this machine (the picker uses it to flag imported projects whose folder is missing). */
export const folderExists = async (path) => { try { return (await exec("test", ["-d", path])).code === 0; } catch { return false; } };

/** Creates the worktree. Returns { folder, branch }. Appends -2, -3… when the branch or path is taken. */
export async function createWorktree(project, slugText, log) {
  const folder = projectFolder(project);
  const { worktree: w, git: g } = project;
  await inspect(folder);
  await fetchRemote(folder, g, log);
  const base = await baseRef(folder, g);
  const vars = await templateVars(project, slugText);
  const wanted = branchName(w.branchTemplate, vars);
  if (!wanted) throw new Error("The branch name template produced an empty name");
  if ((await git(folder, ["check-ref-format", "--branch", wanted])).code !== 0) throw new Error(`"${wanted}" is not a valid branch name`);
  const isTaken = async (branch, path) => (await git(folder, ["rev-parse", "--verify", "--quiet", `refs/heads/${branch}`])).code === 0 || (await exists(path));
  // Another launch can take the name between the check and `worktree add`: when the add fails
  // and the name is now taken, move on to the next suffix instead of failing.
  for (let n = 1; n <= 21; n++) {
    const branch = n === 1 ? wanted : `${wanted}-${n}`;
    const path = expandHome(expand(w.root, { ...vars, branch }), home());
    if (await isTaken(branch, path)) continue;
    log(`git worktree add ${branch} from ${base}…`);
    const r = await git(folder, ["worktree", "add", "--no-track", "-b", branch, path, base]);
    if (r.code === 0) return { folder: path, branch, vars };
    if (await isTaken(branch, path)) continue;
    throw new Error(out({ stdout: r.stderr }) || "git worktree add failed");
  }
  throw new Error(`Branch ${wanted} and its -N variants are all taken`);
}

/** The main checkout, brought up to date when fast-forward is on and that's safe. */
export async function prepareMain(project, log) {
  const folder = projectFolder(project);
  const { branch } = await inspect(folder);
  const g = project.git;
  await fetchRemote(folder, g, log);
  if (!g.fastForward) return;
  if (branch !== g.base) return log(`not fast-forwarding: on ${branch}, not ${g.base}`);
  if (out(await git(folder, ["status", "--porcelain"]))) return log("not fast-forwarding: uncommitted changes");
  const r = await git(folder, ["merge", "--ff-only", `${g.remote}/${g.base}`]);
  log(r.code === 0 ? `fast-forwarded ${g.base}` : "not fast-forwarding: local commits");
}

/** Setup commands, one after another, stopping at the first failure. exec has a 30 s limit each. */
export async function runSetup(project, folder, log) {
  for (const cmd of project.startup.setup) {
    log(`$ ${cmd}`);
    try {
      const r = await exec("sh", ["-c", cmd], { cwd: folder });
      if (r.code !== 0) return log(`setup failed (${r.code}): ${cmd}`);
    } catch {
      return log(`setup stopped (timed out or couldn't start): ${cmd}`);
    }
  }
}

/** The folder with symlinks resolved, or itself when it can't be (gone, unreadable). */
async function realPath(p) {
  try {
    const r = await exec("sh", ["-c", 'cd "$1" 2>/dev/null && pwd -P', "sh", p]);
    return r.code === 0 && out(r) ? out(r) : p;
  } catch { return p; }
}

export const findSpace = (project) => spaces().find((s) => !s.machine && s.folder === projectFolder(project));

/** Opens the folder as a space, with the project's agent, first prompt and extra tabs. */
/** The sidebar name for a worktree's space, from the project's template; falls back to "<name> · <branch>". */
export function worktreeSpaceName(project, wt) {
  const name = expand(project.worktree.spaceName, { ...wt.vars, branch: wt.branch }).trim();
  return name || `${project.name} · ${wt.branch}`;
}

// Launches take turns creating their space: the new terminal is found as "new since a snapshot",
// which two overlapping launches into one folder would otherwise mix up.
let spaceLock = Promise.resolve();
// A turn that hangs (hc not answering) gives up its place after this long so later launches still run.
export const lockSettings = { seconds: 25 };
const exclusive = (fn) => {
  const result = spaceLock.then(fn);
  const done = result.then(() => {}, () => {});
  spaceLock = Promise.race([done, sleep(lockSettings.seconds).then(() => {}, () => {})]);
  return result;
};

/** The space space.new just made: not in `before`, with this name (and folder, when several), and its first pane. */
async function findNewSpace(before, name, folder) {
  for (let i = 0; i < 20; i++) {
    try {
      const r = await exec("herdr-app", ["ls"]);
      const fresh = (JSON.parse(r.stdout || "{}").spaces ?? []).filter((s) => !before.has(s.id) && s.name === name);
      const found = fresh.filter((s) => s.folder === folder).pop() ?? fresh.pop();
      const pane = found?.tabs?.[0]?.terminals?.[0]?.pane;
      if (found && pane) return { space: found.id, pane };
    } catch {}
    await sleep(0.25);
  }
  return null;
}

/** Splits the new space's first pane into the layout's panes. A failed split is logged and ends the layout;
 *  the space and its agent are already open. Focus goes back to the agent. */
async function buildLayout(layout, folder, root) {
  const plan = layoutPlan(layout);
  const ids = { [layout.panes[0]?.name ?? "agent"]: root };
  for (const pane of plan) {
    const argv = pane.type === "command" ? ["sh", "-c", pane.command] : [];
    const r = await exec("herdr-app", ["do", "pane.split", JSON.stringify({ direction: pane.direction, pane: ids[pane.from], argv: inFolder(folder, argv) })]);
    let made = {};
    try { made = JSON.parse(r.stdout || "{}"); } catch {}
    if (r.code !== 0 || made.error || !made.pane) {
      log("error", `layout "${layout.name}": couldn't split for ${pane.name}`, { code: r.code, error: made.error ?? r.stderr.split("\n")[0] });
      break;
    }
    ids[pane.name] = made.pane;
  }
  run("pane.focus", { pane: root });
}

export async function launch(project, folder, name, layout = null) {
  const { agent, args, prompt, promptMode, tabs } = project.startup;
  const argv = agent.trim() ? [...splitArgs(agent), ...splitArgs(args)] : [];
  // "arg": herdr appends the prompt to the command line (claude and most agents take that).
  // "send": start the agent bare and type the prompt once it is ready (hermes and others
  // that read a positional argument as a subcommand).
  const send = argv.length && prompt && promptMode === "send";
  const terminal = await exclusive(async () => {
    const spacesBefore = new Set(spaces().map((s) => s.id));
    const known = send ? new Set((await liveTerminals()).map((t) => t.address)) : null;
    // Herdr nests a worktree's space under its repo's own space, but only while that one is open.
    const main = projectFolder(project);
    if (project.worktree.repoSpace && folder !== main && !findSpace(project)) {
      log("debug", "opening the repo's space first", { main });
      run("space.new", { name: project.name, folder: main });
    }
    log("debug", "launch", { folder, name, argv, promptMode, tabs });
    run("space.new", { name, folder, ...(argv.length ? { argv, ...(prompt && !send ? { task: prompt } : {}) } : {}) });
    // focused() can still be the window the picker was opened from just after space.new, so the new
    // space and its first pane come from `herdr-app ls`: the space that wasn't there before.
    const here = layout || tabs.length ? await findNewSpace(spacesBefore, name, folder) : null;
    const space = here?.space ?? focused()?.space;
    // Found before the layout's split panes exist, which also start in this folder.
    const terminal = send ? await findNewTerminal(known, folder) : null;
    if (layout) {
      if (!here) log("error", `layout "${layout.name}" skipped: couldn't find the new space`, { name });
      else try { await buildLayout(layout, folder, here.pane); } catch (e) { log("error", `layout "${layout.name}": ${e.message}`); }
    }
    for (const cmd of tabs) run("tab.new", { space, name: cmd.split(/\s+/)[0], folder, argv: ["sh", "-c", cmd] });
    return terminal;
  });
  if (send) await sendWhenReady(terminal, folder, prompt);
}

const sleep = (s) => rawExec("sleep", [String(s)]);

async function liveTerminals() {
  const r = await hc(["ls", "--json"]);
  return (JSON.parse(r.stdout).terminals ?? []).filter((t) => t.state === "live");
}

/** The terminal space.new just made: new since `known`, starting in `folder`. */
async function findNewTerminal(known, folder) {
  for (let i = 0; i < 20; i++) {
    const t = (await liveTerminals()).find((x) => !known.has(x.address) && x.cwd === folder);
    if (t) return t.address;
    await sleep(0.5);
  }
  return null;
}

const SHELLS = new Set(["bash", "sh", "zsh", "fish", "dash"]);

/** Types `text` into the new space's terminal once its agent is ready. An agent herdr reports a
 *  status for must be idle (or done); one it doesn't know (hermes) is ready once it has been the
 *  foreground program for 6 s. A blocked one (a trust dialog, say) is left alone. */
async function sendWhenReady(terminal, folder, text) {
  if (!terminal) return log("error", "prompt not sent: couldn't find the new terminal", { folder });
  const started = Date.now();
  for (;;) {
    const t = (await liveTerminals()).find((x) => x.address === terminal);
    if (!t) return log("error", "prompt not sent: the terminal ended", { terminal });
    const waited = Date.now() - started;
    let fg = null;
    if (!t.status) {
      try { fg = JSON.parse((await hc(["get", terminal, "--json"])).stdout).foreground?.name ?? null; } catch {}
    }
    log("debug", "waiting to send prompt", { terminal, status: t.status ?? null, agent: t.agent, foreground: fg, waited });
    if (t.status === "blocked") return log("error", "prompt not sent: the agent is waiting on you", { terminal });
    if (t.status === "idle" || t.status === "done") break;
    if (!t.status && fg && !SHELLS.has(fg) && waited > 6000) break;
    if (waited > 30000) return log("error", "prompt not sent: the agent never became ready", { terminal, foreground: fg });
    await sleep(0.5);
  }
  const r = await hc(["send", terminal, text]);
  log("debug", "sent prompt", { terminal, code: r.code });
  if (r.code !== 0) log("error", `hc send failed: ${r.stderr.split("\n")[0]}`, { terminal });
}

/** A project's branch, number of changed files and number of linked worktrees, for the picker; null when the folder
 *  isn't a readable checkout. Three quick git calls. */
export async function gitSummary(folder) {
  try {
    const st = await git(folder, ["status", "--porcelain", "-b"]);
    if (st.code !== 0) return null;
    const [head, ...changed] = st.stdout.split("\n").filter(Boolean);
    // "## main...origin/main [ahead 1]", "## HEAD (no branch)", "## No commits yet on main"
    const branch = (head ?? "").replace(/^## (No commits yet on |Initial commit on )?/, "").split("...")[0].replace(/ \[.*\]$/, "");
    let list = await git(folder, ["worktree", "list", "--porcelain", "-z"]);
    if (list.code !== 0) list = await git(folder, ["worktree", "list", "--porcelain"]);
    return { branch, dirty: changed.length, worktrees: list.code === 0 ? Math.max(0, parseWorktrees(list.stdout).length - 1) : 0 };
  } catch { return null; }
}

/** The repo's linked worktrees (not the main checkout): { path, branch, dirty, merged, space }.
 *  merged: the branch is already in <remote>/<base>, so removing it loses nothing. */
export async function listWorktrees(project) {
  const folder = projectFolder(project);
  // -z (git 2.36+) keeps odd folder names intact; older gits fall back to plain porcelain.
  let r = await git(folder, ["worktree", "list", "--porcelain", "-z"]);
  if (r.code !== 0) r = await git(folder, ["worktree", "list", "--porcelain"]);
  if (r.code !== 0) throw new Error(out({ stdout: r.stderr }) || "git worktree list failed");
  const found = parseWorktrees(r.stdout).slice(1);
  let base = null;
  try { base = await baseRef(folder, project.git); } catch {}
  const open = spaces().filter((s) => !s.machine);
  // git reports real paths; a space opened through a symlink (macOS /var, a linked home) has the other spelling.
  const real = new Map();
  const realOf = async (p) => real.get(p) ?? real.set(p, await realPath(p)).get(p);
  const spaceAt = async (path) => {
    const exact = open.find((s) => s.folder === path);
    if (exact) return exact;
    for (const s of open) if ((await realOf(s.folder)) === path) return s;
    return null;
  };
  const list = [];
  for (const { path, branch, locked, prunable } of found) {
    if (!path || prunable) continue;
    const dirty = out(await git(path, ["status", "--porcelain"])) !== "";
    const merged = Boolean(base && branch && (await git(folder, ["merge-base", "--is-ancestor", branch, base])).code === 0);
    list.push({ path, branch, dirty, merged, locked, space: await spaceAt(path) });
  }
  return list;
}

/** Removes one worktree (git refuses when it has uncommitted changes), its branch when merged,
 *  and closes the space showing it. */
export async function removeWorktree(project, wt) {
  const folder = projectFolder(project);
  const r = await git(folder, ["worktree", "remove", wt.path]);
  if (r.code !== 0) throw new Error(`${wt.branch ?? wt.path}: ${out({ stdout: r.stderr }).split("\n")[0]}`);
  if (wt.branch && wt.merged) await git(folder, ["branch", "-d", wt.branch]);
  if (wt.space) run("space.close", { id: wt.space.id });
}
