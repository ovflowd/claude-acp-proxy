const SESSION_METHODS = new Set([
  "session/new",
  "session/load",
  "session/resume",
  "session/fork",
]);
const SOURCES = ["user", "project", "local"];

const isObject = (value) =>
  typeof value === "object" && value !== null && !Array.isArray(value);

/** The sources to load, or undefined to leave the adapter's own choice. */
export function parseSettingSources(value = "user") {
  if (value === "default") return undefined;
  const sources = value.split(",").map((source) => source.trim());
  if (sources.every((source) => SOURCES.includes(source))) return sources;
  console.error(`claude-acp-proxy: ignoring CLAUDE_ACP_PROXY_SETTING_SOURCES=${value}`);
  return ["user"];
}

/** Sets `settingSources` on a request that starts a session. True when it did. */
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
