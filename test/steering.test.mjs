import assert from "node:assert/strict";
import { test } from "node:test";

import { Steering } from "../src/steering.mjs";

const WINDOW = 25;
const pause = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

// A steering wired to arrays; `supported` says what the adapter reported at initialize.
function setup({ supported = true } = {}) {
  const sent = [];
  const forwarded = [];
  const steering = new Steering({
    windowMs: WINDOW,
    send: (message) => sent.push(message),
    forward: (message) => forwarded.push(message),
  });
  const client = (message) => steering.fromClient(message);
  const agent = (message) => steering.fromAgent(message);
  client({ jsonrpc: "2.0", id: 1, method: "initialize", params: {} });
  const capabilities = supported ? { steering: { supported: true } } : {};
  agent({ jsonrpc: "2.0", id: 1, result: { _meta: capabilities } });
  return { steering, sent, forwarded, client, agent };
}

const prompt = (id, text, extra = {}) => ({
  jsonrpc: "2.0",
  id,
  method: "session/prompt",
  params: { sessionId: "S", prompt: [{ type: "text", text }], ...extra },
});
const cancel = (sessionId = "S") => ({
  jsonrpc: "2.0",
  method: "session/cancel",
  params: { sessionId },
});
const reply = (id, result) => ({ jsonrpc: "2.0", id, result });
const steers = (sent) => sent.filter((message) => message.method === "_session/steering");
const cancels = (sent) => sent.filter((message) => message.method === "session/cancel");

test("a turn that nobody interrupts is passed through untouched", () => {
  const { client, agent, forwarded } = setup();
  const first = prompt(10, "hello");
  assert.equal(client(first), first);
  assert.equal(agent(reply(10, { stopReason: "end_turn" })), false);
  assert.deepEqual(forwarded, []);
});

test("without steering support nothing changes", () => {
  const { client, forwarded } = setup({ supported: false });
  const first = prompt(10, "hello");
  const stop = cancel();
  assert.equal(client(first), first);
  assert.equal(client(stop), stop);
  const second = prompt(11, "again");
  assert.equal(client(second), second);
  assert.deepEqual(forwarded, []);
});

test("stop then a new message steers the running turn", async () => {
  const { client, agent, sent, forwarded } = setup();
  client(prompt(10, "first"));

  assert.equal(client(cancel()), undefined, "the cancel is held back");
  assert.deepEqual(forwarded, [reply(10, { stopReason: "cancelled" })]);

  assert.equal(client(prompt(11, "second")), undefined, "the prompt is taken");
  const [steer] = steers(sent);
  assert.deepEqual(steer.params.prompt, [{ type: "text", text: "second" }]);
  assert.equal(steer.params.sessionId, "S");
  assert.equal(steer.params._meta.steering.idleBehavior, "promptRequired");
  assert.equal(agent(reply(steer.id, { outcome: "injected" })), true);

  await pause(WINDOW * 3);
  assert.deepEqual(cancels(sent), [], "the turn is not cancelled");

  const final = { stopReason: "end_turn", usage: { outputTokens: 7 } };
  assert.equal(agent(reply(10, final)), true, "the real answer is not passed as is");
  assert.deepEqual(forwarded.at(-1), reply(11, final), "it answers the new prompt");
  assert.equal(forwarded.length, 2);
});

test("a plain stop reaches the adapter after the window", async () => {
  const { client, agent, sent, forwarded } = setup();
  client(prompt(10, "first"));
  assert.equal(client(cancel()), undefined);
  assert.deepEqual(cancels(sent), []);

  await pause(WINDOW * 3);
  assert.deepEqual(cancels(sent), [cancel()]);

  assert.equal(agent(reply(10, { stopReason: "cancelled" })), true, "already answered");
  assert.equal(forwarded.length, 1);
});

test("a turn that ends inside the window needs no cancel", async () => {
  const { client, agent, sent, forwarded } = setup();
  client(prompt(10, "first"));
  client(cancel());
  assert.equal(agent(reply(10, { stopReason: "end_turn" })), true);

  await pause(WINDOW * 3);
  assert.deepEqual(cancels(sent), []);
  assert.equal(forwarded.length, 1);
});

test("a prompt after the window is an ordinary prompt", async () => {
  const { client, agent, sent } = setup();
  client(prompt(10, "first"));
  client(cancel());
  await pause(WINDOW * 3);

  const second = prompt(11, "second");
  assert.equal(client(second), second, "passed on as it is");
  assert.deepEqual(steers(sent), []);

  assert.equal(agent(reply(10, { stopReason: "cancelled" })), true, "late answer dropped");
  assert.equal(agent(reply(11, { stopReason: "end_turn" })), false);
});

test("a turn that is over when the steer arrives gets the prompt as a prompt", () => {
  const { client, agent, sent, forwarded } = setup();
  client(prompt(10, "first"));
  client(cancel());
  const second = prompt(11, "second");
  client(second);
  const [steer] = steers(sent);

  assert.equal(agent(reply(steer.id, { outcome: "promptRequired" })), true);
  assert.deepEqual(sent.at(-1), second, "sent as a prompt");
  assert.equal(agent(reply(11, { stopReason: "end_turn" })), false);
  assert.equal(forwarded.length, 1, "only the cancelled answer to the first prompt");
});

test("an answer before the steer reply does not go to the new prompt", () => {
  const { client, agent, sent, forwarded } = setup();
  client(prompt(10, "first"));
  client(cancel());
  const second = prompt(11, "second");
  client(second);
  const [steer] = steers(sent);

  assert.equal(agent(reply(10, { stopReason: "end_turn" })), true, "held back");
  assert.equal(forwarded.length, 1);
  agent(reply(steer.id, { outcome: "promptRequired" }));
  assert.deepEqual(sent.at(-1), second);
  assert.equal(forwarded.length, 1, "the prompt is still unanswered");
});

test("an error from the steer request falls back to a prompt", () => {
  const { client, agent, sent } = setup();
  client(prompt(10, "first"));
  client(cancel());
  const second = prompt(11, "second");
  client(second);
  const [steer] = steers(sent);

  agent({ jsonrpc: "2.0", id: steer.id, error: { code: -32601, message: "no" } });
  assert.deepEqual(sent.at(-1), second);
});

test("two messages in a row steer twice and the last one gets the answer", () => {
  const { client, agent, sent, forwarded } = setup();
  client(prompt(10, "first"));
  client(cancel());
  client(prompt(11, "second"));
  agent(reply(steers(sent)[0].id, { outcome: "injected" }));

  client(cancel());
  assert.deepEqual(forwarded.at(-1), reply(11, { stopReason: "cancelled" }));
  client(prompt(12, "third"));
  const [, second] = steers(sent);
  assert.deepEqual(second.params.prompt, [{ type: "text", text: "third" }]);
  agent(reply(second.id, { outcome: "injected" }));

  const final = { stopReason: "end_turn" };
  assert.equal(agent(reply(10, final)), true);
  assert.deepEqual(forwarded.at(-1), reply(12, final));
  assert.equal(forwarded.length, 3);
});

test("a stop after a steer cancels the turn", async () => {
  const { client, agent, sent, forwarded } = setup();
  client(prompt(10, "first"));
  client(cancel());
  client(prompt(11, "second"));
  agent(reply(steers(sent)[0].id, { outcome: "injected" }));

  client(cancel());
  assert.deepEqual(forwarded.at(-1), reply(11, { stopReason: "cancelled" }));
  await pause(WINDOW * 3);
  assert.equal(cancels(sent).length, 1);
  assert.equal(agent(reply(10, { stopReason: "cancelled" })), true);
  assert.equal(forwarded.length, 2);
});

test("the message id of the new prompt is given back to the editor", () => {
  const { client, agent, sent, forwarded } = setup();
  client(prompt(10, "first", { messageId: "m1" }));
  client(cancel());
  assert.equal(forwarded[0].result.userMessageId, "m1");
  client(prompt(11, "second", { messageId: "m2" }));
  agent(reply(steers(sent)[0].id, { outcome: "injected" }));
  agent(reply(10, { stopReason: "end_turn", userMessageId: "m1" }));
  assert.equal(forwarded.at(-1).result.userMessageId, "m2");
});

test("other sessions and other messages are left alone", () => {
  const { client, agent, forwarded } = setup();
  client(prompt(10, "first"));
  const other = cancel("T");
  assert.equal(client(other), other, "no turn of that session");
  const notice = {
    jsonrpc: "2.0",
    method: "session/update",
    params: { sessionId: "S" },
  };
  assert.equal(client(notice), notice);
  assert.equal(agent(notice), false);
  assert.equal(agent(reply(99, {})), false);
  for (const odd of [null, 5, "text", [], { id: 3, method: 5 }]) {
    assert.equal(client(odd), odd);
    assert.equal(agent(odd), false);
  }
  assert.deepEqual(forwarded, []);
});
