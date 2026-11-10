import assert from "node:assert/strict";
import { readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { test } from "node:test";

import { SessionConfigMemory } from "../src/session-config.mjs";
import { temporaryDirectory } from "./helpers.mjs";

function stateFile() {
  return join(temporaryDirectory(), "sessions.json");
}

function options(current = {}) {
  const select = (id, value, values) => ({
    id,
    type: "select",
    currentValue: current[id] ?? value,
    options: values.map((v) => ({ value: v })),
  });
  return [
    select("mode", "auto", ["auto", "plan"]),
    select("model", "sonnet", ["sonnet", "opus"]),
    select("effort", "high", ["high", "xhigh"]),
  ];
}

const loadResponse = (id) => ({
  jsonrpc: "2.0",
  id,
  result: { configOptions: options(), modes: { currentModeId: "auto" } },
});

// A memory wired to a mock adapter that answers each restore request.
function harness(file, { silent = false, throwOnForward = false } = {}) {
  const state = { sent: [], forwarded: [], current: {} };
  let answered;
  state.answered = new Promise((resolve) => (answered = resolve));
  const memory = new SessionConfigMemory({
    file,
    send(message) {
      state.sent.push(message);
      if (silent) return;
      setImmediate(() => {
        const { method, params } = message;
        if (method === "session/set_config_option") {
          state.current[params.configId] = params.value;
          const result = { configOptions: options(state.current) };
          memory.fromAgent({ jsonrpc: "2.0", id: message.id, result });
        } else {
          memory.fromAgent({ jsonrpc: "2.0", id: message.id, result: {} });
        }
      });
    },
    forward(message) {
      answered();
      if (throwOnForward) throw new Error("forward failed");
      state.forwarded.push(message);
    },
  });
  return { memory, state };
}

function set(memory, id, method, params, reply = { result: {} }) {
  memory.fromClient({ jsonrpc: "2.0", id, method, params });
  return memory.fromAgent({ jsonrpc: "2.0", id, ...reply });
}

const configure = (memory, id, sessionId, configId, value) =>
  set(memory, id, "session/set_config_option", { sessionId, configId, value });

async function reopen(file, sessionId, extra) {
  const { memory, state } = harness(file, extra);
  memory.fromClient({
    jsonrpc: "2.0",
    id: 99,
    method: "session/load",
    params: { sessionId },
  });
  const taken = memory.fromAgent(loadResponse(99));
  if (taken) await state.answered;
  return { memory, state, taken };
}

test("restores remembered options, model first, and skips failed ones", async () => {
  const file = stateFile();
  const { memory } = harness(file);
  assert.equal(configure(memory, 1, "S", "model", "opus"), false);
  configure(memory, 2, "S", "effort", "xhigh");
  set(
    memory,
    3,
    "session/set_config_option",
    { sessionId: "S", configId: "x", value: 1 },
    {
      error: { code: -32602 },
    },
  );

  const { state, taken } = await reopen(file, "S");
  assert.equal(taken, true);
  assert.deepEqual(
    state.sent.map((message) => message.params.configId),
    ["model", "effort"],
  );
  const restored = state.forwarded[0].result.configOptions;
  assert.equal(restored.find((option) => option.id === "model").currentValue, "opus");
  assert.equal(restored.find((option) => option.id === "effort").currentValue, "xhigh");
});

test("a legacy set_mode becomes an option request and patches modes", async () => {
  const file = stateFile();
  const { memory } = harness(file);
  set(memory, 1, "session/set_mode", { sessionId: "S", modeId: "plan" });
  configure(memory, 2, "S", "mode", "auto");
  set(memory, 3, "session/set_mode", { sessionId: "S", modeId: "plan" });
  const calls = JSON.parse(readFileSync(file, "utf8")).sessions.S.calls;
  assert.deepEqual(Object.keys(calls), ["mode"], "both forms share one slot");

  const { state } = await reopen(file, "S");
  assert.equal(state.sent[0].method, "session/set_config_option");
  assert.equal(state.sent[0].params.value, "plan");
  const { result } = state.forwarded[0];
  assert.equal(result.modes.currentModeId, "plan");
  assert.equal(result.configOptions.find((option) => option.id === "mode").currentValue, "plan");
});

test("one deadline covers the whole restore", async () => {
  const file = stateFile();
  const { memory } = harness(file);
  ["model", "effort", "ultracode", "fast", "mode"].forEach((id, index) => configure(memory, index + 1, "S", id, "v"));
  const realSetTimeout = globalThis.setTimeout;
  globalThis.setTimeout = (fn, ms, ...rest) => realSetTimeout(fn, ms >= 1000 ? 20 : ms, ...rest);
  try {
    const { state } = await reopen(file, "S", { silent: true });
    assert.equal(state.sent.length, 1, "stops after the first timeout");
    assert.equal(state.forwarded.length, 1, "the load response is still forwarded");
  } finally {
    globalThis.setTimeout = realSetTimeout;
  }
});

test("a malformed state file is ignored", async () => {
  const file = stateFile();
  const bad = {
    calls: { effort: { method: "session/set_config_option", params: {} } },
  };
  const good = {
    calls: {
      model: {
        method: "session/set_config_option",
        params: { sessionId: "good", configId: "model", value: "opus" },
      },
    },
  };
  const sessions = {
    a: { updated: 1 },
    b: { calls: null },
    c: { calls: { x: null } },
    d: bad,
    good,
  };
  writeFileSync(file, JSON.stringify({ sessions }));

  assert.equal((await reopen(file, "a")).state.sent.length, 0);
  assert.equal((await reopen(file, "good")).state.sent.length, 1);
  writeFileSync(file, "{not json");
  assert.ok(new SessionConfigMemory({ file, send() {}, forward() {} }));
});

test("odd messages never throw", () => {
  const { memory } = harness(stateFile());
  assert.equal(memory.fromAgent(null), false);
  assert.equal(memory.fromAgent({ id: {}, result: 1 }), false);
  assert.equal(memory.fromAgent({ method: "session/update" }), false);
  assert.equal(memory.fromAgent({ id: 77, result: {} }), false);
  memory.fromClient(undefined);
  memory.fromClient({ id: 1, method: 5 });
});

test("a throwing forward does not leave an unhandled rejection", async () => {
  const file = stateFile();
  const { memory } = harness(file);
  configure(memory, 1, "S", "model", "opus");
  let unhandled = 0;
  const count = () => unhandled++;
  process.on("unhandledRejection", count);
  const originalError = console.error;
  console.error = () => {};
  try {
    await reopen(file, "S", { throwOnForward: true });
  } finally {
    console.error = originalError;
    process.off("unhandledRejection", count);
  }
  assert.equal(unhandled, 0);
});

test("reopening a thread keeps it among the newest", async () => {
  const file = stateFile();
  const { memory } = harness(file);
  configure(memory, 1, "old", "model", "opus");
  const before = JSON.parse(readFileSync(file, "utf8")).sessions.old.updated;
  await new Promise((resolve) => setTimeout(resolve, 20));
  await reopen(file, "old");
  assert.ok(JSON.parse(readFileSync(file, "utf8")).sessions.old.updated > before);
});

test("the state file is private to the user", { skip: process.platform === "win32" }, async () => {
  const file = stateFile();
  configure(harness(file).memory, 1, "S", "model", "opus");
  const { statSync } = await import("node:fs");
  assert.equal(statSync(file).mode & 0o077, 0);
});
