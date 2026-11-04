// The SDK as claude-agent-acp sees it (served in place of the real module by remote-control.mjs).
// query() turns Remote Control on (CLAUDIO_ZED_REMOTE_CONTROL=0 turns it off), and getSessionMessages()
// without options also returns the history from before each compaction (CLAUDIO_ZED_FULL_HISTORY=0 turns it off).
import { readdir, readFile } from "node:fs/promises";
import { homedir } from "node:os";
import { join } from "node:path";
import { getSessionMessages as sdkGetSessionMessages, query as sdkQuery } from "@anthropic-ai/claude-agent-sdk";

export * from "@anthropic-ai/claude-agent-sdk";

export function query(params) {
  const session = sdkQuery(params);
  if (process.env.CLAUDIO_ZED_REMOTE_CONTROL !== "0") enableRemoteControl(session);
  return session;
}

async function enableRemoteControl(session) {
  try {
    const init = await session.initializationResult();
    if (init.remote_control_available === false) return;
    await session.enableRemoteControl(true);
  } catch (error) {
    console.error(`remote control: ${error?.message ?? error}`);
  }
}

// The SDK stops at the last `compact_boundary`: that record has no parent and keeps the leaf of the
// history it replaced in `logicalParentUuid`. A compacted thread would replay from its summary on.
export async function getSessionMessages(sessionId, options) {
  const active = await sdkGetSessionMessages(sessionId, options);
  if (options !== undefined || process.env.CLAUDIO_ZED_FULL_HISTORY === "0") return active;
  try {
    const messages = await withEarlierHistory(sessionId, active);
    return messages;
  } catch (error) {
    console.error(`full history: ${error?.message ?? error}`);
    return active;
  }
}

async function withEarlierHistory(sessionId, active) {
  const text = await readTranscript(sessionId);
  if (text === undefined) return active;

  // Attachments and system records are part of the parent chain too. Records start with
  // `parentUuid`; a boundary is matched as well in case the key order changes.
  const records = new Map();
  const precedingUuids = new Map();
  let lastBoundary;
  let previousUuid;
  for (const line of text.split("\n")) {
    if (!line.startsWith('{"parentUuid"') && !line.includes('"compact_boundary"')) continue;
    let record;
    try {
      record = JSON.parse(line);
    } catch {
      continue;
    }
    if (typeof record.uuid !== "string") continue;
    if (isBoundary(record)) {
      precedingUuids.set(record.uuid, previousUuid);
      lastBoundary = record;
    }
    records.set(record.uuid, record);
    previousUuid = record.uuid;
  }

  // The boundary that the SDK's own chain crosses, not the last one written: a thread that was
  // rewound to before a compaction has a later boundary on a branch that is no longer active.
  const boundary = boundaryAbove(active[0]?.uuid, records) ?? lastBoundary;
  if (!boundary) return active;

  // A boundary whose `logicalParentUuid` is not in the file continues from the record written before it.
  const parentOf = (record) => {
    if (record.parentUuid) return record.parentUuid;
    if (!isBoundary(record)) return undefined;
    return records.has(record.logicalParentUuid) ? record.logicalParentUuid : precedingUuids.get(record.uuid);
  };
  const earlier = [];
  const seen = new Set();
  for (let uuid = parentOf(boundary); uuid && !seen.has(uuid); ) {
    seen.add(uuid);
    const record = records.get(uuid);
    if (!record) break;
    const message = toSessionMessage(record, sessionId);
    if (message) earlier.push(message);
    uuid = parentOf(record);
  }
  if (earlier.length === 0) return active;

  // The messages that the compaction kept are in both lists. Taking them from the transcript puts the summary after them.
  earlier.reverse();
  const replayed = new Set(earlier.map((message) => message.uuid));
  return [...earlier, ...active.filter((message) => !replayed.has(message.uuid))];
}

function isBoundary(record) {
  return record.type === "system" && record.subtype === "compact_boundary";
}

function boundaryAbove(uuid, records) {
  const seen = new Set();
  for (let record = records.get(uuid); record && !seen.has(record.uuid); record = records.get(record.parentUuid)) {
    if (isBoundary(record)) return record;
    seen.add(record.uuid);
  }
  return undefined;
}

// The SDK's own form of a record. A prompt typed while Claude was working, and a background task's
// notification, are stored as `queued_command` attachments and come back as user messages.
function toSessionMessage(record, sessionId) {
  const common = { session_id: sessionId, parent_tool_use_id: null, parent_agent_id: null, timestamp: record.timestamp };
  const isMessage = record.type === "user" || record.type === "assistant";
  if (isMessage && !record.isMeta && !record.isSidechain) {
    return {
      type: record.type,
      uuid: record.uuid,
      message: record.message,
      ...common,
      ...(record.origin === undefined ? {} : { origin: record.origin }),
      ...(record.isCompactSummary === true ? { isCompactSummary: true, is_meta: true } : {}),
    };
  }
  const queued = record.attachment;
  if (record.type === "attachment" && queued?.type === "queued_command" && !queued.isMeta && queued.source_uuid) {
    return {
      type: "user",
      uuid: queued.source_uuid,
      message: { role: "user", content: queued.prompt },
      ...common,
      isQueuedCommand: true,
      ...(queued.origin === undefined ? {} : { origin: queued.origin }),
    };
  }
  return undefined;
}

async function readTranscript(sessionId) {
  const projects = join(process.env.CLAUDE_CONFIG_DIR ?? join(homedir(), ".claude"), "projects");
  let directories;
  try {
    directories = await readdir(projects);
  } catch {
    return undefined;
  }
  for (const directory of directories) {
    try {
      const text = await readFile(join(projects, directory, `${sessionId}.jsonl`), "utf8");
      return text;
    } catch {
      continue;
    }
  }
  return undefined;
}
