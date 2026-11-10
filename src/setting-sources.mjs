import { isObject } from "./protocol.mjs";

const SESSION_METHODS = new Set(["session/new", "session/load", "session/resume", "session/fork"]);

/**
 * Sets the sources Claude Code loads its settings from on a request that starts a session, through
 * `_meta.claudeCode.options`. Other messages, and malformed ones, are left alone.
 *
 * @param {unknown} message Changed in place.
 * @param {readonly string[]} sources
 * @returns {boolean} Whether the message changed.
 */
export function withSettingSources(message, sources) {
  if (!isObject(message) || !SESSION_METHODS.has(message.method)) return false;
  if (!isObject(message.params)) return false;
  const params = message.params;
  if (!isObject(params._meta)) params._meta = {};
  if (!isObject(params._meta.claudeCode)) params._meta.claudeCode = {};
  const claudeCode = params._meta.claudeCode;
  const options = isObject(claudeCode.options) ? claudeCode.options : {};
  claudeCode.options = { ...options, settingSources: sources };
  return true;
}
