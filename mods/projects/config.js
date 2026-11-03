// The project list: ~/.config/herdr-app/data/projects.json, hand-editable.
import { readTextFile, writeTextFile, appHome } from "herdr";
import { normalize } from "./lib.js";

export const dataFilePath = () => `${appHome()}/data/projects.json`;

/** { projects, raw }: raw is the file as read, handed back to saveConfig so a
 *  hand edit made in between is refused instead of overwritten. */
export async function loadConfig() {
  const raw = await readTextFile(dataFilePath());
  if (raw == null) return { projects: [], layouts: [], gitInfo: true, hideTemplate: false, autoLayouts: [], defaultAgent: null, raw: null };
  try {
    const data = JSON.parse(raw);
    const layouts = Array.isArray(data.layouts) ? data.layouts : [];
    const autoLayouts = (Array.isArray(data.autoLayouts) ? data.autoLayouts : [])
      .filter((e) => e && typeof e === "object")
      .map((e) => ({ repo: String(e.repo ?? "*").trim() || "*", branch: String(e.branch ?? "").trim(), layout: String(e.layout ?? "").trim() }))
      .filter((e) => e.layout);
    const da = data.defaultAgent;
    const defaultAgent = da && typeof da === "object" && String(da.agent ?? "").trim() ? { agent: String(da.agent).trim(), args: String(da.args ?? "") } : null;
    return { projects: (data.projects ?? []).map((p) => normalize(p, layouts)), layouts, gitInfo: data.gitInfo !== false, hideTemplate: data.hideTemplate === true, autoLayouts, defaultAgent, raw };
  } catch (e) {
    throw new Error(`${dataFilePath()} is not valid JSON: ${e.message}`);
  }
}

/** `extra` sets other top-level keys (for instance `hideTemplate`, `autoLayouts`, `defaultAgent`); everything else already in the file is kept. */
export async function saveConfig(projects, raw, extra = {}) {
  // Everything else in the file (the layouts, a hand-added key) is kept as it is.
  let rest = {};
  try { rest = JSON.parse(raw ?? "{}"); } catch {}
  const text = JSON.stringify({ ...rest, ...extra, projects }, null, 2) + "\n";
  await writeTextFile(dataFilePath(), text, raw);
  return text;
}
