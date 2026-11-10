import assert from "node:assert/strict";
import { test } from "node:test";

import { withSettingSources } from "../src/setting-sources.mjs";

test("every request that starts a session gets the sources", () => {
  for (const method of ["session/new", "session/load", "session/resume", "session/fork"]) {
    const message = { jsonrpc: "2.0", id: 1, method, params: { cwd: "/tmp" } };
    assert.equal(withSettingSources(message, ["user"]), true);
    assert.deepEqual(message.params._meta.claudeCode.options, {
      settingSources: ["user"],
    });
    assert.equal(message.params.cwd, "/tmp");
  }
});

test("the sources of the editor are replaced and its other options are kept", () => {
  const message = {
    method: "session/new",
    params: {
      _meta: {
        claudeCode: { options: { settingSources: ["project"], model: "opus" } },
      },
    },
  };
  withSettingSources(message, ["user"]);
  assert.deepEqual(message.params._meta.claudeCode.options, {
    settingSources: ["user"],
    model: "opus",
  });
});

test("other requests are left alone", () => {
  for (const method of ["initialize", "session/prompt", "session/set_config_option"]) {
    const message = { method, params: {} };
    assert.equal(withSettingSources(message, ["user"]), false);
    assert.deepEqual(message, { method, params: {} });
  }
});

test("malformed requests do not throw, and the sources still apply", () => {
  const broken = [
    { method: "session/new", params: { _meta: "text" } },
    { method: "session/new", params: { _meta: { claudeCode: 5 } } },
    { method: "session/new", params: { _meta: { claudeCode: { options: [] } } } },
    { method: "session/new", params: { _meta: null } },
  ];
  for (const message of broken) {
    assert.equal(withSettingSources(message, ["user"]), true);
    assert.deepEqual(message.params._meta.claudeCode.options, {
      settingSources: ["user"],
    });
  }
  for (const message of [null, 5, "text", [], { method: "session/new", params: null }]) {
    assert.equal(withSettingSources(message, ["user"]), false);
  }
  assert.equal(withSettingSources({ method: "session/new", params: [] }, ["user"]), false);
});
