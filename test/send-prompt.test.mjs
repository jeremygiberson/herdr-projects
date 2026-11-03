// The detached helper that types a send-mode prompt once an agent behind a setup chain is ready.
// Plain node: a fake `hc` on PATH and real timing, no stubs.
import test, { beforeEach } from "node:test";
import assert from "node:assert/strict";
import { spawn, execFileSync } from "node:child_process";
import { mkdtempSync, mkdirSync, writeFileSync, readFileSync, existsSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, dirname } from "node:path";
import { fileURLToPath } from "node:url";

const SCRIPT = join(dirname(fileURLToPath(import.meta.url)), "..", "mods", "projects", "bin", "send-prompt.sh");

let tmp, STATE_FILE, SENT_FILE, FG_FILE, promptFile;
beforeEach(() => {
  tmp = mkdtempSync(join(tmpdir(), "pp-send-"));
  mkdirSync(join(tmp, "bin"));
  writeFileSync(join(tmp, "bin", "hc"), `#!/bin/sh
case "$1" in
  get)
    st=$(cat "$STATE_FILE")
    fg=$(cat "$FG_FILE" 2>/dev/null)
    if [ -n "$st" ]; then printf '{"address":"%s","status":"%s","foreground":{"name":"%s"}}\\n' "$2" "$st" "$fg"
    else printf '{"address":"%s","foreground":{"argv":["x"],"name":"%s","pid":1}}\\n' "$2" "$fg"; fi ;;
  send) printf '%s' "$3" >> "$SENT_FILE" ;;
esac
`, { mode: 0o755 });
  STATE_FILE = join(tmp, "state");
  SENT_FILE = join(tmp, "sent");
  FG_FILE = join(tmp, "fg");
  promptFile = join(tmp, "prompt.txt");
});

const run = (timeout) => execFileSync("sh", [SCRIPT, "t1", promptFile, String(timeout)], {
  env: { ...process.env, PATH: `${tmp}/bin:${process.env.PATH}`, STATE_FILE, SENT_FILE, FG_FILE }, encoding: "utf8",
});
const exitCode = (fn) => { try { fn(); return 0; } catch (e) { return e.status; } };

test("send-prompt.sh waits for idle, sends the file's text once, and removes the file", () => {
  writeFileSync(STATE_FILE, "working"); writeFileSync(promptFile, "hello");
  spawn("sh", ["-c", `sleep 3; echo idle > "${STATE_FILE}"`], { detached: true, stdio: "ignore" }).unref();
  run(10);
  assert.equal(readFileSync(SENT_FILE, "utf8"), "hello");
  assert.equal(existsSync(promptFile), false);
});
test("send-prompt.sh gives up on blocked (exit 1) and on timeout (exit 2)", () => {
  writeFileSync(STATE_FILE, "blocked"); writeFileSync(promptFile, "x");
  assert.equal(exitCode(() => run(10)), 1);
  writeFileSync(STATE_FILE, "working");
  assert.equal(exitCode(() => run(3)), 2);
  assert.equal(existsSync(SENT_FILE), false);
});
test("send-prompt.sh sends to a status-less agent once a non-shell program has held the foreground for 6 s, never to a shell", () => {
  writeFileSync(STATE_FILE, ""); writeFileSync(FG_FILE, "hermes"); writeFileSync(promptFile, "hey");
  const started = Date.now();
  run(15);
  const took = Date.now() - started;
  assert.equal(readFileSync(SENT_FILE, "utf8"), "hey");
  assert.ok(took >= 5500 && took < 10000, `took ${took} ms`);
  assert.equal(existsSync(promptFile), false);
  rmSync(SENT_FILE);
  writeFileSync(FG_FILE, "zsh"); writeFileSync(promptFile, "hey");
  assert.equal(exitCode(() => run(8)), 2);
  assert.equal(existsSync(SENT_FILE), false);
});
