// Everything that creates spaces, tabs and panes: a project's tabs become app commands here and nowhere else.
import { exec, hc, run, spaces, home, appHome, writeTextFile, shared, setShared } from "herdr";
import { log as diag } from "./log.js";
import { splitArgs, inFolder, tabPlan, firstAgent, resolveFolder, chainThenAgent, chainAlone, inUserShell, commandName, shq } from "./lib.js";
import { folderExists, findSpace, projectFolder } from "./git.js";

const sleep = (s) => exec("sleep", [String(s)]);

// Launches take turns creating their space: the new terminal is found as "new since a snapshot",
// which two overlapping launches into one folder would otherwise mix up. The turn is held in shared
// state ("projects.lock": { since }) so the picker's copy and the resident watcher's copy take turns
// too; the promise chain below is a second guard inside one copy.
let spaceLock = Promise.resolve();
// A turn that hangs (hc not answering) gives up its place after this long so later launches still run.
export const lockSettings = { seconds: 25 };
const LOCK = "projects.lock";

/** Runs `fn` holding the shared lock: waits while another copy's lock is younger than lockSettings.seconds. */
async function sharedTurn(fn) {
  for (;;) {
    const held = shared(LOCK);
    if (!held?.since || Date.now() - held.since >= lockSettings.seconds * 1000) break;
    await sleep(0.25);
  }
  const mine = { since: Date.now() };
  setShared(LOCK, mine);
  try { return await fn(); }
  // A turn that outlived its lock (another copy took it over) leaves the newer holder's lock alone.
  finally { if (shared(LOCK)?.since === mine.since) setShared(LOCK, null); }
}

const exclusive = (fn) => {
  const result = spaceLock.then(() => sharedTurn(fn));
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
  const r = await hc(["send", terminal, "--", text]);
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
// An agent pane's command line; its env lines go in front through `env`, which execs the agent with them set.
const agentArgv = (pane) => (pane.type === "agent" ? [...((pane.env ?? []).length ? ["env", ...pane.env] : []), ...splitArgs(pane.agent), ...splitArgs(pane.args)] : []);

/** The reply of an `herdr-app do` call, or null when it failed (logged at `level`). */
async function appDo(command, args, what, level = "error") {
  const r = await exec("herdr-app", ["do", command, JSON.stringify(args)]);
  let made = {};
  try { made = JSON.parse(r.stdout || "{}"); } catch {}
  if (r.code !== 0 || made.error) {
    diag(level, `couldn't ${command} for ${what}`, { code: r.code, error: made.error ?? r.stderr.split("\n")[0] });
    return null;
  }
  return made;
}

/** Whether `herdr-app ls` shows tab `tab` in `space`, waiting up to 3 s for it to appear. */
async function tabShown(space, tab) {
  for (let i = 0; i < 12; i++) {
    try {
      const r = await exec("herdr-app", ["ls"]);
      const s = (JSON.parse(r.stdout || "{}").spaces ?? []).find((x) => x.id === space);
      if (s?.tabs?.some((t) => t.id === tab)) return true;
    } catch {}
    await sleep(0.25);
  }
  return false;
}

// How long typeLine waits for a shell at a bare prompt: `tries` looks, `seconds` apart (10 s).
export const typeSettings = { tries: 20, seconds: 0.5 };

/** Whether the terminal's last non-empty line is a prompt with nothing typed after it. */
async function atBarePrompt(terminal) {
  try {
    const r = await hc(["read", terminal]);
    if (r.code !== 0) return false;
    const last = r.stdout.split("\n").map((l) => l.replace(/\s+$/, "")).filter(Boolean).pop() ?? "";
    return /[$%>#]$/.test(last);
  } catch { return false; }
}

/** Types a shell `line` into `terminal` (hc send pastes it and presses Enter) once a shell is the foreground program
 *  and sits at a bare prompt, so the line never joins something the person is typing; when that doesn't happen
 *  within typeSettings the line is skipped and logged. Resolves to whether the line was sent. */
async function typeLine(terminal, line) {
  for (let i = 0; i < typeSettings.tries; i++) {
    let fg = null;
    try { fg = JSON.parse((await hc(["get", terminal, "--json"])).stdout).foreground?.name ?? null; } catch {}
    if (SHELLS.has(fg) && (await atBarePrompt(terminal))) {
      const r = await hc(["send", terminal, "--", line]);
      if (r.code !== 0) diag("error", `hc send failed: ${r.stderr.split("\n")[0]}`, { terminal });
      return r.code === 0;
    }
    await sleep(typeSettings.seconds);
  }
  diag("error", "couldn't type into the new space's shell: no shell at a bare prompt", { terminal, line });
  return false;
}

/** The space, first pane and first terminal of a space the app already made (the watcher's case), in the
 *  shape the space.new path finds; a plain shell there is given pane (0,0)'s line, an agent is left alone.
 *  Checked again here, holding the lock: a space that closed or no longer has one tab with one pane is
 *  left alone (`skipped`). `typed` is false when the line was skipped; `tabName` is the tab's name now. */
async function adoptExisting(existing, line) {
  const now = spaces().find((s) => s.id === existing.space);
  if (!now || now.tabs?.length !== 1 || now.tabs[0].panes !== 1) {
    diag("info", "watcher: left alone, the space changed before the build", { space: existing.space, tabs: now?.tabs?.length ?? null });
    return { skipped: true };
  }
  const typed = !existing.agent && line ? await typeLine(existing.terminal, line) : true;
  return { space: existing.space, pane: existing.pane, terminal: existing.terminal ?? null, typed, tabName: now.tabs[0].name };
}

/** Runs the setup chain in its own tab of `space` (a labeled `hc run`, which herdr shows as a tab there),
 *  named "setup"; the tab closes when the chain succeeds and stays at a shell when it fails.
 *  Resolves to whether the chain started; when it didn't, `log` (the busy screen) says why. */
async function startSetupTerminal(space, folder, chain, log) {
  const tabId = `setup-${Date.now()}`;
  const r = await hc(["run", "--bg", "--rm", "--no-parent", "--no-notify", "--cwd", folder, "--label", "herdr.space=" + space, "--label", "herdr.tab=" + tabId, "--", ...inUserShell(chainAlone(chain))]);
  if (r.code !== 0) {
    const why = r.stderr.split("\n")[0] || `hc run exited ${r.code}`;
    diag("error", `couldn't start the setup terminal: ${why}`, { space, folder });
    log(`setup did not start: ${why}`);
    return false;
  }
  // A short chain can end (and its tab close) before the rename: not an error.
  if (!(await tabShown(space, tabId))) diag("debug", "setup tab not renamed: it never showed up", { space, tab: tabId });
  else await appDo("tab.rename", { id: tabId, name: "setup" }, "the setup tab", "debug");
  return true;
}

/** Hands a send-mode prompt to a detached helper that types it once the agent (behind its setup chain) is ready;
 *  `program` is the agent's program name, which the helper waits to see in front when herdr reports no status. */
async function startPromptHelper(terminal, prompt, program) {
  if (!terminal) { diag("error", "prompt not sent: couldn't find the new terminal"); return false; }
  const file = `${appHome()}/data/projects/prompt-${Date.now()}.txt`;
  try { await writeTextFile(file, prompt, null); } catch (e) { diag("error", `prompt not sent: ${e.message}`, { file }); return false; }
  const r = await hc(["run", "--bg", "--rm", "--no-parent", "--no-notify", "--", "sh", `${appHome()}/mods/projects/bin/send-prompt.sh`, terminal, file, program]);
  if (r.code !== 0) {
    diag("error", `couldn't start the prompt helper: ${r.stderr.split("\n")[0]}`, { terminal });
    await exec("rm", ["-f", file]).catch(() => {});
    return false;
  }
  return true;
}

/** Opens `folder` as a space with the project's tabs, each tab's panes split as planned, and starts the first agent
 *  (with `prompt`, which no other pane gets). Throws before creating anything when the tabs can't be built or a folder is missing.
 *  `chain` (the setup commands, or "") runs before the agent in its own pane when `agentTiming` is "after",
 *  or beside it in a setup tab when "with" (or when there is no agent).
 *  Returns the new space, the first agent's terminal when it is known, and `problems`: how many parts didn't happen
 *  (a typed line skipped, a failed split or tab, the setup terminal or prompt helper not started). Building into an
 *  `existing` space that changed before the lock was ours builds nothing and returns `skipped: true`. */
export async function buildWorkspace({ project, folder, name, tabs, prompt, agentTiming = "with", chain = "", log, existing = null }) {
  const plan = tabPlan(tabs);
  // Building into a space the app already made: no prompt; an agent already running there is the plan's
  // first agent, so the chain can't run before it and goes to a setup terminal instead.
  if (existing) prompt = "";
  if (existing?.agent) agentTiming = "with";
  const env = await readEnv();

  // A pane's folder is relative to its tab's folder, which is relative to the project folder.
  const dirs = plan.map((t) => { const tabDir = resolveFolder(folder, t.folder, home(), env); return t.panes.map((p) => resolveFolder(tabDir, p.folder, home(), env)); });
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
  // "after": the lead pane runs the chain and then execs into the agent; otherwise the chain gets a setup tab.
  const after = Boolean(chain && leadArgv.length && agentTiming === "after");
  const isFirst = (ti, pi) => ti === 0 && pi === 0;
  const isLead = (ti, pi) => lead?.tab === ti && lead?.index === pi;
  // The existing space's agent fulfils the plan's first agent pane: elsewhere, that pane is a plain shell.
  const adopted = (ti, pi) => Boolean(existing?.agent && isLead(ti, pi));
  /** The lead pane's chain-then-agent line, for "after" timing. */
  const leadLine = (ti, pi) => chainThenAgent(chain, agentArgv(plan[ti].panes[pi]), arg ? prompt : "", dirs[ti][pi]);
  // A command or a chain runs in the person's own shell (inUserShell), so it finds the tools their terminals find.
  const argvOf = (ti, pi) => {
    const pane = plan[ti].panes[pi];
    if (pane.type === "command") return inUserShell(pane.command);
    if (adopted(ti, pi)) return [];
    const argv = agentArgv(pane);
    if (after && isLead(ti, pi)) return inUserShell(leadLine(ti, pi));
    return argv.length && arg && isLead(ti, pi) && !isFirst(ti, pi) ? [...argv, prompt] : argv;
  };
  /** Pane (0,0)'s program as a line typed into a plain shell (the person's own, so no inUserShell): the chain-then-agent
   *  line (it changes into the pane's folder itself), or `cd` to the pane's folder and then `exec` the agent or run the
   *  command; "" for a shell pane. */
  const lineOf00 = () => {
    const pane = plan[0].panes[0];
    const cd = `cd ${shq(dirs[0][0])} && `;
    if (pane.type === "command") return cd + pane.command;
    if (after && isLead(0, 0)) return leadLine(0, 0);
    const argv = argvOf(0, 0);
    return argv.length ? `${cd}exec ${argv.map(shq).join(" ")}` : "";
  };
  let problems = 0;

  /** Splits a tab's first pane into the rest of its panes; a failed split ends this tab's panes. */
  async function splitTab(ti, root, rootTerminal) {
    const t = plan[ti];
    const ids = { [t.panes[0].name]: root };
    const terminals = { [t.panes[0].name]: rootTerminal };
    for (let pi = 1; pi < t.panes.length; pi++) {
      const pane = t.panes[pi];
      const made = await appDo("pane.split", { direction: pane.direction, pane: ids[pane.from], argv: inFolder(dirs[ti][pi], argvOf(ti, pi)) }, `${t.name} ${pane.name}`);
      if (!made?.pane) { problems++; break; }
      ids[pane.name] = made.pane;
      terminals[pane.name] = made.terminal ?? null;
    }
    return { ids, terminals };
  }

  /** Opens the space with space.new and finds it (and, for a send prompt, its first terminal). */
  async function openSpace() {
    const spacesBefore = new Set(spaces().map((s) => s.id));
    const known = send ? new Set((await liveTerminals()).map((t) => t.address)) : null;
    // The resident watcher skips a space for a folder the picker is opening (entries go stale after 5 min).
    // The repo's own space, when this launch opens it first, is marked too.
    const markOpening = (dir) => {
      const now = Date.now();
      const opening = Object.fromEntries(Object.entries(shared("projects.opening") ?? {}).filter(([, at]) => now - at < 5 * 60000));
      setShared("projects.opening", { ...opening, [dir]: now });
    };
    markOpening(dirs[0][0]);
    // Herdr nests a worktree's space under its repo's own space, but only while that one is open.
    const main = projectFolder(project);
    if (project.worktree.repoSpace && folder !== main && !findSpace(project)) {
      diag("debug", "opening the repo's space first", { main });
      markOpening(main);
      run("space.new", { name: project.name, folder: main });
    }
    const firstArgv = argvOf(0, 0);
    diag("debug", "launch", { folder, name, argv: firstArgv, tabs: plan.length });
    run("space.new", {
      name, folder: dirs[0][0], tab: plan[0].name,
      ...(firstArgv.length ? { argv: firstArgv, ...(arg && !after && isLead(0, 0) ? { task: prompt } : {}) } : {}),
    });
    // focused() can still be the window the picker was opened from just after space.new, so the new
    // space and its first pane come from `herdr-app ls`: the space that wasn't there before.
    const here = await findNewSpace(spacesBefore, name, dirs[0][0]);
    // Found before the split panes exist, which also start in this folder.
    if (here && send && isLead(0, 0)) here.terminal = await findNewTerminal(known, dirs[0][0]);
    return here;
  }

  const { space, agentTerminal, focusPane, skipped } = await exclusive(async () => {
    const here = existing ? await adoptExisting(existing, lineOf00()) : await openSpace();
    if (here?.skipped) return { skipped: true };
    if (here?.typed === false) problems++;
    // The adopted shell's tab takes the plan's first tab name, as a space.new {tab} would have (best effort). An
    // adopted agent's tab keeps its name: the plan may put its agent in another tab.
    if (existing && !existing.agent && here.tabName !== plan[0].name) await appDo("tab.rename", { id: existing.tab, name: plan[0].name }, "the adopted tab");
    const space = here?.space ?? null;
    const firstTerminal = here?.terminal ?? null;
    const paneIds = [];
    // An agent already running in the existing pane is the agent, wherever the plan put its first agent pane.
    const agentFirst = isLead(0, 0) || Boolean(existing?.agent);
    let agentTerminal = agentFirst ? firstTerminal : null;
    let agentPane = agentFirst ? here?.pane ?? null : null;
    const noteAgent = (ti, split) => {
      if (lead?.tab !== ti || existing?.agent) return;
      const pname = plan[ti].panes[lead.index].name;
      agentPane = split.ids[pname] ?? agentPane;
      agentTerminal = split.terminals[pname] ?? agentTerminal;
    };
    // Without the new space, nothing else is made: a guess (the focused space) could put the tabs in another project.
    if (!here) diag("error", "tab 1's splits and the later tabs skipped: couldn't find the new space", { name, tabs: plan.length });
    else {
      paneIds[0] = here.pane;
      try { noteAgent(0, await splitTab(0, here.pane, firstTerminal)); } catch (e) { problems++; diag("error", `tab 1: ${e.message}`); }
    }
    for (let ti = 1; here && ti < plan.length; ti++) {
      try {
        const t = plan[ti];
        const argv = argvOf(ti, 0);
        const made = await appDo("tab.new", { space, name: t.name, folder: dirs[ti][0], ...(argv.length ? { argv } : {}) }, t.name);
        if (!made) { problems++; continue; }
        const root = await findTabPane(space, made.tab);
        if (!root) { problems++; diag("error", `tab "${t.name}": couldn't find its first pane`); continue; }
        paneIds[ti] = root;
        noteAgent(ti, await splitTab(ti, root, made.terminal ?? null));
      } catch (e) { problems++; diag("error", `tab "${plan[ti].name}": ${e.message}`); }
    }
    return { space, agentTerminal, focusPane: agentPane ?? paneIds[0] ?? null };
  });
  if (skipped) return { space: existing.space, agentTerminal: null, problems: 1, skipped: true };
  // A space the watcher built in the background keeps the person where they are unless it is the shown one.
  if (focusPane && (!existing || spaces().find((s) => s.id === space)?.active)) run("pane.focus", { pane: focusPane });
  if (after) log("setup continues in the agent pane");
  else if (chain) {
    if (!space) {
      problems++;
      diag("error", "setup not run: couldn't find the new space", { folder });
      log("setup did not start: couldn't find the new space");
    } else if (await startSetupTerminal(space, folder, chain, log)) log("setup runs in the setup tab");
    else problems++;
  }
  if (send && after) { if (!(await startPromptHelper(agentTerminal, prompt, commandName(lead.pane.agent)))) problems++; }
  else if (send) await sendWhenReady(agentTerminal, dirs[lead.tab][lead.index], prompt);
  return { space, agentTerminal, problems };
}
