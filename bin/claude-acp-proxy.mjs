#!/usr/bin/env node
// The command that the editor runs as its agent. docs/configuration.md lists the variables it reads.
import * as nodeModule from "node:module";
import { fileURLToPath } from "node:url";

import { readConfig } from "../src/config.mjs";
import { loadPicker } from "../src/model-picker.mjs";
import { resolveAdapter, startProxy } from "../src/proxy.mjs";

if (typeof nodeModule.registerHooks !== "function") {
  fail(`needs Node 22.15 or later (23.5 on Node 23), this is ${process.version}`);
}

const adapter = resolveAdapter();
if (!adapter) {
  const root = fileURLToPath(new URL("..", import.meta.url));
  fail(`the adapter is not installed. Run "npm ci --omit=dev" in ${root}`);
}

const config = readConfig();
let picker;
if (config.picker) {
  try {
    picker = loadPicker(config.picker);
  } catch (error) {
    fail(`cannot use CLAUDE_ACP_PROXY_PICKER: ${error instanceof Error ? error.message : error}`);
  }
}

startProxy({ adapter, config, picker, args: process.argv.slice(2) });

/**
 * @param {string} problem
 * @returns {never}
 */
function fail(problem) {
  console.error(`claude-acp-proxy: ${problem}`);
  process.exit(1);
}
