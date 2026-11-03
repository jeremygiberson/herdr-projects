// New-worktree setup: copying gitignored files from the main checkout, and the "setup done" marker.
import { exec, readTextFile, writeTextFile } from "herdr";
import { log as writeLog } from "./log.js";
import { expand } from "./lib.js";

export const MARKER = ".projects-setup-done";
export const markerPath = (folder) => `${folder}/${MARKER}`;

/** True when the folder has no marker yet, so its setup has not run. */
export async function isNewWorktree(folder) {
  return (await exec("test", ["-e", markerPath(folder)])).code !== 0;
}

/** Adds the marker to the checkout's own git exclude file (once). Resolves to the file path, or null; never throws. */
export async function excludeMarker(folder) {
  let path = null;
  try {
    const r = await exec("git", ["-C", folder, "rev-parse", "--git-path", "info/exclude"]);
    if (r.code !== 0) throw new Error(r.stderr.split("\n")[0] || "git rev-parse failed");
    const p = r.stdout.trim();
    path = p.startsWith("/") ? p : `${folder}/${p}`;
    const old = await readTextFile(path);
    const text = old ?? "";
    if (!text.split("\n").includes(MARKER)) {
      await writeTextFile(path, text + (text && !text.endsWith("\n") ? "\n" : "") + MARKER + "\n", old);
    }
  } catch (e) {
    writeLog("error", `could not exclude ${MARKER} in ${folder}: ${e.message}`);
  }
  return path;
}

const SCRIPT = `main=$1; dest=$2; shift 2
cd "$main" || exit 1
for pat in "$@"; do
  found=0
  for f in $pat; do
    [ -e "$f" ] || continue
    found=1
    if [ -e "$dest/$f" ]; then echo "skipped $f"; continue; fi
    mkdir -p "$dest/$(dirname "$f")" && cp -R "$f" "$dest/$f" && echo "copied $f" || echo "failed $f"
  done
  [ "$found" = 1 ] || echo "missing $pat"
done
`;

const plural = (n, one, many) => `${n} ${n === 1 ? one : many}`;

/** Copies the files matching `patterns` (globs relative to `main`, {vars} expanded) to the same paths under `dest`.
 *  Existing destinations are skipped. `log` gets one summary line. */
export async function copyInto({ main, dest, patterns, vars, log }) {
  const result = { copied: [], skipped: [], missing: [] };
  if (patterns.length) {
    const r = await exec("sh", ["-c", SCRIPT, "sh", main, dest, ...patterns.map((p) => expand(p, vars))]);
    for (const line of r.stdout.split("\n")) {
      const i = line.indexOf(" ");
      if (i < 0) continue;
      const word = line.slice(0, i), rest = line.slice(i + 1);
      if (word === "failed") log(`could not copy ${rest}`);
      else if (word in result || word === "missing") (word === "missing" ? result.missing : result[word]).push(rest);
    }
  }
  const parts = [];
  if (result.copied.length) parts.push(`copied ${plural(result.copied.length, "file", "files")}`);
  if (result.skipped.length) parts.push(`skipped ${result.skipped.length} existing`);
  if (result.missing.length) parts.push(`${plural(result.missing.length, "pattern", "patterns")} matched nothing`);
  log(parts.join(", ") || "copied nothing");
  return result;
}
