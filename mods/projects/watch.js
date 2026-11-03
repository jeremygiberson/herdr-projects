// The resident watcher: the copy of the mod kept in the layout notices a space opened outside the picker (the
// app's New worktree, the new-space shortcut) on an auto-layout project's checkout or worktree, or on a repo an
// `autoLayouts` entry names, and builds the tabs into it. A space is considered once, when it first appears.
import { spaces, agents, panes, shared, home, notify } from "herdr";
import { projectFolder, inspect } from "./git.js";
import { matchAutoLayout, tabsForAuto, blankProject, basename, repoNameFromKey } from "./lib.js";

const OPENING = "projects.opening"; // { [folder]: when the picker started opening it }, written by buildWorkspace
const OPENING_MS = 60000;
const TICK_MS = 2000;

// Builds run one after another, so two spaces appearing together never interleave.
let queue = Promise.resolve();

export class Watcher {
  /** The functions are injected (main.js passes the real ones, tests fakes); `log(level, message, data)` is log.js's. */
  constructor({ loadConfig, prepareSetup, buildWorkspace, repoKey, branchOf, realPath, log }) {
    Object.assign(this, { loadConfig, prepareSetup, buildWorkspace, repoKey, branchOf, realPath, log });
    this.seen = new Set();
    this.configWarned = false; // a bad data file is toasted once, then only logged
  }

  /** Every space open now counts as seen and is never acted on; only later ones are. */
  start(cx) {
    this.seen = new Set(spaces().map((s) => s.id));
    this.log("debug", "watcher started", { seen: [...this.seen] });
    cx.timer.every(TICK_MS, (cx) => this.tick(cx));
  }

  /** Queues each space not seen before, as it is now (its folder is read here, once). Never waits. */
  tick(cx) {
    for (const space of spaces()) {
      if (this.seen.has(space.id)) continue;
      this.seen.add(space.id);
      const job = queue.then(() => this.consider(space));
      queue = job.catch(() => {});
      cx.spawn(() => job);
    }
  }

  /** Sets up a new space when it is a local one-tab one-pane space at a shell or an agent, the picker isn't opening
   *  it, and its folder is an auto-layout project's checkout or worktree or a repo an autoLayouts entry names.
   *  Anything else is left alone (logged at debug). Never throws; a failure is logged and toasted. */
  async consider(space) {
    const skip = (why) => this.log("debug", `watcher: left alone, ${why}`, { space: space.id, folder: space.folder });
    if (space.machine !== null) return skip("on another machine");
    if (space.tabs?.length !== 1 || space.tabs[0].panes !== 1) return skip("not one tab with one pane");
    const at = shared(OPENING)?.[space.folder];
    if (at && Date.now() - at < OPENING_MS) return skip("the picker is opening it");
    const agent = agents().find((a) => a.space === space.id);
    const pane = panes().find((p) => p.tab === space.tabs[0].id);
    if (!agent && !pane?.program?.shell) return skip("its pane runs neither a shell nor an agent");

    try {
      const key = await this.repoKey(space.folder);
      if (!key) return skip("not in a git repo");
      // A space in a subfolder of a checkout is that checkout: its top level is the folder set up and built.
      const top = await this.realPath((await inspect(space.folder)).top);
      let config;
      try { config = await this.loadConfig(); } catch (e) {
        this.log("error", `watcher: couldn't read the projects file: ${e?.message ?? e}`, { space: space.id });
        if (!this.configWarned) notify({ title: "Projects", body: `auto-layout is off until the projects file reads: ${e?.message ?? e}`, level: "error" });
        this.configWarned = true;
        return;
      }
      const keys = new Map();
      const keyOf = async (folder) => { if (!keys.has(folder)) keys.set(folder, await this.repoKey(folder)); return keys.get(folder); };
      let project = null;
      for (const p of config.projects) {
        if (p.worktree.autoLayout && !p.template && (await keyOf(projectFolder(p))) === key) { project = p; break; }
      }
      const branch = await this.branchOf(space.folder);
      let entry = null, repo, isWorktree;
      if (project) {
        const main = projectFolder(project);
        repo = basename(main);
        isWorktree = top !== (await this.realPath(main));
      } else {
        repo = repoNameFromKey(key, top);
        entry = matchAutoLayout(config.autoLayouts, repo, branch);
        if (!entry) return skip("no auto-layout project or entry for its repo");
        // A main checkout's common dir is its own .git; a linked worktree's is the main checkout's.
        isWorktree = `${top}/.git` !== key;
      }

      const base = project ?? blankProject(top);
      const tabs = tabsForAuto({ project, layouts: config.layouts, entry, defaultAgent: config.defaultAgent });
      const say = (m) => this.log("debug", m);
      // quickSetup means "run setup inline on the picker's busy screen"; there is no such screen here, so for a
      // quickSetup project the chain runs the steps (in the setup tab or before the agent) and touches the marker.
      const forSetup = base.startup.quickSetup ? { ...base, startup: { ...base.startup, quickSetup: false } } : base;
      const { chain } = await this.prepareSetup({ project: forSetup, folder: top, isWorktree, branch, repo, home: home(), log: say });
      this.log("debug", "watcher: setting up", { space: space.id, folder: space.folder, project: project?.name ?? null, layout: entry?.layout ?? null, agent: Boolean(agent) });
      await this.buildWorkspace({
        project: base, folder: top, name: space.name, tabs, prompt: "",
        agentTiming: project?.startup.agentTiming ?? "with", chain, log: say,
        existing: {
          space: space.id, tab: space.tabs[0].id,
          pane: pane?.pane ?? agent.pane, terminal: pane?.terminal ?? agent.address,
          folder: space.folder, agent: Boolean(agent),
        },
      });
      notify({ title: "Projects", body: `${project?.name ?? entry.layout} set up in ${space.name}` });
    } catch (e) {
      this.log("error", `watcher: couldn't set up ${space.name}: ${e?.message ?? e}`, { space: space.id, folder: space.folder });
      notify({ title: "Projects", body: `couldn't set up ${space.name}: ${e?.message ?? e}`, level: "error" });
    }
  }
}
