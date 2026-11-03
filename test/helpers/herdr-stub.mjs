// A stand-in for herdr's `herdr` module. exec runs real programs (so git tests use real repos);
// hc, run, spaces and focused are a small fake of the app that tests can inspect and steer.
import { execFile } from "node:child_process";
import { mkdtempSync, readFileSync, writeFileSync, existsSync, mkdirSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

const root = mkdtempSync(join(tmpdir(), "pp-herdr-"));
mkdirSync(join(root, "app", "data"), { recursive: true });

// How often each call into the app was made, so a test can say a render does not repeat them per row.
export const calls = {};
const count = (name) => { calls[name] = (calls[name] ?? 0) + 1; };
export const resetCalls = () => { for (const k of Object.keys(calls)) delete calls[k]; };

export const state = {
  home: join(root, "home"),
  appHome: join(root, "app"),
  spaces: [],
  focused: null,
  terminals: [],        // what `hc ls --json` reports
  foreground: "claude", // what `hc get` reports as the foreground program
  runs: [],             // every run(command, args)
  sent: [],             // every `hc send <terminal> <text>`
  agentStatus: "idle",  // status given to a terminal created by space.new
  nextId: 1,
  sendFails: false,
  hangNextLs: false, // the next `hc ls` never answers
  splits: [],           // every `herdr-app do pane.split`
  splitFails: false,
  tabsMade: [],         // every `herdr-app do tab.new`
  appLsHidesSpaces: false, // `herdr-app ls` lists no spaces (a new space is never found)
  hcRuns: [],           // every `hc run …`
  labeledTabs: [],      // tabs a labeled `hc run` adds to a space: { space, tab }
  hcRunHidesTab: false, // a labeled `hc run` never shows up as a tab
  renames: [],          // every `herdr-app do tab.rename`
  hcRunFails: false,    // `hc run` answers a non-zero code
};

export function reset() {
  Object.assign(state, { spaces: [], focused: null, terminals: [], foreground: "claude", runs: [], sent: [], agentStatus: "idle", nextId: 1, sendFails: false, hangNextLs: false, splits: [], splitFails: false, tabsMade: [], appLsHidesSpaces: false, hcRuns: [], labeledTabs: [], hcRunHidesTab: false, renames: [], hcRunFails: false, closed: 0, platform: "linux", picked: null });
  for (const k of Object.keys(store)) delete store[k];
}

export const home = () => { count("home"); return state.home; };
export const appHome = () => state.appHome;
export const spaces = () => { count("spaces"); return state.spaces; };
export const layouts = () => state.layoutNames ?? ["main"];
export const layout = () => state.layout ?? null; // the shown layout tree; null is a layout without any of our blocks
export const focused = () => state.focused;

export function exec(command, args = [], options = {}) {
  // The real herdr-app would split the person's window: answer like it, and record the request.
  if (command === "herdr-app") {
    if (args[0] === "ls") {
      const spaces = (state.appLsHidesSpaces ? [] : state.spaces).map((s) => ({ ...s, tabs: [{ id: `tb-${s.id}`, terminals: [{ terminal: `t-${s.id}`, pane: `pane-of-${s.id}` }] }, ...state.tabsMade.map((t, i) => ({ t, tab: `tab-${i + 1}` })).filter(({ t }) => t.space === s.id).map(({ tab }) => ({ id: tab, terminals: [{ terminal: `t-${tab}`, pane: `pane-of-${tab}` }] })), ...state.labeledTabs.filter((l) => l.space === s.id).map((l, i) => ({ id: l.tab, terminals: [{ terminal: `t-${l.tab}`, pane: `pane-of-${l.tab}-${i}` }] }))] }));
      return Promise.resolve({ code: 0, stdout: JSON.stringify({ spaces }), stderr: "" });
    }
    const [, name, json] = args;
    const a = JSON.parse(json ?? "{}");
    if (name === "tab.new") {
      const n = state.tabsMade.length + 1;
      state.tabsMade.push(a);
      state.terminals.push({ address: `t-tab-${n}`, cwd: a.folder, state: "live", status: state.agentStatus, argv: a.argv ?? [] });
      return Promise.resolve({ code: 0, stdout: JSON.stringify({ space: a.space, tab: `tab-${n}`, terminal: `t-tab-${n}` }), stderr: "" });
    }
    if (name === "tab.rename") {
      state.renames.push(a);
      return Promise.resolve({ code: 0, stdout: JSON.stringify({ ok: true }), stderr: "" });
    }
    if (state.splitFails) return Promise.resolve({ code: 1, stdout: JSON.stringify({ error: "no such pane" }), stderr: "" });
    state.splits.push({ command: name, ...a });
    const id = `pane-${state.splits.length}`;
    state.terminals.push({ address: `t-${id}`, cwd: a.argv?.[4], state: "live", status: state.agentStatus, argv: a.argv });
    return Promise.resolve({ code: 0, stdout: JSON.stringify({ pane: id, terminal: `t-${id}` }), stderr: "" });
  }
  return new Promise((resolve, reject) => {
    execFile(command, args, { cwd: options.cwd, encoding: "utf8", maxBuffer: 8 << 20 }, (err, stdout, stderr) => {
      if (err && typeof err.code !== "number") return reject(err);
      resolve({ code: err ? err.code : 0, stdout, stderr });
    });
  });
}

// space.new makes a space and a live terminal in the folder, as herdr does; the rest is only recorded.
export function run(command, args = {}) {
  state.runs.push({ command, args });
  if (command === "space.new") {
    const id = `sp${state.nextId++}`;
    state.spaces.push({ id, name: args.name, folder: args.folder, machine: null });
    // herdr moves focus to the new space only later: right after space.new focused() is still the old window
    state.focused ??= { space: "picker-space", pane: "picker-pane" };
    state.terminals.push({ address: `t${state.nextId++}`, cwd: args.folder, state: "live", status: state.agentStatus, agent: args.argv?.[0] ?? null, argv: args.argv ?? [] });
  } else if (command === "space.close") {
    state.spaces = state.spaces.filter((s) => s.id !== args.id);
  }
  return null;
}

export async function hc(args) {
  // The answer is read when hc is called and delivered later, like a real process: a slow `ls` shows old state.
  if (state.hangNextLs && args[0] === "ls") { state.hangNextLs = false; return new Promise(() => {}); }
  const answer = hcNow(args);
  await new Promise((r) => setImmediate(r));
  return answer;
}

function hcNow(args) {
  const [cmd, ...rest] = args;
  const ok = (stdout = "") => ({ code: 0, stdout, stderr: "" });
  if (cmd === "ls") return ok(JSON.stringify({ terminals: [...state.terminals].reverse() })); // newest first: the worst case for picking "the new one"
  if (cmd === "get") {
    const t = state.terminals.find((x) => x.address === rest[0]);
    // Unlike `ls`, `get` prints the agent status as an object ({ app, state }) or null; its own `state` is live/exited.
    const status = t?.status ? { app: t.agent ?? "agent", state: t.status } : null;
    return t ? ok(JSON.stringify({ ...t, status, foreground: { name: state.foreground } })) : { code: 3, stdout: "", stderr: "not_found\n" };
  }
  if (cmd === "send") {
    // Like the real hc, a text starting with "-" is read as an option unless it comes after "--".
    const [terminal, ...words] = rest;
    if (words[0] !== "--" && String(words[0] ?? "").startsWith("-")) return { code: 2, stdout: "", stderr: `unknown option ${words[0]}\n` };
    state.sent.push({ terminal, text: words[0] === "--" ? words[1] : words[0] });
    return state.sendFails ? { code: 1, stdout: "", stderr: "send failed\nmore" } : ok("{}");
  }
  if (cmd === "run") {
    state.hcRuns.push({ args });
    if (state.hcRunFails) return { code: 1, stdout: "", stderr: "no such space\nmore" };
    // herdr shows a terminal labeled herdr.space/herdr.tab as that tab in that space
    const label = (k) => args.find((a, i) => args[i - 1] === "--label" && a.startsWith(k + "="))?.slice(k.length + 1);
    if (!state.hcRunHidesTab && label("herdr.space") && label("herdr.tab")) state.labeledTabs.push({ space: label("herdr.space"), tab: label("herdr.tab") });
    return ok(JSON.stringify({ address: `t-run-${state.hcRuns.length}` }));
  }
  return { code: 1, stdout: "", stderr: `unsupported: ${cmd}` };
}

// Same contract as herdr: a missing file reads as null; a write is refused when the file is no longer `expected`.
export async function readTextFile(path) {
  return existsSync(path) ? readFileSync(path, "utf8") : null;
}
export async function writeTextFile(path, text, expected) {
  const now = existsSync(path) ? readFileSync(path, "utf8") : null;
  if (now !== expected) throw new Error("the file changed since it was read");
  mkdirSync(join(path, ".."), { recursive: true });
  writeFileSync(path, text);
  return null;
}

// ---- what the picker's view needs ----
const store = {};
state.known = [{ key: "claude", name: "Claude Code", run: ["claude"], icon: "icons/claude.svg", tint: false, installed: true }];
state.closed = 0;
export const knownAgents = async () => state.known;
export const window = () => { count("window"); return { platform: state.platform ?? "linux" }; };
export const theme = () => { count("theme"); return themeProxy(); };
const themeProxy = () => new Proxy({}, { get: (_t, k) => `#${String(k)}` });
export const props = () => ({ overlay: "ov1" });
export const closeOverlay = () => { state.closed++; };
export const pickFolder = async () => state.picked ?? null;
export const shared = (k) => { count("shared"); return store[k]; };
export const setShared = (k, v) => { store[k] = v; };
