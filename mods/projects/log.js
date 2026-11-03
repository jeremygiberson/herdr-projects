// Troubleshooting log. Errors always go to console.error and ~/.config/herdr-app/data/projects.log.
// `touch ~/.config/herdr-app/data/projects.debug` (then reopen the picker) also logs every
// key, click, git command and step. Remove the file to go quiet again.
import * as fs from "fs/promises";
import { appHome } from "herdr";

const MAX = 64 * 1024;
const dir = () => `${appHome()}/data`;
let debug = false;
let queue = Promise.resolve();

export async function initLog() {
  try { debug = await fs.exists(`${dir()}/projects.debug`); } catch { debug = false; }
  log("debug", "picker opened", { debug });
}

export function log(level, message, data) {
  if (level === "debug" && !debug) return;
  const line = `${new Date().toISOString()} ${level.toUpperCase()} ${message}${data === undefined ? "" : " " + JSON.stringify(data)}`;
  (level === "error" ? console.error : console.log)(`[projects] ${line}`);
  queue = queue.then(async () => {
    const path = `${dir()}/projects.log`;
    let old = "";
    try { old = await fs.readFile(path, "utf8"); } catch {}
    await fs.writeFile(path, (old + line + "\n").slice(-MAX));
  }).catch(() => {});
}

export const logError = (where, e) => log("error", `${where}: ${e?.message ?? e}`, e?.stack ? { stack: String(e.stack).split("\n").slice(0, 4) } : undefined);
