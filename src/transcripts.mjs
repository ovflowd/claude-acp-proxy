import { open, readdir } from "node:fs/promises";
import { join } from "node:path";

import { logProblem } from "./log.mjs";

// The id becomes part of a path, so anything else (a client could send `../`) is never looked up.
const SESSION_ID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

/**
 * @param {string} sessionId
 * @param {string} claudeConfigDir
 * @returns {Promise<string | undefined>} Undefined when there is none.
 */
export async function readTranscript(sessionId, claudeConfigDir) {
  const handle = await openTranscript(sessionId, claudeConfigDir);
  if (!handle) return undefined;
  try {
    const text = await handle.readFile("utf8");
    return text;
  } finally {
    await handle.close();
  }
}

/**
 * The last part of a session's transcript, which can start in the middle of a line.
 *
 * @param {string} sessionId
 * @param {string} claudeConfigDir
 * @param {number} bytes
 * @returns {Promise<string | undefined>} Undefined when there is none.
 */
export async function readTranscriptTail(sessionId, claudeConfigDir, bytes) {
  const handle = await openTranscript(sessionId, claudeConfigDir);
  if (!handle) return undefined;
  try {
    const { size } = await handle.stat();
    const length = Math.min(size, bytes);
    const tail = Buffer.alloc(length);
    await handle.read(tail, 0, length, size - length);
    return tail.toString("utf8");
  } finally {
    await handle.close();
  }
}

/**
 * Claude Code keeps a transcript in the folder of the project it ran in, and the editor gives only the id.
 *
 * @param {string} sessionId
 * @param {string} claudeConfigDir
 */
async function openTranscript(sessionId, claudeConfigDir) {
  if (!SESSION_ID.test(sessionId)) return undefined;
  const projects = join(claudeConfigDir, "projects");
  let names;
  try {
    names = await readdir(projects);
  } catch {
    return undefined;
  }
  for (const name of names) {
    try {
      const handle = await open(join(projects, name, `${sessionId}.jsonl`), "r");
      return handle;
    } catch (error) {
      if (!isMissing(error)) logProblem("transcripts", error);
    }
  }
  return undefined;
}

/**
 * A stray file in `projects/` gives ENOTDIR, and a project folder without the session ENOENT.
 *
 * @param {unknown} error
 */
function isMissing(error) {
  return error instanceof Error && "code" in error && (error.code === "ENOENT" || error.code === "ENOTDIR");
}
