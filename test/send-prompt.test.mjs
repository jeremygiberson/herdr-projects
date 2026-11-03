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

let tmp, STATE_FILE, SENT_FILE, FG_FILE, ARGV_FILE, FAIL_FILE, promptFile;
beforeEach(() => {
  tmp = mkdtempSync(join(tmpdir(), "pp-send-"));
  mkdirSync(join(tmp, "bin"));
  // Answers like the real hc: `get --json` prints the agent status as an object ({"app","state"}) or null, beside the
  // terminal's own top-level "state" (live); `send` refuses an option it does not know, so a text starting with "-"
  // must come after "--". FAIL_FILE holds how many more `get` calls fail.
  writeFileSync(join(tmp, "bin", "hc"), `#!/bin/sh
printf '%s\\n' "$*" >> "$ARGV_FILE"
case "$1" in
  get)
    n=$(cat "$FAIL_FILE" 2>/dev/null)
    if [ -n "$n" ] && [ "$n" -gt 0 ]; then echo $((n - 1)) > "$FAIL_FILE"; echo "not_found" >&2; exit 3; fi
    st=$(cat "$STATE_FILE")
    fg=$(cat "$FG_FILE" 2>/dev/null)
    if [ -n "$st" ]; then status='{"app":"x","state":"'"$st"'"}'; else status=null; fi
    printf '{"address":"%s","state":"live","status":%s,"foreground":{"argv":["x"],"name":"%s","pid":1}}\\n' "$2" "$status" "$fg" ;;
  send)
    shift 2
    case "$1" in --) shift ;; -*) echo "unknown option $1" >&2; exit 2 ;; esac
    printf '%s' "$1" >> "$SENT_FILE" ;;
esac
`, { mode: 0o755 });
  STATE_FILE = join(tmp, "state");
  SENT_FILE = join(tmp, "sent");
  FG_FILE = join(tmp, "fg");
  ARGV_FILE = join(tmp, "argv");
  FAIL_FILE = join(tmp, "fail");
  promptFile = join(tmp, "prompt.txt");
});

const run = (timeout, agent = "hermes") => execFileSync("sh", [SCRIPT, "t1", promptFile, agent, String(timeout)], {
  env: { ...process.env, PATH: `${tmp}/bin:${process.env.PATH}`, STATE_FILE, SENT_FILE, FG_FILE, ARGV_FILE, FAIL_FILE }, encoding: "utf8",
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
  assert.equal(existsSync(promptFile), false, "the blocked exit removes the prompt file");
  writeFileSync(STATE_FILE, "working"); writeFileSync(promptFile, "x");
  assert.equal(exitCode(() => run(3)), 2);
  assert.equal(existsSync(promptFile), false, "the timeout exit removes the prompt file");
  assert.equal(existsSync(SENT_FILE), false);
});
test("send-prompt.sh does not treat the terminal's own top-level state as the agent status", () => {
  // "state":"live" sits beside "status":{...}; a working agent must not be sent to, an unknown one resets the wait
  writeFileSync(STATE_FILE, "working"); writeFileSync(FG_FILE, "hermes"); writeFileSync(promptFile, "x");
  assert.equal(exitCode(() => run(8)), 2);
  assert.equal(existsSync(SENT_FILE), false);
});
test("send-prompt.sh sends a prompt starting with - after --", () => {
  writeFileSync(STATE_FILE, "done"); writeFileSync(promptFile, "-x foo");
  run(10);
  assert.equal(readFileSync(SENT_FILE, "utf8"), "-x foo");
  assert.match(readFileSync(ARGV_FILE, "utf8"), /^send t1 -- -x foo$/m);
});
test("send-prompt.sh exits 1 at once on an empty or missing prompt file", () => {
  writeFileSync(STATE_FILE, "idle"); writeFileSync(promptFile, "");
  assert.equal(exitCode(() => run(10)), 1);
  assert.equal(existsSync(SENT_FILE), false);
  assert.equal(existsSync(promptFile), false);
});
test("send-prompt.sh rides out up to 3 failed hc get calls, and exits 1 on the 4th in a row", () => {
  writeFileSync(STATE_FILE, "idle"); writeFileSync(promptFile, "hi"); writeFileSync(FAIL_FILE, "3");
  run(30);
  assert.equal(readFileSync(SENT_FILE, "utf8"), "hi");
  rmSync(SENT_FILE);
  writeFileSync(promptFile, "hi"); writeFileSync(FAIL_FILE, "4");
  assert.equal(exitCode(() => run(30)), 1);
  assert.equal(existsSync(SENT_FILE), false);
  assert.equal(existsSync(promptFile), false);
});
test("send-prompt.sh sends to a status-less agent only once the agent itself has held the foreground for 6 s, never to setup or a shell", () => {
  writeFileSync(STATE_FILE, ""); writeFileSync(FG_FILE, "npm"); writeFileSync(promptFile, "hey");
  // the setup chain (npm) is in front for 4 s, then it execs into hermes
  spawn("sh", ["-c", `sleep 4; echo hermes > "${FG_FILE}"`], { detached: true, stdio: "ignore" }).unref();
  const started = Date.now();
  run(20);
  const took = Date.now() - started;
  assert.equal(readFileSync(SENT_FILE, "utf8"), "hey");
  assert.ok(took >= 9500 && took < 14500, `took ${took} ms`);
  assert.equal(existsSync(promptFile), false);
  rmSync(SENT_FILE);
  writeFileSync(FG_FILE, "zsh"); writeFileSync(promptFile, "hey");
  assert.equal(exitCode(() => run(8)), 2);
  assert.equal(existsSync(SENT_FILE), false);
});
