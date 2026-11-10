import assert from "node:assert/strict";
import { writeFileSync } from "node:fs";
import { join } from "node:path";
import { test } from "node:test";

import { readConfig } from "../src/config.mjs";
import { loadPicker } from "../src/model-picker.mjs";
import { createRouter } from "../src/proxy.mjs";
import { temporaryDirectory } from "./helpers.mjs";

/**
 * A router wired to arrays, with the session memory off unless `env` turns it on.
 *
 * @param {NodeJS.ProcessEnv} [env]
 * @param {{ hide?: string[] }} [pickerFile]
 */
function setup(env = {}, pickerFile) {
  const directory = temporaryDirectory();
  const config = readConfig(
    {
      CLAUDE_CONFIG_DIR: directory,
      CLAUDE_ACP_PROXY_STATE_FILE: join(directory, "sessions.json"),
      CLAUDE_ACP_PROXY_SESSION_CONFIG: "0",
      ...env,
    },
    () => {},
  );
  let picker;
  if (pickerFile) {
    const file = join(directory, "picker.json");
    writeFileSync(file, JSON.stringify(pickerFile));
    picker = loadPicker(file);
  }
  /** @type {string[]} */
  const toAdapter = [];
  /** @type {string[]} */
  const toClient = [];
  const router = createRouter({
    config,
    picker,
    toAdapter: (line) => toAdapter.push(line),
    toClient: (line) => toClient.push(line),
  });
  return { router, toAdapter, toClient };
}

test("with nothing that reads it, the adapter's output is not routed", () => {
  assert.equal(setup().router.routesAdapterOutput, false);
  assert.equal(setup({ CLAUDE_ACP_PROXY_SESSION_CONFIG: "1" }).router.routesAdapterOutput, true);
  assert.equal(setup({ CLAUDE_ACP_PROXY_STEERING: "1" }).router.routesAdapterOutput, true);
  assert.equal(setup({}, { hide: [] }).router.routesAdapterOutput, true);
});

test("a line that is not JSON goes through as it is", () => {
  const { router } = setup({ CLAUDE_ACP_PROXY_SESSION_CONFIG: "1" });
  assert.equal(router.fromClient("not json"), "not json");
  assert.equal(router.fromAdapter("not json"), "not json");
});

test("a message that nothing changes keeps its exact text", () => {
  const { router } = setup();
  const line = '{ "jsonrpc": "2.0", "id": 1, "method": "session/prompt", "params": {} }';
  assert.equal(router.fromClient(line), line);
});

test("a request that starts a session gets the setting sources", () => {
  const { router } = setup({ CLAUDE_ACP_PROXY_SETTING_SOURCES: "user,local" });
  const out = router.fromClient(JSON.stringify({ jsonrpc: "2.0", id: 1, method: "session/new", params: {} }));
  assert.ok(out);
  assert.deepEqual(JSON.parse(out).params._meta.claudeCode.options.settingSources, ["user", "local"]);
});

test("with `default` the requests that start a session are left alone", () => {
  const { router } = setup({ CLAUDE_ACP_PROXY_SETTING_SOURCES: "default" });
  const line = JSON.stringify({ jsonrpc: "2.0", id: 1, method: "session/new", params: {} });
  assert.equal(router.fromClient(line), line);
});

test("each message of a batch is rewritten, and the batch stays a batch", () => {
  const { router } = setup();
  const batch = [
    { jsonrpc: "2.0", id: 1, method: "session/new", params: {} },
    { jsonrpc: "2.0", id: 2, method: "session/prompt", params: { sessionId: "S" } },
  ];
  const out = router.fromClient(JSON.stringify(batch));
  assert.ok(out);
  const parsed = JSON.parse(out);
  assert.equal(parsed.length, 2);
  assert.deepEqual(parsed[0].params._meta.claudeCode.options.settingSources, ["user"]);
  assert.deepEqual(parsed[1], batch[1]);
});

test("the picker changes the option lists that the adapter sends", () => {
  const { router } = setup({}, { hide: ["^haiku$"] });
  const reply = {
    jsonrpc: "2.0",
    id: 1,
    result: {
      configOptions: [{ id: "model", currentValue: "opus", options: [{ value: "opus" }, { value: "haiku" }] }],
    },
  };
  const out = router.fromAdapter(JSON.stringify(reply));
  assert.ok(out);
  assert.deepEqual(
    JSON.parse(out).result.configOptions[0].options.map((/** @type {any} */ option) => option.value),
    ["opus"],
  );
});

/**
 * A `session/update` notification whose update carries a model option list with a hidden model.
 *
 * @param {string} sessionUpdate
 */
const updateWithModels = (sessionUpdate) =>
  JSON.stringify({
    jsonrpc: "2.0",
    method: "session/update",
    params: {
      sessionId: "S",
      update: {
        sessionUpdate,
        configOptions: [{ id: "model", currentValue: "opus", options: [{ value: "opus" }, { value: "haiku" }] }],
      },
    },
  });

test("streamed updates other than option updates are passed on without being looked at", () => {
  const { router } = setup({}, { hide: ["^haiku$"] });
  const line = updateWithModels("agent_message_chunk");
  assert.equal(router.fromAdapter(line), line);
});

test("an option update goes through the picker", () => {
  const { router } = setup({}, { hide: ["^haiku$"] });
  const out = router.fromAdapter(updateWithModels("config_option_update"));
  assert.ok(out);
  assert.deepEqual(
    JSON.parse(out).params.update.configOptions[0].options.map((/** @type {any} */ option) => option.value),
    ["opus"],
  );
});
