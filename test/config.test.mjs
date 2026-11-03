import "./helpers/setup.mjs";
import test from "node:test";
import assert from "node:assert/strict";
import { mkdirSync, writeFileSync, readFileSync, rmSync } from "node:fs";

const { state, reset } = await import("./helpers/herdr-stub.mjs");
const { loadConfig, saveConfig } = await import("../mods/projects/config.js");
const file = `${state.appHome}/data/projects.json`;

test("a missing file is an empty list", async () => {
  reset();
  assert.deepEqual(await loadConfig(), { projects: [], layouts: [], gitInfo: true, hideTemplate: false, autoLayouts: [], defaultAgent: null, raw: null });
});

test("save then load round-trips and fills defaults", async () => {
  const { raw } = await loadConfig();
  const text = await saveConfig([{ name: "api", path: "/r/api" }], raw);
  assert.equal(readFileSync(file, "utf8"), text);
  const loaded = await loadConfig();
  assert.equal(loaded.raw, text);
  assert.equal(loaded.projects[0].name, "api");
  assert.equal(loaded.projects[0].git.base, "main");
});

test("a hand edit between load and save is refused", async () => {
  const { raw, projects } = await loadConfig();
  writeFileSync(file, JSON.stringify({ projects: [] }));
  await assert.rejects(saveConfig(projects, raw), /changed/);
});

test("invalid JSON names the file", async () => {
  mkdirSync(`${state.appHome}/data`, { recursive: true });
  writeFileSync(file, "{ nope");
  await assert.rejects(loadConfig(), /projects\.json is not valid JSON/);
});

test("a file without a projects key is an empty list", async () => {
  writeFileSync(file, "{}");
  assert.deepEqual((await loadConfig()).projects, []);
});

test("layouts are loaded, and saving projects keeps them and other keys", async () => {
  const layouts = [{ name: "dev", panes: [{ type: "agent" }] }];
  writeFileSync(file, JSON.stringify({ note: "hi", layouts, projects: [] }));
  const loaded = await loadConfig();
  assert.deepEqual(loaded.layouts, layouts);
  await saveConfig([{ name: "api", path: "/r/api" }], loaded.raw);
  const data = JSON.parse(readFileSync(file, "utf8"));
  assert.deepEqual(data.layouts, layouts);
  assert.equal(data.note, "hi");
  assert.equal(data.projects[0].name, "api");
});

test("a missing or malformed layouts key is an empty list", async () => {
  writeFileSync(file, JSON.stringify({ layouts: "nope", projects: [] }));
  assert.deepEqual((await loadConfig()).layouts, []);
  rmSync(file);
  assert.deepEqual((await loadConfig()).layouts, []);
});

test("git details are on unless the data file says gitInfo: false", async () => {
  writeFileSync(file, JSON.stringify({ projects: [] }));
  assert.equal((await loadConfig()).gitInfo, true);
  writeFileSync(file, JSON.stringify({ projects: [], gitInfo: 0 }));
  assert.equal((await loadConfig()).gitInfo, true, "only the value false turns them off");
  writeFileSync(file, JSON.stringify({ projects: [], gitInfo: false }));
  assert.equal((await loadConfig()).gitInfo, false);
  const { raw, projects } = await loadConfig();
  await saveConfig(projects, raw);
  assert.equal(JSON.parse(readFileSync(file, "utf8")).gitInfo, false, "saving keeps it");
});

test("hideTemplate is read only when it is true, and saveConfig can set it while keeping everything else", async () => {
  writeFileSync(file, JSON.stringify({ projects: [], hideTemplate: "yes" }));
  assert.equal((await loadConfig()).hideTemplate, false);
  writeFileSync(file, JSON.stringify({ note: "keep", layouts: [{ name: "a", panes: [] }], projects: [] }));
  const { raw, projects } = await loadConfig();
  await saveConfig(projects, raw, { hideTemplate: true });
  const data = JSON.parse(readFileSync(file, "utf8"));
  assert.equal(data.hideTemplate, true);
  assert.equal(data.note, "keep");
  assert.equal(data.layouts[0].name, "a");
  assert.equal((await loadConfig()).hideTemplate, true);
});

test("loadConfig hands the file's layouts to normalize, so a legacy layout name expands", async () => {
  mkdirSync(`${state.appHome}/data`, { recursive: true });
  writeFileSync(`${state.appHome}/data/projects.json`, JSON.stringify({ layouts: [{ name: "mine", panes: [{ type: "agent" }, { type: "shell", direction: "right" }] }], projects: [{ name: "a", path: "/a", startup: { agent: "claude", layout: "mine" } }] }));
  const c = await loadConfig();
  assert.equal(c.projects[0].startup.tabs[0].panes.length, 2);
});

test("loadConfig reads autoLayouts and defaultAgent with defaults, and saveConfig keeps them", async () => {
  writeFileSync(file, JSON.stringify({ projects: [], autoLayouts: [{ layout: "x" }, { repo: " api ", branch: "main", layout: "y" }, { repo: "z" }], defaultAgent: { agent: "claude" } }));
  const loaded = await loadConfig();
  assert.deepEqual(loaded.autoLayouts, [{ repo: "*", branch: "", layout: "x" }, { repo: "api", branch: "main", layout: "y" }]);
  assert.deepEqual(loaded.defaultAgent, { agent: "claude", args: "" });
  await saveConfig([{ name: "api", path: "/r/api" }], loaded.raw);
  const data = JSON.parse(readFileSync(file, "utf8"));
  assert.equal(data.autoLayouts.length, 3);
  assert.equal(data.defaultAgent.agent, "claude");
  writeFileSync(file, JSON.stringify({ projects: [], defaultAgent: { agent: "" } }));
  const bare = await loadConfig();
  assert.deepEqual([bare.autoLayouts, bare.defaultAgent], [[], null]);
});
