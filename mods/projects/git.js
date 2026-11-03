// Everything that touches git. `log(msg)` reports progress to the picker.
import { exec as rawExec, run, spaces, home } from "herdr";
import { log } from "./log.js";
import { slug, branchName, expandHome, expand, basename, dateStamp, timeStamp, parseWorktrees, spaceShows } from "./lib.js";

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
  const vars = await templateVars(project, slugText);
  return slugText.includes("/") ? slugText.trim() : branchName(project.worktree.branchTemplate, vars);
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
  // Text with a slash is the branch name itself; otherwise it feeds the template.
  const wanted = slugText.includes("/") ? slugText.trim() : branchName(w.branchTemplate, vars);
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

/** The folder with symlinks resolved, or itself when it can't be (gone, unreadable). */
export async function realPath(p) {
  try {
    const r = await exec("sh", ["-c", 'cd "$1" 2>/dev/null && pwd -P', "sh", p]);
    return r.code === 0 && out(r) ? out(r) : p;
  } catch { return p; }
}

/** A key shared by a checkout and its linked worktrees: the real path of the common git dir; null outside a repo. */
export async function repoKey(folder) {
  try {
    const r = await git(folder, ["rev-parse", "--git-common-dir"]);
    if (r.code !== 0 || !out(r)) return null;
    const dir = out(r);
    return await realPath(dir.startsWith("/") ? dir : `${folder}/${dir}`);
  } catch { return null; }
}

/** The branch checked out in a folder ("HEAD" when detached); null outside a repo. */
export async function branchOf(folder) {
  try {
    const r = await git(folder, ["rev-parse", "--abbrev-ref", "HEAD"]);
    return r.code === 0 && out(r) ? out(r) : null;
  } catch { return null; }
}

/** The open space showing the project: one in its folder, else one below it (a first tab with a folder opens there). */
export function findSpace(project) {
  const folder = projectFolder(project);
  const local = spaces().filter((s) => !s.machine);
  return local.find((s) => s.folder === folder) ?? local.find((s) => spaceShows(s.folder, folder));
}

/** The sidebar name for a worktree's space, from the project's template; falls back to "<name> · <branch>". */
export function worktreeSpaceName(project, wt) {
  const name = expand(project.worktree.spaceName, { ...wt.vars, branch: wt.branch }).trim();
  return name || `${project.name} · ${wt.branch}`;
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
