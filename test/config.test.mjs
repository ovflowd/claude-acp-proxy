import assert from "node:assert/strict";
import { test } from "node:test";

import { readConfig } from "../src/config.mjs";

/**
 * @param {NodeJS.ProcessEnv} env
 */
function read(env) {
  /** @type {string[]} */
  const warnings = [];
  const config = readConfig({ HOME: "/home/you", ...env }, (problem) => warnings.push(problem));
  return { config, warnings };
}

test("the defaults are the safe ones", () => {
  const { config, warnings } = read({});
  assert.deepEqual(config.settingSources, ["user"]);
  assert.equal(config.picker, undefined);
  assert.equal(config.steering, false);
  assert.equal(config.remoteControl, false);
  assert.equal(config.fullHistory, true);
  assert.equal(config.sessionConfig, true);
  assert.deepEqual(warnings, []);
});

test("a list of sources is taken as it is, with spaces trimmed", () => {
  assert.deepEqual(read({ CLAUDE_ACP_PROXY_SETTING_SOURCES: "user,project" }).config.settingSources, [
    "user",
    "project",
  ]);
  assert.deepEqual(read({ CLAUDE_ACP_PROXY_SETTING_SOURCES: " user , local " }).config.settingSources, [
    "user",
    "local",
  ]);
  assert.deepEqual(read({ CLAUDE_ACP_PROXY_SETTING_SOURCES: "project,local,user" }).config.settingSources, [
    "project",
    "local",
    "user",
  ]);
});

test("`default` leaves the choice of sources to the adapter", () => {
  assert.equal(read({ CLAUDE_ACP_PROXY_SETTING_SOURCES: "default" }).config.settingSources, undefined);
});

test("invalid sources fall back to the user settings and say so", () => {
  for (const value of ["", "User", "everything", "user,", "user;project"]) {
    const { config, warnings } = read({ CLAUDE_ACP_PROXY_SETTING_SOURCES: value });
    assert.deepEqual(config.settingSources, ["user"], JSON.stringify(value));
    assert.equal(warnings.length, 1, JSON.stringify(value));
  }
});

test("only the documented values turn a feature on or off", () => {
  const on = read({
    CLAUDE_ACP_PROXY_STEERING: "1",
    CLAUDE_ACP_PROXY_REMOTE_CONTROL: "1",
    CLAUDE_ACP_PROXY_FULL_HISTORY: "0",
    CLAUDE_ACP_PROXY_SESSION_CONFIG: "0",
  }).config;
  assert.deepEqual([on.steering, on.remoteControl, on.fullHistory, on.sessionConfig], [true, true, false, false]);

  const other = read({
    CLAUDE_ACP_PROXY_STEERING: "true",
    CLAUDE_ACP_PROXY_REMOTE_CONTROL: "yes",
    CLAUDE_ACP_PROXY_FULL_HISTORY: "false",
    CLAUDE_ACP_PROXY_SESSION_CONFIG: "off",
  }).config;
  assert.deepEqual(
    [other.steering, other.remoteControl, other.fullHistory, other.sessionConfig],
    [false, false, true, true],
  );
});

test("the state file follows XDG_STATE_HOME unless it is set", () => {
  assert.equal(read({ XDG_STATE_HOME: "/state" }).config.stateFile, "/state/claude-acp-proxy/sessions.json");
  assert.equal(
    read({ XDG_STATE_HOME: "/state", CLAUDE_ACP_PROXY_STATE_FILE: "/elsewhere.json" }).config.stateFile,
    "/elsewhere.json",
  );
});

test("the transcripts are read from CLAUDE_CONFIG_DIR", () => {
  assert.equal(read({ CLAUDE_CONFIG_DIR: "/profile" }).config.claudeConfigDir, "/profile");
});
