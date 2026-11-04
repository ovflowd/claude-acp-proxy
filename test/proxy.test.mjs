import assert from "node:assert/strict";
import { spawn, spawnSync } from "node:child_process";
import { existsSync, mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";
import { createInterface } from "node:readline";
import { fileURLToPath } from "node:url";

const root = fileURLToPath(new URL("..", import.meta.url));
const adapter =
  "adapter/node_modules/@agentclientprotocol/claude-agent-acp/dist/index.js";
const installed = existsSync(join(root, adapter));

// The environment of the test run, without settings of the developer's own.
function cleanEnv() {
  const env = { ...process.env };
  for (const name of Object.keys(env)) {
    if (name.startsWith("CLAUDE_ACP_PROXY_")) delete env[name];
  }
  delete env.XDG_STATE_HOME;
  return env;
}

// Starts the proxy, sends `initialize`, and returns the response and the exit code.
function initialize(env) {
  const configDir = mkdtempSync(join(tmpdir(), "acp-proxy-"));
  return new Promise((resolve, reject) => {
    const child = spawn(process.execPath, [join(root, "proxy.mjs")], {
      env: { ...cleanEnv(), CLAUDE_CONFIG_DIR: configDir, ...env },
      stdio: ["pipe", "pipe", "ignore"],
    });
    const timer = setTimeout(
      () => (child.kill(), reject(new Error("timed out"))),
      30_000,
    );
    let response;
    createInterface({ input: child.stdout }).on("line", (line) => {
      response = JSON.parse(line);
      child.stdin.end();
    });
    child.on("exit", (code) => {
      clearTimeout(timer);
      rmSync(configDir, { recursive: true, force: true });
      resolve({ response, code });
    });
    const request = {
      jsonrpc: "2.0",
      id: 1,
      method: "initialize",
      params: { protocolVersion: 1 },
    };
    child.stdin.write(`${JSON.stringify(request)}\n`);
  });
}

const options = { skip: installed ? false : "run `npm ci` in adapter/ first" };

test(
  "the proxy answers initialize and exits when the client closes",
  options,
  async () => {
    const { response, code } = await initialize({});
    assert.equal(response.result.agentCapabilities.loadSession, true);
    assert.equal(code, 0);
  },
);

test(
  "with the session memory off the adapter's stdout is passed through",
  options,
  async () => {
    const { response, code } = await initialize({
      CLAUDE_ACP_PROXY_SESSION_CONFIG: "0",
    });
    assert.equal(response.result.agentCapabilities.loadSession, true);
    assert.equal(code, 0);
  },
);

test("an unusable picker file stops the proxy with a reason", options, async () => {
  const configDir = mkdtempSync(join(tmpdir(), "acp-proxy-"));
  const result = spawnSync(process.execPath, [join(root, "proxy.mjs")], {
    env: {
      ...cleanEnv(),
      CLAUDE_CONFIG_DIR: configDir,
      CLAUDE_ACP_PROXY_PICKER: "/nope",
    },
    encoding: "utf8",
    input: "",
  });
  rmSync(configDir, { recursive: true, force: true });
  assert.equal(result.status, 1);
  assert.match(result.stderr, /CLAUDE_ACP_PROXY_PICKER/);
});
