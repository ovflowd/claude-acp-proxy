import { homedir } from "node:os";
import { join } from "node:path";

import { logProblem } from "./log.mjs";

/** @typedef {"user" | "project" | "local"} SettingSource */

/** @type {readonly SettingSource[]} */
const SETTING_SOURCES = ["user", "project", "local"];

/**
 * What the proxy is set to, read from the agent's environment. docs/configuration.md describes each variable.
 *
 * @typedef {object} Config
 * @property {SettingSource[] | undefined} settingSources Undefined leaves the choice to the adapter.
 * @property {string | undefined} picker
 * @property {boolean} steering
 * @property {boolean} remoteControl
 * @property {boolean} fullHistory
 * @property {boolean} sessionConfig
 * @property {string} stateFile
 * @property {string} claudeConfigDir
 */

/**
 * @param {NodeJS.ProcessEnv} [env]
 * @param {(problem: string) => void} [warn] Told about a value that is ignored.
 * @returns {Config}
 */
export function readConfig(env = process.env, warn = (problem) => logProblem("configuration", problem)) {
  const state = env.XDG_STATE_HOME || join(homedir(), ".local", "state");
  return {
    settingSources: parseSettingSources(env.CLAUDE_ACP_PROXY_SETTING_SOURCES, warn),
    picker: env.CLAUDE_ACP_PROXY_PICKER || undefined,
    steering: env.CLAUDE_ACP_PROXY_STEERING === "1",
    remoteControl: env.CLAUDE_ACP_PROXY_REMOTE_CONTROL === "1",
    fullHistory: env.CLAUDE_ACP_PROXY_FULL_HISTORY !== "0",
    sessionConfig: env.CLAUDE_ACP_PROXY_SESSION_CONFIG !== "0",
    stateFile: env.CLAUDE_ACP_PROXY_STATE_FILE || join(state, "claude-acp-proxy", "sessions.json"),
    claudeConfigDir: env.CLAUDE_CONFIG_DIR ?? join(homedir(), ".claude"),
  };
}

/**
 * @param {string | undefined} value
 * @param {(problem: string) => void} warn
 * @returns {SettingSource[] | undefined}
 */
function parseSettingSources(value, warn) {
  if (value === undefined) return ["user"];
  if (value === "default") return undefined;
  const sources = value.split(",").map((source) => source.trim());
  if (sources.every(isSettingSource)) return sources;
  warn(`ignoring CLAUDE_ACP_PROXY_SETTING_SOURCES=${value}, using "user"`);
  return ["user"];
}

/**
 * @param {string} value
 * @returns {value is SettingSource}
 */
function isSettingSource(value) {
  return SETTING_SOURCES.some((source) => source === value);
}
