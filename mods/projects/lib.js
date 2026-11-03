// Pure helpers: no herdr imports, so they can be tested with plain node.

/** Subsequence match: -1 for no match, else a score (higher is better). */
export function fuzzy(query, text) {
  const q = query.toLowerCase();
  const s = text.toLowerCase();
  if (!q) return 0;
  let score = 0;
  let i = 0;
  let prev = -2;
  for (let j = 0; j < s.length && i < q.length; j++) {
    if (s[j] !== q[i]) continue;
    score += 1;
    if (j === prev + 1) score += 2;
    if (j === 0 || /[\s\-_/.]/.test(s[j - 1])) score += 3;
    prev = j;
    i++;
  }
  return i === q.length ? score - s.length * 0.01 : -1;
}

/** Which characters of `text` `fuzzy` matched, as indexes (same left-to-right pick); [] for no match or an empty query. */
export function fuzzyPositions(query, text) {
  const q = query.toLowerCase();
  const s = text.toLowerCase();
  const at = [];
  for (let j = 0; j < s.length && at.length < q.length; j++) if (s[j] === q[at.length]) at.push(j);
  return q && at.length === q.length ? at : [];
}

/** Splits `text` into [{ text, hit }] runs, hit where `at` marks a matched character. */
export function highlightRuns(text, at) {
  const hit = new Set(at);
  const runs = [];
  [...text].forEach((ch, i) => {
    const h = hit.has(i);
    if (runs.length && runs[runs.length - 1].hit === h) runs[runs.length - 1].text += ch;
    else runs.push({ text: ch, hit: h });
  });
  return runs;
}

/** The program an agent command runs, for matching it to an agent: "/usr/bin/claude --model x" is "claude". */
export const commandName = (text) => basename(splitArgs(text)[0] ?? "");

export function slug(text) {
  return String(text ?? "").toLowerCase().replace(/[^a-z0-9]+/g, "-").replace(/^-+|-+$/g, "");
}

/** Replaces {name} with vars[name]; unknown names become "". */
export function expand(template, vars) {
  return String(template ?? "").replace(/\{(\w+)\}/g, (_m, k) => vars[k] ?? "");
}

const pad = (n) => String(n).padStart(2, "0");
export const dateStamp = (d = new Date()) => `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())}`;
export const timeStamp = (d = new Date()) => `${pad(d.getHours())}${pad(d.getMinutes())}${pad(d.getSeconds())}`;

/** A branch name from a template: variables filled, stray slashes and spaces cleaned. */
export function branchName(template, vars) {
  return expand(template, vars)
    .replace(/\s+/g, "-")
    .replace(/\/{2,}/g, "/")
    .replace(/^[/.-]+|[/.]+$/g, "");
}

export const basename = (p) => String(p).replace(/[\\/]+$/, "").split(/[\\/]/).pop();

/** Whether a space in `spaceFolder` shows the project in `projectFolder`: the same folder or one below it
 *  (a project whose first tab opens in a subfolder). "/r/api2" does not show "/r/api". */
export function spaceShows(spaceFolder, projectFolder) {
  const f = String(projectFolder ?? "").replace(/\/+$/, "");
  const s = String(spaceFolder ?? "");
  return Boolean(f) && (s === f || s.startsWith(f + "/"));
}

/** "~/x" and "$HOME/x" to an absolute path. */
export function expandHome(p, home) {
  return String(p ?? "").replace(/^[\r\n]+|[\r\n]+$/g, "").replace(/^(~|\$HOME)(?=\/|$)/, home).replace(/[\\/]+$/, "");
}

/** `git worktree list --porcelain -z` (or without -z) to [{ path, branch, locked, prunable }], the
 *  main checkout first. With -z, records end in NUL and a blank field separates worktrees, so a
 *  path may hold anything; without it git prints a path with a newline raw and it can't be told apart. */
export function parseWorktrees(text) {
  const nul = text.includes("\0");
  const blocks = nul ? text.split("\0\0") : text.trim().split(/\n\n+/);
  return blocks.filter((b) => b.trim() !== "").map((b) => {
    const lines = nul ? b.split("\0") : b.split("\n");
    const get = (key) => lines.find((x) => x === key || x.startsWith(key + " "));
    const path = get("worktree")?.slice(9) ?? "";
    const branch = get("branch")?.match(/^branch refs\/heads\/(.+)$/)?.[1] ?? null;
    return { path, branch, locked: Boolean(get("locked")), prunable: Boolean(get("prunable")) };
  });
}

export function shortHome(p, home) {
  return p === home || p.startsWith(home + "/") ? "~" + p.slice(home.length) : p;
}

/** "a\nb" to ["a", "b"]: one entry per line, trimmed, blanks dropped. */
export const splitList = (text) => String(text ?? "").split(/\r?\n/).map((x) => x.trim()).filter(Boolean);
export const joinList = (list) => (list ?? []).join("\n");

/** Shell-style words: whitespace separated, with '…' and "…" keeping spaces together. */
export function splitArgs(text) {
  const out = [];
  const re = /"([^"]*)"|'([^']*)'|(\S+)/g;
  for (let m; (m = re.exec(String(text ?? "")));) out.push(m[1] ?? m[2] ?? m[3]);
  return out;
}

export function blankProject(path = "") {
  return {
    name: basename(path),
    path,
    group: "",
    description: "",
    pinned: false,
    worktree: {
      mode: "ask",
      branchTemplate: "{user}/{date}-{slug}",
      root: "~/.herdr/worktrees/{repo}/{branch}",
      spaceName: "{name} · {branch}",
      repoSpace: false,
      autoLayout: false,
      copy: [],
      setup: [],
    },
    git: { fetch: true, remote: "origin", base: "main", fastForward: false },
    startup: { setup: [], quickSetup: false, agentTiming: "after", tabs: [] },
    quickLaunch: false,
  };
}

// ---- tabs and panes ---------------------------------------------------------------------------
// Tab:  { name, folder, command, panes: Pane[] }   (command "" when there are panes; neither: a plain shell)
// Pane: { name, type: "agent"|"shell"|"command", command, agent, args, prompt, promptMode: "arg"|"send",
//         direction: "right"|"down"|"", from, folder }

/** A pane with every field defaulted, `over` applied. */
export const blankPane = (over = {}) => ({ name: "", type: "shell", command: "", agent: "", args: "", prompt: "", promptMode: "arg", direction: "", from: "", folder: "", ...over });

// A stored pane with its fields filled; a pane with a command and no type is a command pane.
const fillPane = (x) => blankPane({ ...x, type: x?.type ?? (String(x?.command ?? "").trim() ? "command" : "shell") });
// A tab with panes has no command (a hand-edited one may hold both).
const fillTab = (t) => {
  const panes = Array.isArray(t?.panes) ? t.panes.map(fillPane) : [];
  return { ...t, name: t?.name ?? "", folder: t?.folder ?? "", command: panes.length ? "" : t?.command ?? "", panes };
};

// A list of strings, trimmed, blanks dropped.
const cleanList = (x) => (Array.isArray(x) ? x : []).map((s) => String(s).trim()).filter(Boolean);

const LEGACY_STARTUP_KEYS = ["agent", "args", "prompt", "promptMode", "layout"];

/** The tabs of an old-style startup (one agent, a named layout, extra tab commands). */
function upgradeStartup(su, layouts) {
  const agent = String(su.agent ?? "");
  const first = agent.trim()
    ? blankPane({ type: "agent", name: "agent", agent, args: su.args ?? "", prompt: su.prompt ?? "", promptMode: su.promptMode ?? "arg" })
    : blankPane({ type: "shell", name: "agent" });
  const layout = su.layout ? allLayouts(layouts).find((l) => l.name === su.layout && Array.isArray(l.panes)) : null;
  const panes = layout ? [{ ...first, name: layout.panes[0]?.name ?? "agent" }, ...layout.panes.slice(1).map(fillPane)] : [first];
  const rest = (Array.isArray(su.tabs) ? su.tabs : [])
    .filter((t) => typeof t !== "string" || t.trim())
    .map((t) => (typeof t === "string" ? { name: commandName(t), command: t.trim(), panes: [] } : t));
  return [{ name: "agent", folder: "", command: "", panes }, ...rest].map(fillTab);
}

/** Fills anything missing from a hand-edited project, keeping what is there. An old-style `startup` becomes tabs.
 *  `layouts` are the file's own layouts, used only to expand an old `startup.layout`. */
export function normalize(p, layouts = []) {
  const b = blankProject(p?.path ?? "");
  const su = p?.startup && typeof p.startup === "object" && !Array.isArray(p.startup) ? p.startup : {};
  const legacy = LEGACY_STARTUP_KEYS.some((k) => k in su) || (Array.isArray(su.tabs) && su.tabs.some((t) => typeof t === "string"));
  const startup = { ...b.startup, ...su };
  for (const k of LEGACY_STARTUP_KEYS) delete startup[k];
  startup.tabs = legacy ? upgradeStartup(su, Array.isArray(layouts) ? layouts : []) : (Array.isArray(su.tabs) ? su.tabs : []).map(fillTab);
  if (!startup.tabs.length) startup.tabs = [fillTab({ name: "shell" })];
  startup.setup = cleanList(startup.setup);
  startup.quickSetup = Boolean(startup.quickSetup);
  const worktree = { ...b.worktree, ...(p?.worktree ?? {}) };
  worktree.autoLayout = Boolean(worktree.autoLayout);
  worktree.copy = cleanList(worktree.copy);
  worktree.setup = cleanList(worktree.setup);
  return {
    ...b,
    ...p,
    worktree,
    git: { ...b.git, ...(p?.git ?? {}) },
    startup,
    quickLaunch: Boolean(p?.quickLaunch),
  };
}

/** The first agent pane across the tabs: { tab, index, pane }, or null. */
export function firstAgent(tabs) {
  for (let i = 0; i < (tabs ?? []).length; i++) {
    const j = (tabs[i].panes ?? []).findIndex((x) => x.type === "agent");
    if (j >= 0) return { tab: i, index: j, pane: tabs[i].panes[j] };
  }
  return null;
}

/** Tab names for a bar: "server ×2" for a split tab. */
export const tabLabels = (tabs) => (tabs ?? []).map((t) => ((t.panes ?? []).length > 1 ? `${t.name} ×${t.panes.length}` : t.name));

/** `~`/`$HOME`, then `$VAR` and `${VAR}` from `env` (unknown: ""). */
export function expandPath(text, home, env = {}) {
  return expandHome(text, home).replace(/\$\{(\w+)\}|\$(\w+)/g, (_m, a, b) => env[a ?? b] ?? "");
}

/** A tab's or pane's folder as an absolute path: "" is `base`, absolute stays, else relative to `base` (`.` and `..` collapsed). */
export function resolveFolder(base, text, home, env = {}) {
  const e = expandPath(text, home, env);
  if (!e) return base;
  if (e.startsWith("/")) return e;
  const parts = [];
  for (const seg of `${base}/${e}`.split("/")) {
    if (seg === "" || seg === ".") continue;
    if (seg === "..") parts.pop();
    else parts.push(seg);
  }
  return "/" + parts.join("/");
}

/** The tabs to launch: the project's own for no layout (`pick` "" or null); a layout with `tabs` replaces them; a layout with
 *  only `panes` replaces the panes of the tab holding the project's first agent (tab 1 when it has none). An agent pane left
 *  empty by a layout takes the project's first agent, else is a shell (a tab's first such one keeps the name "agent", so a
 *  `from: "agent"` still finds it). */
export function tabsForLaunch(project, layouts, pick) {
  const own = project.startup.tabs;
  if (!pick) return own;
  const layout = allLayouts(layouts).find((l) => l.name === pick);
  if (!layout) throw new Error(`No layout called "${pick}"`);
  const lead = firstAgent(own);
  const at = lead?.tab ?? 0;
  const tabs = Array.isArray(layout.tabs)
    ? layout.tabs.map(fillTab)
    : own.map((t, i) => (i === at ? { ...t, command: "", panes: layout.panes.map(fillPane) } : t));
  const src = lead?.pane;
  return tabs.map((t) => ({
    ...t,
    panes: t.panes.map((x, i) => {
      if (x.type !== "agent" || x.agent.trim()) return x;
      if (src) return { ...x, agent: src.agent, args: src.args, prompt: src.prompt, promptMode: src.promptMode };
      const firstOfTab = t.panes.findIndex((y) => y.type === "agent") === i;
      return { ...x, type: "shell", name: x.name || (firstOfTab ? "agent" : "") };
    }),
  }));
}

/** The best auto-layout entry for a repo name and branch: repo+branch > repo > "*"+branch > "*"; repo compares
 *  case-insensitively; ties go to the earlier entry. null when none applies. */
export function matchAutoLayout(entries, repo, branch) {
  const r = String(repo ?? "").toLowerCase();
  let best = null;
  let bestScore = 0;
  for (const e of entries ?? []) {
    const er = String(e.repo ?? "*").toLowerCase();
    const eb = String(e.branch ?? "");
    if (er !== "*" && er !== r) continue;
    if (eb && eb !== branch) continue;
    const score = (er === "*" ? 0 : 2) + (eb ? 2 : 0) + (er === "*" && !eb ? 1 : 0) + (er !== "*" && !eb ? 1 : 0);
    if (score > bestScore) { best = e; bestScore = score; }
  }
  return best;
}

/** The tabs for a space opened outside the picker: a known project's own, else the entry's layout. An agent pane
 *  left empty takes `defaultAgent`, else is a shell. Throws `No layout called "<name>"`. */
export function tabsForAuto({ project, layouts, entry, defaultAgent }) {
  if (project) return tabsForLaunch(project, layouts, "");
  const layout = allLayouts(layouts).find((l) => l.name === entry?.layout);
  if (!layout) throw new Error(`No layout called "${entry?.layout}"`);
  const tabs = Array.isArray(layout.tabs)
    ? layout.tabs.map(fillTab)
    : [{ name: "agent", folder: "", command: "", panes: layout.panes.map(blankPane) }];
  return tabs.map((t) => ({
    ...t,
    panes: t.panes.map((x, i) => {
      if (x.type !== "agent" || x.agent.trim()) return x;
      if (defaultAgent?.agent) return { ...x, agent: defaultAgent.agent, args: defaultAgent.args ?? "" };
      const firstOfTab = t.panes.findIndex((y) => y.type === "agent") === i;
      return { ...x, type: "shell", name: x.name || (firstOfTab ? "agent" : "") };
    }),
  }));
}

/** Tabs validated and filled: every tab has panes (a command or nothing becomes one), every pane a name, and every
 *  later pane a direction and the pane it splits. Throws with the reason when something can't be built. */
export function tabPlan(tabs) {
  return (tabs ?? []).map((t, ti) => {
    const name = String(t?.name ?? "").trim();
    if (!name) throw new Error(`Tab ${ti + 1} needs a name`);
    const command = String(t.command ?? "").trim();
    const given = Array.isArray(t.panes) ? t.panes : [];
    if (command && given.length) throw new Error(`Tab "${name}": a tab has either a command or panes, not both`);
    const list = given.length ? given : [command ? { type: "command", command } : { type: "shell" }];
    const seen = [];
    // Only the tab's first agent pane defaults to "agent"; a later unnamed one is pane<N> like the rest.
    const firstAgentAt = list.findIndex((x) => x?.type === "agent");
    const panes = list.map((x, i) => {
      const type = x?.type ?? (String(x?.command ?? "").trim() ? "command" : "shell");
      const pname = String(x?.name ?? "").trim() || (type === "agent" && i === firstAgentAt ? "agent" : `pane${i + 1}`);
      if (seen.includes(pname)) throw new Error(`Tab "${name}": two panes are called "${pname}"`);
      if (!["agent", "shell", "command"].includes(type)) throw new Error(`Tab "${name}": pane "${pname}" has an unknown type "${x.type}"`);
      const cmd = type === "command" ? String(x.command ?? "").trim() : "";
      if (type === "command" && !cmd) throw new Error(`Tab "${name}": command pane "${pname}" has no command`);
      let direction = "";
      let from = "";
      if (i > 0) {
        direction = x?.direction || "down";
        if (!["right", "down"].includes(direction)) throw new Error(`Tab "${name}": pane "${pname}" needs direction "right" or "down"`);
        from = x?.from || seen[seen.length - 1];
        if (!seen.includes(from)) throw new Error(`Tab "${name}": pane "${pname}" splits "${from}", which does not come before it`);
      }
      seen.push(pname);
      return blankPane({ ...x, name: pname, type, command: cmd, direction, from });
    });
    return { ...t, name, folder: t.folder ?? "", command: t.command ?? "", panes };
  });
}

// ---- pane layouts -----------------------------------------------------------------------------
// A layout is the panes of the tab holding a project's agent: the first one runs the agent, each next one is
// split off an earlier pane. { name, label?, panes: [{ name?, type: "agent"|"shell"|"command",
// command?, direction: "right"|"down", from? }] }. `from` names the pane to split (default: the
// previous one). Sizes are not set: herdr splits evenly.

export const BUILTIN_LAYOUTS = [
  { name: "agent-terminal", label: "Agent + terminal below", panes: [{ type: "agent" }, { type: "shell", direction: "down" }] },
  { name: "agent-side-terminal", label: "Agent + terminal right", panes: [{ type: "agent" }, { type: "shell", direction: "right" }] },
];

/** The layouts to offer: built-ins, then the user's (a user layout replaces a built-in of the same name). */
export function allLayouts(user) {
  const mine = (user ?? []).filter((l) => l && typeof l.name === "string" && l.name.trim() && (Array.isArray(l.panes) || Array.isArray(l.tabs)));
  const names = new Set(mine.map((l) => l.name));
  return [...BUILTIN_LAYOUTS.filter((l) => !names.has(l.name)), ...mine];
}

/** The splits that build a layout, in order (pane objects: name, type, command, direction, from, ...). The first
 *  pane is the agent's and needs no split. Throws with the reason when a pane can't be placed. */
export const layoutPlan = (layout) => tabPlan([{ name: layout?.name ?? "layout", panes: layout?.panes ?? [] }])[0].panes.slice(1);

/** The layout after `current` when cycling through none ("") and then every layout; an unknown name goes to none. */
export function nextLayout(names, current) {
  const order = ["", ...names];
  const i = order.indexOf(current ?? "");
  return order[(i + 1) % order.length];
}

/** A command that starts in `folder` (a split doesn't take one); no argv: the person's shell. */
export const inFolder = (folder, argv = []) => [
  "sh", "-c", 'cd "$1" || exit; shift; [ $# -gt 0 ] || set -- "${SHELL:-/bin/sh}"; exec "$@"', "sh", folder, ...argv,
];

// ---- setup -----------------------------------------------------------------------------------

/** A single-quoted shell word; an embedded ' becomes '\\''. */
export const shq = (s) => `'${String(s ?? "").replace(/'/g, `'\\''`)}'`;

/** The values a setup step can use: `vars` for {braces}, `env` for $PROJECTS_* in the shell. */
export function setupVars({ main, folder, branch, repo, name, home }) {
  return {
    vars: { main, folder, branch, repo, name, home },
    env: { PROJECTS_MAIN: main, PROJECTS_FOLDER: folder, PROJECTS_BRANCH: branch, PROJECTS_REPO: repo, PROJECTS_NAME: name, PROJECTS_HOME: home },
  };
}

const SETUP_VARS = ["main", "folder", "branch", "repo", "name", "home"];

/** Fills {main}, {folder}, {branch}, {repo}, {name} and {home} in a setup step or copy pattern and nothing else: a shell
 *  `${VAR}`, awk's `{print}` or jq's `{x: .y}` stay as written. (Branch templates use `expand`.) */
export function expandSetup(text, vars) {
  return String(text ?? "").replace(/(\$?)\{(\w+)\}/g, (m, dollar, k) => (dollar || !SETUP_VARS.includes(k) ? m : vars[k] ?? ""));
}

/** "export A='x'; export B='y'": the env for a shell line, values quoted. */
export const exportsPrefix = (env) => Object.entries(env ?? {}).map(([k, v]) => `export ${k}=${shq(v)}`).join("; ");

/** One setup step as its own shell (braces expanded, otherwise verbatim), so its `#`, `;`, `&` and `||` stay inside it;
 *  `-e` makes a step like `a; b` fail when `a` fails. */
export const setupStep = (step, vars) => `sh -ec ${shq(expandSetup(step, vars))}`;

/** One shell line: export the env, cd to `folder`, run each step in its own shell, touch `marker` when given.
 *  "" when there are no steps. */
export function setupChain({ steps, vars, env, folder, marker }) {
  if (!(steps ?? []).length) return "";
  const chain = [`cd ${shq(folder)}`, ...steps.map((x) => setupStep(x, vars)), ...(marker ? [`touch ${shq(marker)}`] : [])].join(" && ");
  const exports = exportsPrefix(env);
  return exports ? `${exports}; ${chain}` : chain;
}

/** The chain, then the agent in place of the shell, started in `dir` (its own pane's folder: the chain ends in the
 *  setup folder); any failure leaves a shell open. "" without a chain. */
export const chainThenAgent = (chain, argv, prompt, dir) =>
  chain ? `${chain}${dir ? ` && cd ${shq(dir)}` : ""} && exec ${argv.map(shq).join(" ")}${prompt ? " " + shq(prompt) : ""} || exec "$SHELL"` : "";

/** The chain alone; a shell takes over when it ends or fails. */
export const chainAlone = (chain) => `${chain} || exec "$SHELL"`;

/** "2 copy · 3 setup · agent after setup" ("setup inline" when it runs in the popup), or "no setup". */
export function setupSummary(project) {
  const copy = project.worktree.copy.length;
  const setup = project.worktree.setup.length + project.startup.setup.length;
  if (!copy && !setup) return "no setup";
  const how = project.startup.quickSetup ? "setup inline" : `agent ${project.startup.agentTiming} setup`;
  return [copy && `${copy} copy`, setup && `${setup} setup`, how].filter(Boolean).join(" · ");
}

// ---- agent options ----------------------------------------------------------------------------

// The coding agents offered even when herdr's own list lacks them (or lists only installed ones).
// Icons are herdr's own, in ~/.config/herdr-app/icons; `tint` ones take the text color.
const FALLBACK_AGENTS = [
  { key: "claude", name: "Claude Code", run: ["claude"], icon: "icons/claude.svg", tint: false },
  { key: "codex", name: "Codex", run: ["codex"], icon: "icons/codex.svg", tint: false },
  { key: "opencode", name: "opencode", run: ["opencode"], icon: "icons/opencode.svg", tint: true },
  { key: "hermes", name: "Hermes", run: ["hermes"], icon: "icons/hermes.svg", tint: true },
  { key: "pi", name: "pi", run: ["pi"], icon: "icons/pi.svg", tint: false },
];

/** Every agent to offer: herdr's list (installed or not), then the fallbacks it doesn't already have. */
export function agentOptions(known) {
  const have = (a) => (known ?? []).some((k) => k.key === a.key || commandName((k.run ?? []).join(" ")) === a.key);
  return [...(known ?? []), ...FALLBACK_AGENTS.filter((a) => !have(a)).map((a) => ({ ...a, installed: false }))];
}

// ---- the picker's list and detail card ----------------------------------------------------------

/** "just now", "12 min ago", "3 hours ago", "yesterday", "5 days ago", "2 weeks ago"; "never" without a time. */
export function ago(ts, now = Date.now()) {
  if (!ts) return "never";
  const m = Math.max(0, Math.floor((now - ts) / 60000));
  if (m < 1) return "just now";
  if (m < 60) return `${m} min ago`;
  const h = Math.floor(m / 60);
  if (h < 24) return `${h} hour${h > 1 ? "s" : ""} ago`;
  const d = Math.floor(h / 24);
  if (d === 1) return "yesterday";
  if (d < 14) return `${d} days ago`;
  if (d < 60) return `${Math.floor(d / 7)} weeks ago`;
  return `${Math.floor(d / 30)} months ago`;
}

/** The list as shown: section headers (Open now, Pinned, Everything else, Template) and the rows between them, each row
 *  keeping its index into `rows`. No headers while searching (the order is then by match) or when only one
 *  section has anything in it. */
export function listItems(rows, searching) {
  const parts = [
    ["Open now", (r) => r.space && !r.p.template],
    ["Pinned", (r) => !r.space && r.p.pinned && !r.p.template],
    ["Everything else", (r) => !r.space && !r.p.pinned && !r.p.template],
    ["Template", (r) => r.p.template],
  ].map(([title, test]) => ({ title, rows: rows.map((r, index) => ({ r, index })).filter((x) => test(x.r)) })).filter((x) => x.rows.length);
  if (searching || parts.length < 2) return rows.map((r, index) => ({ row: r, index }));
  return parts.flatMap((x) => [{ header: x.title }, ...x.rows.map(({ r, index }) => ({ row: r, index }))]);
}

/** Where a layout's panes sit, as fractions of its box: [{ name, x, y, w, h }]. Each split halves the pane it
 *  comes from (the new pane takes the right or bottom half). A broken layout draws as the agent alone. */
export function layoutRects(layout) {
  let plan = [];
  try { plan = layoutPlan(layout); } catch { return [{ name: "agent", x: 0, y: 0, w: 1, h: 1 }]; }
  const rects = [{ name: layout?.panes?.length ? tabPlan([{ name: "l", panes: layout.panes }])[0].panes[0].name : "agent", x: 0, y: 0, w: 1, h: 1 }];
  for (const pane of plan) {
    const from = rects.find((r) => r.name === pane.from);
    if (!from) continue;
    if (pane.direction === "right") {
      const half = from.w / 2;
      rects.push({ name: pane.name, x: from.x + half, y: from.y, w: half, h: from.h });
      from.w = half;
    } else {
      const half = from.h / 2;
      rects.push({ name: pane.name, x: from.x, y: from.y + half, w: from.w, h: half });
      from.h = half;
    }
  }
  return rects;
}

/** What Enter does for a worktree mode, and the label of the main button. */
export const enterAction = (mode, quickLaunch = false) => quickLaunch && mode === "never" ? ["opens the checkout at once", "Open checkout"]
  : quickLaunch && mode === "always" ? ["creates a new worktree at once", "Create worktree"]
  : mode === "never" ? ["opens the launch screen for the checkout", "Open…"]
  : mode === "always" ? ["opens the launch screen for a new worktree", "Open…"]
  : ["opens the launch screen and asks for a branch name", "Open…"];

// ---- space colors -----------------------------------------------------------------------------

// What herdr's space avatars look like for a stored color name (the sidebar's `spaces` mod draws them
// the same way and says every mod that draws space avatars should): one strong color per hue.
export const SPACE_MARK = { ansi6: "#22a99a", ansi3: "#e3814f", ansi4: "#5b8def", ansi5: "#8b7cf6", ansi2: "#3fae6a", ansi1: "#d9649a" };

/** The avatar color of a space from herdr's shared `space.colors` ({ spaceId: "ansi4" | "#rrggbb" }); teal until herdr
 *  has given it one. `theme` supplies a color name SPACE_MARK doesn't know. */
export function spaceColor(colors, id, theme = {}) {
  const c = (colors ?? {})[id] ?? "ansi6";
  return c.startsWith("#") ? c : (SPACE_MARK[c] ?? theme[c] ?? SPACE_MARK.ansi6);
}

// ---- the template, and duplicating -------------------------------------------------------------

/** The starting point a new person edits and duplicates: a project with no folder (`template: true`) and some sensible
 *  settings. It is shown in the list until it is saved or deleted. */
export function defaultTemplate() {
  return normalize({
    name: "Template",
    path: "",
    template: true,
    worktree: { mode: "ask" },
    startup: { agent: "claude", layout: "agent-terminal" },
  });
}

/** A name not in `taken`: "api copy", then "api copy 2", "api copy 3"… */
export function uniqueName(base, taken) {
  const names = new Set(taken);
  if (!names.has(base)) return base;
  for (let n = 2; ; n++) if (!names.has(`${base} ${n}`)) return `${base} ${n}`;
}

/** A copy to edit: unique name, not pinned, no template flag. The folder is kept (the same repo with other settings is the
 *  usual reason to duplicate), except from a template, which has none. */
export function duplicateProject(p, takenNames) {
  const copy = JSON.parse(JSON.stringify(p));
  delete copy.template;
  copy.pinned = false;
  copy.name = uniqueName(p.template ? "New project" : `${p.name} copy`, takenNames);
  if (p.template) copy.path = "";
  return normalize(copy);
}

/** A blank project that starts with the template's settings (agent, layout, worktree and git settings, group) but not its
 *  name or folder. */
export function startFromTemplate(template) {
  return { ...duplicateProject(template, []), name: "", path: "" };
}

// ---- backup and restore ----------------------------------------------------------------------------

/** A path with the home folder written as `~`, so a backup works on a machine with another user name. */
export function portablePath(path, home) {
  const s = String(path ?? "");
  const h = String(home ?? "").replace(/\/+$/, "");
  if (!h) return s;
  if (s === h) return "~";
  return s.startsWith(h + "/") ? "~" + s.slice(h.length) : s;
}

export const BACKUP_FORMAT = "projects-backup";

/** What an export writes: the whole data file (projects, layouts, settings) with home-folder paths made portable. */
export function exportData({ projects, layouts, gitInfo, hideTemplate }, home, now = new Date()) {
  return {
    format: BACKUP_FORMAT,
    version: 1,
    exportedAt: now.toISOString(),
    gitInfo: gitInfo !== false,
    hideTemplate: hideTemplate === true,
    layouts: layouts ?? [],
    projects: (projects ?? []).map((p) => ({ ...p, path: portablePath(p.path, home), worktree: { ...p.worktree, root: portablePath(p.worktree?.root, home) } })),
  };
}

/** Reads a backup (or a plain projects.json): { projects, layouts, gitInfo, hideTemplate }. Throws with the reason. */
export function parseBackup(text) {
  let data;
  try { data = JSON.parse(text); } catch (e) { throw new Error(`That file is not valid JSON: ${e.message}`); }
  if (!data || typeof data !== "object" || !Array.isArray(data.projects)) throw new Error("That file has no list of projects: is it a projects backup?");
  if (data.format !== undefined && data.format !== BACKUP_FORMAT) throw new Error(`That file is not a projects backup (format "${data.format}")`);
  if (data.version > 1) throw new Error("That backup is from a newer version of projects: update the mod, then import it");
  const layouts = Array.isArray(data.layouts) ? data.layouts : [];
  return {
    projects: data.projects.filter((p) => p && typeof p === "object").map((p) => normalize(p, layouts)),
    layouts,
    gitInfo: data.gitInfo !== false,
    hideTemplate: data.hideTemplate === true,
  };
}

const projectKey = (p) => `${p.name}\u0000${String(p.path ?? "").replace(/\/+$/, "")}`;

/** Adds the incoming projects that are not already there (same name and folder), keeping yours as they are.
 *  An incoming template is skipped when you have one. */
export function mergeProjects(existing, incoming) {
  const have = new Set(existing.map(projectKey));
  const hasTemplate = existing.some((p) => p.template);
  const projects = [...existing];
  let added = 0;
  let skipped = 0;
  for (const p of incoming) {
    if (have.has(projectKey(p)) || (p.template && hasTemplate)) { skipped++; continue; }
    projects.push(p);
    have.add(projectKey(p));
    added++;
  }
  return { projects, added, skipped };
}

/** Adds the incoming layouts whose names you don't have; yours win. */
export function mergeLayouts(existing, incoming) {
  const names = new Set(existing.map((l) => l.name));
  const fresh = incoming.filter((l) => l && typeof l.name === "string" && !names.has(l.name));
  return { layouts: [...existing, ...fresh], added: fresh.length };
}

/** The default name for an export, with the local date and time so each export keeps its own file:
 *  projects-config-2026-11-01-133500.json */
export function exportFileName(now = new Date()) {
  const n = (v, w = 2) => String(v).padStart(w, "0");
  return `projects-config-${now.getFullYear()}-${n(now.getMonth() + 1)}-${n(now.getDate())}-${n(now.getHours())}${n(now.getMinutes())}${n(now.getSeconds())}.json`;
}

/** The launcher blocks a layout needs (see the projects-launcher mod), added to a copy of `tree`: the sidebar one
 *  under the Spaces list, the status one beside the status bar, the tab one beside the tab bar. Each is added only where
 *  the layout has the block it goes beside (`spaces`, `status`, `tabs`), and never twice. Returns { tree, added: [slots] }. */
export function withLauncherBlocks(tree) {
  const copy = JSON.parse(JSON.stringify(tree ?? null));
  const added = [];
  const block = (slot, px) => ({ id: `projects-launch-${slot}`, type: "block", size: { px }, content: { mod: "projects-launcher", props: { slot } } });
  const has = (n, id) => n?.id === id || (n?.children ?? []).some((c) => has(c, id));
  // Wraps the block `id` in a container of its own kind (the block keeps its content; the container takes its size).
  const wrap = (n, id, type, slot, px, containerId) => {
    const kids = n?.children;
    if (!kids) return false;
    const i = kids.findIndex((c) => c.id === id);
    if (i >= 0) {
      const target = kids[i];
      const { size, min, max } = target;
      const inner = { ...target, size: { weight: 1 } };
      delete inner.min; delete inner.max;
      kids[i] = { id: containerId, type, size: size ?? { weight: 1 }, ...(min != null ? { min } : {}), ...(max != null ? { max } : {}), ...(target.window_drag ? { window_drag: true } : {}), children: [inner, block(slot, px)] };
      return true;
    }
    return kids.some((c) => wrap(c, id, type, slot, px, containerId));
  };
  if (!copy || has(copy, "projects-launch-sidebar") || has(copy, "projects-launch-status") || has(copy, "projects-launch-tabs")) return { tree: copy, added };
  if (wrap(copy, "spaces", "column", "sidebar", 36, "spaces-section")) added.push("sidebar");
  if (wrap(copy, "status", "row", "status", 96, "status-row")) added.push("status");
  if (wrap(copy, "tabs", "row", "tabs", 36, "tabs-row")) added.push("tabs");
  return { tree: copy, added };
}
