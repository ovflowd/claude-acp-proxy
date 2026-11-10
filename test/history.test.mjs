import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { mkdirSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { test } from "node:test";
import { pathToFileURL } from "node:url";

import { cleanEnv, needsAdapter, root, temporaryDirectory } from "./helpers.mjs";

const HOOK = pathToFileURL(join(root, "src", "sdk", "register.mjs")).href;
const SESSION = "11111111-1111-4111-8111-111111111111";

// Builds a transcript in the form that Claude Code writes, with synthetic content.
class Transcript {
  records = [];
  tick = 0;
  last = null;

  common(uuid, parentUuid) {
    const timestamp = new Date(Date.UTC(2026, 0, 1, 0, 0, this.tick++)).toISOString();
    return {
      parentUuid,
      isSidechain: false,
      uuid,
      timestamp,
      sessionId: SESSION,
      cwd: "/tmp/p",
    };
  }

  user(uuid, text, extra = {}) {
    const message = { role: "user", content: text };
    this.records.push({
      ...this.common(uuid, this.last),
      type: "user",
      message,
      ...extra,
    });
    this.last = uuid;
  }

  assistant(uuid, text) {
    const message = {
      model: "claude-opus-5-5",
      id: `msg_${uuid}`,
      type: "message",
      role: "assistant",
      content: [{ type: "text", text }],
      stop_reason: "end_turn",
      usage: { input_tokens: 1, output_tokens: 1 },
    };
    this.records.push({ ...this.common(uuid, this.last), type: "assistant", message });
    this.last = uuid;
  }

  queued(uuid, sourceUuid, prompt, origin = { kind: "human" }) {
    const attachment = {
      type: "queued_command",
      prompt,
      source_uuid: sourceUuid,
      origin,
    };
    this.records.push({
      ...this.common(uuid, this.last),
      type: "attachment",
      attachment,
    });
    this.last = uuid;
  }

  compact(boundaryUuid, summaryUuid, { logicalParentUuid = this.last } = {}) {
    this.records.push({
      ...this.common(boundaryUuid, null),
      logicalParentUuid,
      type: "system",
      subtype: "compact_boundary",
      content: "Conversation compacted",
      level: "info",
      compactMetadata: { trigger: "auto", preTokens: 1, durationMs: 1 },
    });
    this.user(summaryUuid, "This session is being continued from a previous conversation.", {
      isCompactSummary: true,
      isVisibleInTranscriptOnly: true,
    });
    this.records.at(-1).parentUuid = boundaryUuid;
  }

  write() {
    const configDir = temporaryDirectory();
    const project = join(configDir, "projects", "-tmp-p");
    mkdirSync(project, { recursive: true });
    const lines = this.records.map((record) => JSON.stringify(record));
    writeFileSync(join(project, `${SESSION}.jsonl`), `${lines.join("\n")}\n`);
    return configDir;
  }
}

// Runs getSessionMessages through the shim, as the adapter does, and returns the texts.
function history(configDir, env = {}, sessionId = SESSION) {
  const code = `
    import { getSessionMessages } from "@anthropic-ai/claude-agent-sdk";
    const messages = await getSessionMessages(${JSON.stringify(sessionId)});
    const text = ({ message }) =>
      typeof message.content === "string" ? message.content : message.content[0].text;
    const rows = messages.map((m) => [m.uuid, text(m), m.isQueuedCommand === true]);
    console.log(JSON.stringify(rows));
  `;
  const result = spawnSync(process.execPath, ["--import", HOOK, "--input-type=module", "--eval", code], {
    cwd: root,
    encoding: "utf8",
    env: { ...cleanEnv(), CLAUDE_CONFIG_DIR: configDir, ...env },
  });
  assert.equal(result.status, 0, result.stderr);
  return JSON.parse(result.stdout.trim().split("\n").at(-1));
}

const ids = (rows) => rows.map(([uuid]) => uuid);

test("a compacted thread replays from before the compaction", needsAdapter, () => {
  const t = new Transcript();
  t.user("u1", "first question");
  t.assistant("a1", "first answer");
  t.user("u2", "second question");
  t.assistant("a2", "second answer");
  t.compact("b1", "s1");
  t.user("u3", "after the compaction");
  t.assistant("a3", "answer after");
  const dir = t.write();

  assert.deepEqual(ids(history(dir, { CLAUDE_ACP_PROXY_FULL_HISTORY: "0" })), ["s1", "u3", "a3"]);
  assert.deepEqual(ids(history(dir)), ["u1", "a1", "u2", "a2", "s1", "u3", "a3"]);
});

test("prompts typed while Claude worked come back with the SDK's uuid", needsAdapter, () => {
  const t = new Transcript();
  t.user("u1", "start");
  t.queued("q1", "typed-1", "a prompt typed meanwhile");
  t.queued("q2", "notice-1", "<task-notification>done</task-notification>", {
    kind: "task-notification",
  });
  t.assistant("a1", "answer");
  t.compact("b1", "s1");
  t.user("u2", "after");
  const rows = history(t.write());

  assert.deepEqual(ids(rows), ["u1", "typed-1", "notice-1", "a1", "s1", "u2"]);
  assert.deepEqual(
    rows.filter(([, , queued]) => queued).map(([uuid]) => uuid),
    ["typed-1", "notice-1"],
  );
});

test("several compactions are crossed, also when a logical parent is missing", needsAdapter, () => {
  const t = new Transcript();
  t.user("u1", "one");
  t.assistant("a1", "one answer");
  t.compact("b1", "s1", { logicalParentUuid: "not-in-the-file" });
  t.user("u2", "two");
  t.assistant("a2", "two answer");
  t.compact("b2", "s2");
  t.user("u3", "three");
  const rows = history(t.write());

  assert.deepEqual(ids(rows), ["u1", "a1", "s1", "u2", "a2", "s2", "u3"]);
  assert.equal(new Set(ids(rows)).size, rows.length, "no message twice");
});

test("a thread that was never compacted is unchanged", needsAdapter, () => {
  const t = new Transcript();
  t.user("u1", "hello");
  t.assistant("a1", "hi");
  const dir = t.write();

  assert.deepEqual(history(dir), history(dir, { CLAUDE_ACP_PROXY_FULL_HISTORY: "0" }));
});

test("an id that is not a session id never reaches the file system", needsAdapter, () => {
  const t = new Transcript();
  t.user("u1", "hello");
  t.compact("b1", "s1");
  const dir = t.write();
  const outside = join(dir, "projects", "-tmp-p", "..", "..", "projects", "-tmp-p", SESSION);

  assert.deepEqual(history(dir, {}, outside), []);
});
