/**
 * A line of a Claude Code transcript. Only the fields that link the records are named.
 *
 * @typedef {{ uuid: string, parentUuid?: string | null, logicalParentUuid?: string, [key: string]: any }}
 *   TranscriptRecord
 */

/**
 * A message as the SDK's `getSessionMessages()` returns it.
 *
 * @typedef {{ uuid: string, [key: string]: any }} SessionMessage
 */

/**
 * Puts the history from before each compaction in front of the messages the SDK returned.
 *
 * The SDK stops at the last `compact_boundary`: that record has no parent and keeps the leaf of the history it
 * replaced in `logicalParentUuid`, so a compacted thread would replay from its summary on.
 *
 * @param {string} transcript
 * @param {SessionMessage[]} active What the SDK returned.
 * @param {string} sessionId
 * @returns {SessionMessage[]}
 */
export function withEarlierHistory(transcript, active, sessionId) {
  // Attachments and system records are part of the parent chain too. Records start with `parentUuid`; a boundary
  // is matched as well in case the key order changes.
  /** @type {Map<string, TranscriptRecord>} */
  const records = new Map();
  /** @type {Map<string, string | undefined>} */
  const precedingUuids = new Map();
  /** @type {TranscriptRecord | undefined} */
  let lastBoundary;
  /** @type {string | undefined} */
  let previousUuid;
  for (const line of transcript.split("\n")) {
    if (!line.startsWith('{"parentUuid"') && !line.includes('"compact_boundary"')) continue;
    const record = parseRecord(line);
    if (!record) continue;
    if (isBoundary(record)) {
      precedingUuids.set(record.uuid, previousUuid);
      lastBoundary = record;
    }
    records.set(record.uuid, record);
    previousUuid = record.uuid;
  }

  // The boundary that the SDK's own chain crosses, not the last one written: a thread that was rewound to before a
  // compaction has a later boundary on a branch that is no longer active.
  const boundary = boundaryAbove(active[0]?.uuid, records) ?? lastBoundary;
  if (!boundary) return active;

  // A boundary whose `logicalParentUuid` is not in the file continues from the record written before it.
  /** @param {TranscriptRecord} record */
  const parentOf = (record) => {
    if (record.parentUuid) return record.parentUuid;
    if (!isBoundary(record)) return undefined;
    if (record.logicalParentUuid !== undefined && records.has(record.logicalParentUuid)) {
      return record.logicalParentUuid;
    }
    return precedingUuids.get(record.uuid);
  };
  const earlier = [];
  const seen = new Set();
  for (let uuid = parentOf(boundary); uuid && !seen.has(uuid);) {
    seen.add(uuid);
    const record = records.get(uuid);
    if (!record) break;
    const message = toSessionMessage(record, sessionId);
    if (message) earlier.push(message);
    uuid = parentOf(record);
  }
  if (earlier.length === 0) return active;

  // The messages that the compaction kept are in both lists. Taking them from the transcript puts the summary
  // after them.
  earlier.reverse();
  const replayed = new Set(earlier.map((message) => message.uuid));
  return [...earlier, ...active.filter((message) => !replayed.has(message.uuid))];
}

/**
 * @param {string} line
 * @returns {TranscriptRecord | undefined}
 */
function parseRecord(line) {
  try {
    const record = JSON.parse(line);
    return typeof record?.uuid === "string" ? record : undefined;
  } catch {
    return undefined;
  }
}

/** @param {TranscriptRecord} record */
function isBoundary(record) {
  return record.type === "system" && record.subtype === "compact_boundary";
}

/**
 * @param {string | undefined} uuid
 * @param {Map<string, TranscriptRecord>} records
 */
function boundaryAbove(uuid, records) {
  const seen = new Set();
  let record = uuid === undefined ? undefined : records.get(uuid);
  while (record && !seen.has(record.uuid)) {
    if (isBoundary(record)) return record;
    seen.add(record.uuid);
    record = record.parentUuid ? records.get(record.parentUuid) : undefined;
  }
  return undefined;
}

/**
 * The SDK's own form of a record. A prompt typed while Claude was working, and a background task's notification,
 * are stored as `queued_command` attachments and come back as user messages.
 *
 * @param {TranscriptRecord} record
 * @param {string} sessionId
 * @returns {SessionMessage | undefined}
 */
function toSessionMessage(record, sessionId) {
  const common = {
    session_id: sessionId,
    parent_tool_use_id: null,
    parent_agent_id: null,
    timestamp: record.timestamp,
  };
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
