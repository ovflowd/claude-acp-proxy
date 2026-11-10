import assert from "node:assert/strict";
import { spawn, spawnSync } from "node:child_process";
import { join } from "node:path";
import { createInterface } from "node:readline";
import { test } from "node:test";

import { cleanEnv, needsAdapter, root, temporaryDirectory } from "./helpers.mjs";

const BIN = join(root, "bin", "claude-acp-proxy.mjs");

/** @param {NodeJS.ProcessEnv} env */
function proxyEnv(env) {
  const configDir = temporaryDirectory();
  return {
    ...cleanEnv(),
    CLAUDE_CONFIG_DIR: configDir,
    CLAUDE_ACP_PROXY_STATE_FILE: join(configDir, "sessions.json"),
    ...env,
  };
}

/**
 * Starts the proxy, sends `initialize`, and returns the response and the exit code.
 *
 * @param {NodeJS.ProcessEnv} env
 * @returns {Promise<{ response: any, code: number | null }>}
 */
function initialize(env) {
  return new Promise((resolve, reject) => {
    // In a group of its own: the adapter starts helpers that outlive the proxy, and would write to the profile
    // after the test removed it.
    const child = spawn(process.execPath, [BIN], {
      env: proxyEnv(env),
      stdio: ["pipe", "pipe", "ignore"],
      detached: true,
    });
    const timer = setTimeout(() => {
      child.kill();
      reject(new Error("timed out"));
    }, 30_000);
    /** @type {any} */
    let response;
    createInterface({ input: child.stdout }).on("line", (line) => {
      response = JSON.parse(line);
      child.stdin.end();
    });
    child.on("exit", (code) => {
      clearTimeout(timer);
      try {
        if (child.pid !== undefined) process.kill(-child.pid, "SIGKILL");
      } catch {
        // The group is gone already.
      }
      resolve({ response, code });
    });
    const request = { jsonrpc: "2.0", id: 1, method: "initialize", params: { protocolVersion: 1 } };
    child.stdin.write(`${JSON.stringify(request)}\n`);
  });
}

test("the proxy answers initialize and exits when the client closes", needsAdapter, async () => {
  const { response, code } = await initialize({});
  assert.equal(response.result.agentCapabilities.loadSession, true);
  assert.equal(code, 0);
});

test("with the session memory off the adapter's stdout is passed through", needsAdapter, async () => {
  const { response, code } = await initialize({ CLAUDE_ACP_PROXY_SESSION_CONFIG: "0" });
  assert.equal(response.result.agentCapabilities.loadSession, true);
  assert.equal(code, 0);
});

test("an unusable picker file stops the proxy with a reason", needsAdapter, () => {
  const result = spawnSync(process.execPath, [BIN], {
    env: proxyEnv({ CLAUDE_ACP_PROXY_PICKER: "/nope" }),
    encoding: "utf8",
    input: "",
  });
  assert.equal(result.status, 1);
  assert.match(result.stderr, /CLAUDE_ACP_PROXY_PICKER/);
});
