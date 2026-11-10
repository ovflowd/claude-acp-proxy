import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { after } from "node:test";
import { fileURLToPath } from "node:url";

import { resolveAdapter } from "../src/proxy.mjs";

export const root = fileURLToPath(new URL("..", import.meta.url));

/** The options of a test that runs the real adapter: it is skipped when the adapter is not installed. */
export const needsAdapter = { skip: resolveAdapter() ? false : "run `npm ci` first" };

/** @type {string[]} */
const directories = [];
after(() => {
  for (const directory of directories) rmSync(directory, { recursive: true, force: true });
});

/**
 * A new empty directory, removed when the file's tests are done.
 *
 * @param {string} [prefix]
 */
export function temporaryDirectory(prefix = "claude-acp-proxy-") {
  const directory = mkdtempSync(join(tmpdir(), prefix));
  directories.push(directory);
  return directory;
}

/** The environment of the test run, without the developer's own proxy settings. */
export function cleanEnv() {
  const env = { ...process.env };
  for (const name of Object.keys(env)) {
    if (name.startsWith("CLAUDE_ACP_PROXY_")) delete env[name];
  }
  delete env.XDG_STATE_HOME;
  return env;
}
