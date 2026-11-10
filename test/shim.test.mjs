import assert from "node:assert/strict";
import { mkdirSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { test } from "node:test";

import { readConfig } from "../src/config.mjs";
import { wrapSdk } from "../src/sdk/shim.mjs";
import { temporaryDirectory } from "./helpers.mjs";

const SESSION = "11111111-1111-4111-8111-111111111111";

/**
 * A profile with a compacted transcript: u1 and a1, then the boundary b1 and the summary s1.
 *
 * @returns {string} The profile's directory.
 */
function compactedProfile() {
  const profile = temporaryDirectory();
  const project = join(profile, "projects", "-tmp-p");
  mkdirSync(project, { recursive: true });
  const records = [
    { parentUuid: null, uuid: "u1", type: "user", message: { role: "user", content: "question" } },
    { parentUuid: "u1", uuid: "a1", type: "assistant", message: { role: "assistant", content: "answer" } },
    { parentUuid: null, uuid: "b1", type: "system", subtype: "compact_boundary", logicalParentUuid: "a1" },
    { parentUuid: "b1", uuid: "s1", type: "user", isCompactSummary: true, message: { role: "user", content: "s" } },
  ];
  writeFileSync(join(project, `${SESSION}.jsonl`), `${records.map((record) => JSON.stringify(record)).join("\n")}\n`);
  return profile;
}

/**
 * A fake SDK that records what the shim asks of it. Like the real one, it returns a compacted thread from its
 * summary on.
 *
 * @param {{ available?: boolean, fail?: boolean }} [options]
 */
function fakeSdk({ available = true, fail = false } = {}) {
  const calls = { enableRemoteControl: 0, getSessionMessages: /** @type {unknown[][]} */ ([]) };
  const session = {
    initializationResult: async () => ({ remote_control_available: available }),
    enableRemoteControl: async () => {
      calls.enableRemoteControl++;
      if (fail) throw new Error("no account");
    },
  };
  const sdk = {
    query: () => session,
    /**
     * @param {string} sessionId
     * @param {unknown} [options]
     */
    getSessionMessages: async (sessionId, options) => {
      calls.getSessionMessages.push([sessionId, options]);
      return [{ uuid: "s1" }];
    },
  };
  return { sdk, session, calls };
}

/** @param {NodeJS.ProcessEnv} env */
const config = (env) => readConfig({ CLAUDE_CONFIG_DIR: temporaryDirectory(), ...env }, () => {});
const settle = () => new Promise((resolve) => setImmediate(resolve));

test("query() turns Remote Control on only when it is set to", async () => {
  const off = fakeSdk();
  wrapSdk(off.sdk, config({})).query({});
  const on = fakeSdk();
  const session = wrapSdk(on.sdk, config({ CLAUDE_ACP_PROXY_REMOTE_CONTROL: "1" })).query({});
  await settle();
  assert.equal(off.calls.enableRemoteControl, 0);
  assert.equal(on.calls.enableRemoteControl, 1);
  assert.equal(session, on.session);
});

test("Remote Control is not asked for when the account cannot have it", async () => {
  const { sdk, calls } = fakeSdk({ available: false });
  wrapSdk(sdk, config({ CLAUDE_ACP_PROXY_REMOTE_CONTROL: "1" })).query({});
  await settle();
  assert.equal(calls.enableRemoteControl, 0);
});

test("a Remote Control failure is logged, not thrown", async (t) => {
  const logged = t.mock.method(console, "error", () => {});
  const { sdk } = fakeSdk({ fail: true });
  wrapSdk(sdk, config({ CLAUDE_ACP_PROXY_REMOTE_CONTROL: "1" })).query({});
  await settle();
  await settle();
  assert.equal(logged.mock.callCount(), 1);
  assert.match(String(logged.mock.calls[0]?.arguments[0]), /remote control: no account/);
});

/** @param {{ uuid: string }[]} messages */
const uuids = (messages) => messages.map((message) => message.uuid);

test("getSessionMessages() without options adds the history from before the compaction", async () => {
  const { sdk } = fakeSdk();
  const shim = wrapSdk(sdk, config({ CLAUDE_CONFIG_DIR: compactedProfile() }));
  const messages = await shim.getSessionMessages(SESSION);
  assert.deepEqual(uuids(messages), ["u1", "a1", "s1"]);
});

test("getSessionMessages() with options is the SDK's own", async () => {
  const { sdk, calls } = fakeSdk();
  const shim = wrapSdk(sdk, config({ CLAUDE_CONFIG_DIR: compactedProfile() }));
  const messages = await shim.getSessionMessages(SESSION, { limit: 1 });
  assert.deepEqual(uuids(messages), ["s1"]);
  assert.deepEqual(calls.getSessionMessages, [[SESSION, { limit: 1 }]]);
});

test("with full history off, getSessionMessages() is the SDK's own", async () => {
  const { sdk } = fakeSdk();
  const env = { CLAUDE_CONFIG_DIR: compactedProfile(), CLAUDE_ACP_PROXY_FULL_HISTORY: "0" };
  const messages = await wrapSdk(sdk, config(env)).getSessionMessages(SESSION);
  assert.deepEqual(uuids(messages), ["s1"]);
});

test("a session with no transcript replays what the SDK returned", async () => {
  const { sdk } = fakeSdk();
  const messages = await wrapSdk(sdk, config({})).getSessionMessages(SESSION);
  assert.deepEqual(uuids(messages), ["s1"]);
});

test("without a config, the environment is read at each call", async (t) => {
  const saved = { dir: process.env.CLAUDE_CONFIG_DIR, history: process.env.CLAUDE_ACP_PROXY_FULL_HISTORY };
  t.after(() => {
    for (const [name, value] of [
      ["CLAUDE_CONFIG_DIR", saved.dir],
      ["CLAUDE_ACP_PROXY_FULL_HISTORY", saved.history],
    ]) {
      if (value === undefined) delete process.env[name];
      else process.env[name] = value;
    }
  });
  delete process.env.CLAUDE_ACP_PROXY_FULL_HISTORY;
  process.env.CLAUDE_CONFIG_DIR = temporaryDirectory();
  const { sdk } = fakeSdk();
  const shim = wrapSdk(sdk);
  // What the adapter does with a managed policy's env, after it has imported the SDK.
  process.env.CLAUDE_CONFIG_DIR = compactedProfile();
  const messages = await shim.getSessionMessages(SESSION);
  assert.deepEqual(uuids(messages), ["u1", "a1", "s1"]);
});
