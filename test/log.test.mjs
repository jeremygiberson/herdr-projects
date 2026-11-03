import "./helpers/setup.mjs";
import test from "node:test";
import assert from "node:assert/strict";
import { readFileSync, existsSync, mkdirSync } from "node:fs";

const { state } = await import("./helpers/herdr-stub.mjs");
const { log, logError, initLog } = await import("../mods/projects/log.js");
const file = `${state.appHome}/data/projects.log`;
mkdirSync(`${state.appHome}/data`, { recursive: true });

const settle = async (check) => {
  for (let i = 0; i < 100; i++) { if (check()) return; await new Promise((r) => setTimeout(r, 20)); }
};
const text = () => (existsSync(file) ? readFileSync(file, "utf8") : "");

test("errors are written to the log file", async () => {
  log("error", "boom", { a: 1 });
  await settle(() => text().includes("boom"));
  assert.match(text(), /ERROR boom \{"a":1\}/);
});

test("debug lines are dropped while debug is off", async () => {
  await initLog();
  log("debug", "quiet");
  log("error", "marker");
  await settle(() => text().includes("marker"));
  assert.ok(!text().includes("quiet"));
});

test("logError records the message and the top of the stack", async () => {
  logError("save", new Error("disk full"));
  await settle(() => text().includes("disk full"));
  assert.match(text(), /ERROR save: disk full/);
  assert.match(text(), /stack/);
});

test("only the last 64 KB are kept", async () => {
  for (let i = 0; i < 700; i++) log("error", `line ${i} ${"x".repeat(100)}`);
  await settle(() => text().includes("line 699"));
  assert.ok(text().length <= 64 * 1024);
  assert.ok(!text().includes("line 0 "));
});
