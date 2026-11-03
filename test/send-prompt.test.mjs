// The detached helper that types a send-mode prompt once an agent behind a setup chain is ready.
// Plain node: a fake `hc` on PATH and real timing, no stubs.
import test, { beforeEach } from "node:test";
import assert from "node:assert/strict";
import { spawn, execFileSync } from "node:child_process";
import { mkdtempSync, mkdirSync, writeFileSync, readFileSync, existsSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, dirname } from "node:path";
import { fileURLToPath } from "node:url";

const SCRIPT = join(dirname(fileURLToPath(import.meta.url)), "..", "mods", "projects", "bin", "send-prompt.sh");

let tmp, STATE_FILE, SENT_FILE, promptFile;
beforeEach(() => {
  tmp = mkdtempSync(join(tmpdir(), "pp-send-"));
  mkdirSync(join(tmp, "bin"));
  writeFileSync(join(tmp, "bin", "hc"), `#!/bin/sh
case "$1" in
  get) printf '{"address":"%s","status":"%s"}\\n' "$2" "$(cat "$STATE_FILE")" ;;
  send) printf '%s' "$3" >> "$SENT_FILE" ;;
esac
`, { mode: 0o755 });
  STATE_FILE = join(tmp, "state");
  SENT_FILE = join(tmp, "sent");
  promptFile = join(tmp, "prompt.txt");
});

const run = (timeout) => execFileSync("sh", [SCRIPT, "t1", promptFile, String(timeout)], {
  env: { ...process.env, PATH: `${tmp}/bin:${process.env.PATH}`, STATE_FILE, SENT_FILE }, encoding: "utf8",
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
