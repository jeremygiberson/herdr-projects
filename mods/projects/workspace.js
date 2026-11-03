// Everything that creates spaces, tabs and panes: a project's tabs become app commands here and nowhere else.
import { exec, hc, run, focused, spaces, home } from "herdr";
import { log as diag } from "./log.js";
import { splitArgs, inFolder, tabPlan, firstAgent, resolveFolder } from "./lib.js";
import { folderExists, findSpace, projectFolder } from "./git.js";

const sleep = (s) => exec("sleep", [String(s)]);

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

/** The space space.new just made: not in `before`, with this name (and folder, when several), and its first pane and terminal. */
async function findNewSpace(before, name, folder) {
  for (let i = 0; i < 20; i++) {
    try {
      const r = await exec("herdr-app", ["ls"]);
      const fresh = (JSON.parse(r.stdout || "{}").spaces ?? []).filter((s) => !before.has(s.id) && s.name === name);
      const found = fresh.filter((s) => s.folder === folder).pop() ?? fresh.pop();
      const first = found?.tabs?.[0]?.terminals?.[0];
      if (found && first?.pane) return { space: found.id, pane: first.pane, terminal: first.terminal ?? null };
    } catch {}
    await sleep(0.25);
  }
  return null;
}

/** The first pane of a tab tab.new just made, from `herdr-app ls`. */
async function findTabPane(space, tab) {
  for (let i = 0; i < 20; i++) {
    try {
      const r = await exec("herdr-app", ["ls"]);
      const s = (JSON.parse(r.stdout || "{}").spaces ?? []).find((x) => x.id === space);
      const pane = s?.tabs?.find((t) => t.id === tab)?.terminals?.[0]?.pane;
      if (pane) return pane;
    } catch {}
    await sleep(0.25);
  }
  return null;
}

export async function liveTerminals() {
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
export async function sendWhenReady(terminal, folder, text) {
  if (!terminal) return diag("error", "prompt not sent: couldn't find the new terminal", { folder });
  const started = Date.now();
  for (;;) {
    const t = (await liveTerminals()).find((x) => x.address === terminal);
    if (!t) return diag("error", "prompt not sent: the terminal ended", { terminal });
    const waited = Date.now() - started;
    let fg = null;
    if (!t.status) {
      try { fg = JSON.parse((await hc(["get", terminal, "--json"])).stdout).foreground?.name ?? null; } catch {}
    }
    diag("debug", "waiting to send prompt", { terminal, status: t.status ?? null, agent: t.agent, foreground: fg, waited });
    if (t.status === "blocked") return diag("error", "prompt not sent: the agent is waiting on you", { terminal });
    if (t.status === "idle" || t.status === "done") break;
    if (!t.status && fg && !SHELLS.has(fg) && waited > 6000) break;
    if (waited > 30000) return diag("error", "prompt not sent: the agent never became ready", { terminal, foreground: fg });
    await sleep(0.5);
  }
  const r = await hc(["send", terminal, text]);
  diag("debug", "sent prompt", { terminal, code: r.code });
  if (r.code !== 0) diag("error", `hc send failed: ${r.stderr.split("\n")[0]}`, { terminal });
}

/** The person's environment, for $VAR in folders. */
async function readEnv() {
  const env = {};
  for (const line of (await exec("env", [])).stdout.split("\n")) {
    const at = line.indexOf("=");
    if (at > 0) env[line.slice(0, at)] = line.slice(at + 1);
  }
  return env;
}

/** The agent's command line (its name and arguments); empty for any other pane, or an agent pane with no agent. */
const agentArgv = (pane) => (pane.type === "agent" ? [...splitArgs(pane.agent), ...splitArgs(pane.args)] : []);

/** The reply of an `herdr-app do` call, or null when it failed. */
async function appDo(command, args, what) {
  const r = await exec("herdr-app", ["do", command, JSON.stringify(args)]);
  let made = {};
  try { made = JSON.parse(r.stdout || "{}"); } catch {}
  if (r.code !== 0 || made.error) {
    diag("error", `couldn't ${command} for ${what}`, { code: r.code, error: made.error ?? r.stderr.split("\n")[0] });
    return null;
  }
  return made;
}

/** Opens `folder` as a space with the project's tabs, each tab's panes split as planned, and starts the first agent
 *  (with `prompt`, which no other pane gets). Throws before creating anything when the tabs can't be built or a folder is missing.
 *  Returns the new space and the first agent's terminal when it is known. */
export async function buildWorkspace({ project, folder, name, tabs, prompt, log }) {
  const plan = tabPlan(tabs);
  const env = await readEnv();

  const dirs = plan.map((t) => t.panes.map((p) => resolveFolder(folder, p.folder || t.folder, home(), env)));
  const exists = new Map();
  for (const [ti, t] of plan.entries()) {
    for (const [pi, dir] of dirs[ti].entries()) {
      if (!exists.has(dir)) exists.set(dir, await folderExists(dir));
      if (!exists.get(dir)) throw new Error(`Tab "${t.name}" pane ${pi + 1}: folder does not exist: ${dir}`);
    }
  }

  const lead = firstAgent(plan);
  if (prompt && !lead) log("no agent pane to prompt: the prompt is ignored");
  const leadArgv = lead ? agentArgv(lead.pane) : [];
  // "arg": herdr appends the prompt to the command line (claude and most agents take that).
  // "send": start the agent bare and type the prompt once it is ready (hermes and others
  // that read a positional argument as a subcommand).
  const send = Boolean(prompt && leadArgv.length && lead.pane.promptMode === "send");
  const arg = Boolean(prompt && leadArgv.length && !send);
  const isFirst = (ti, pi) => ti === 0 && pi === 0;
  const isLead = (ti, pi) => lead?.tab === ti && lead?.index === pi;
  const argvOf = (ti, pi) => {
    const pane = plan[ti].panes[pi];
    if (pane.type === "command") return ["sh", "-c", pane.command];
    const argv = agentArgv(pane);
    return argv.length && arg && isLead(ti, pi) && !isFirst(ti, pi) ? [...argv, prompt] : argv;
  };

  /** Splits a tab's first pane into the rest of its panes; a failed split ends this tab's panes. */
  async function splitTab(ti, root, rootTerminal) {
    const t = plan[ti];
    const ids = { [t.panes[0].name]: root };
    const terminals = { [t.panes[0].name]: rootTerminal };
    for (let pi = 1; pi < t.panes.length; pi++) {
      const pane = t.panes[pi];
      const made = await appDo("pane.split", { direction: pane.direction, pane: ids[pane.from], argv: inFolder(dirs[ti][pi], argvOf(ti, pi)) }, `${t.name} ${pane.name}`);
      if (!made?.pane) break;
      ids[pane.name] = made.pane;
      terminals[pane.name] = made.terminal ?? null;
    }
    return { ids, terminals };
  }

  const { space, agentTerminal, focusPane } = await exclusive(async () => {
    const spacesBefore = new Set(spaces().map((s) => s.id));
    const known = send ? new Set((await liveTerminals()).map((t) => t.address)) : null;
    // Herdr nests a worktree's space under its repo's own space, but only while that one is open.
    const main = projectFolder(project);
    if (project.worktree.repoSpace && folder !== main && !findSpace(project)) {
      diag("debug", "opening the repo's space first", { main });
      run("space.new", { name: project.name, folder: main });
    }
    const firstArgv = argvOf(0, 0);
    diag("debug", "launch", { folder, name, argv: firstArgv, tabs: plan.length });
    run("space.new", {
      name, folder: dirs[0][0],
      ...(firstArgv.length ? { argv: firstArgv, ...(arg && isLead(0, 0) ? { task: prompt } : {}) } : {}),
    });
    // focused() can still be the window the picker was opened from just after space.new, so the new
    // space and its first pane come from `herdr-app ls`: the space that wasn't there before.
    const here = await findNewSpace(spacesBefore, name, dirs[0][0]);
    const space = here?.space ?? focused()?.space;
    // Found before the split panes exist, which also start in this folder.
    const firstTerminal = send && isLead(0, 0) ? await findNewTerminal(known, dirs[0][0]) : here?.terminal ?? null;
    const paneIds = [];
    let agentTerminal = isLead(0, 0) ? firstTerminal : null;
    let agentPane = isLead(0, 0) ? here?.pane ?? null : null;
    const noteAgent = (ti, split) => {
      if (lead?.tab !== ti) return;
      const pname = plan[ti].panes[lead.index].name;
      agentPane = split.ids[pname] ?? agentPane;
      agentTerminal = split.terminals[pname] ?? agentTerminal;
    };
    if (!here) diag("error", "tab 1's splits skipped: couldn't find the new space", { name });
    else {
      paneIds[0] = here.pane;
      try { noteAgent(0, await splitTab(0, here.pane, firstTerminal)); } catch (e) { diag("error", `tab 1: ${e.message}`); }
    }
    for (let ti = 1; ti < plan.length; ti++) {
      try {
        const t = plan[ti];
        const argv = argvOf(ti, 0);
        const made = await appDo("tab.new", { space, name: t.name, folder: dirs[ti][0], ...(argv.length ? { argv } : {}) }, t.name);
        if (!made) continue;
        const root = await findTabPane(space, made.tab);
        if (!root) { diag("error", `tab "${t.name}": couldn't find its first pane`); continue; }
        paneIds[ti] = root;
        noteAgent(ti, await splitTab(ti, root, made.terminal ?? null));
      } catch (e) { diag("error", `tab "${plan[ti].name}": ${e.message}`); }
    }
    return { space, agentTerminal, focusPane: agentPane ?? paneIds[0] ?? null };
  });
  if (focusPane) run("pane.focus", { pane: focusPane });
  if (send) await sendWhenReady(agentTerminal, dirs[lead.tab][lead.index], prompt);
  return { space, agentTerminal };
}
