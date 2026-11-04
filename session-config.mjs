// Puts a thread's model, effort and toggles back when Zed opens it again. Zed applies its
// `default_config_options` to new sessions only, and shows what the adapter answers on load and resume.
// The host calls `fromClient(message)` for each client message and `fromAgent(message)` for each
// adapter message (true: taken, do not forward), and gives `send` (to the adapter) and `forward` (to the client).
import { mkdirSync, readFileSync, renameSync, writeFileSync } from "node:fs";
import { open, readdir } from "node:fs/promises";
import { homedir } from "node:os";
import { dirname, join } from "node:path";

const SET_METHODS = new Set(["session/set_config_option", "session/set_model", "session/set_mode"]);
const OPEN_METHODS = new Set(["session/load", "session/resume"]);
const LEGACY_SETTERS = { "session/set_model": ["model", "modelId"], "session/set_mode": ["mode", "modeId"] };
const RESTORE_PREFIX = "restore:";
const RESTORE_TIMEOUT_MS = 30_000;
const MAX_SESSIONS = 300;
const TRANSCRIPT_TAIL_BYTES = 512 * 1024;
const MODEL_FAMILIES = ["opus", "sonnet", "haiku", "fable", "mythos"];
const SLOT_ORDER = ["model", "effort", "ultracode", "fast"];

function defaultStateFile() {
  if (process.env.CLAUDIO_ZED_STATE_FILE) return process.env.CLAUDIO_ZED_STATE_FILE;
  const state = process.env.XDG_STATE_HOME || join(homedir(), ".local", "state");
  return join(state, "claude-acp-proxy", "sessions.json");
}

function report(error) {
  console.error(`session config: ${error?.message ?? error}`);
}

export class SessionConfigMemory {
  #file;
  #send;
  #forward;
  #sessions;
  #setRequests = new Map();
  #openRequests = new Map();
  #restoreReplies = new Map();
  #sequence = 0;

  constructor({ send, forward, file = defaultStateFile() }) {
    this.#send = send;
    this.#forward = forward;
    this.#file = file;
    this.#sessions = this.#read();
  }

  fromClient(message) {
    try {
      if (message?.id === undefined || typeof message.method !== "string") return;
      const sessionId = message.params?.sessionId;
      if (typeof sessionId !== "string") return;
      if (SET_METHODS.has(message.method)) this.#setRequests.set(message.id, message);
      else if (OPEN_METHODS.has(message.method)) this.#openRequests.set(message.id, sessionId);
    } catch (error) {
      report(error);
    }
  }

  fromAgent(message) {
    try {
      return this.#takeFromAgent(message);
    } catch (error) {
      report(error);
      return false;
    }
  }

  #takeFromAgent(message) {
    if (message?.id === undefined || message.method !== undefined) return false;
    if (typeof message.id === "string" && message.id.startsWith(RESTORE_PREFIX)) {
      this.#restoreReplies.get(message.id)?.(message);
      return true;
    }
    const request = this.#setRequests.get(message.id);
    if (request) {
      this.#setRequests.delete(message.id);
      if (!message.error) this.#remember(request);
      return false;
    }
    const sessionId = this.#openRequests.get(message.id);
    if (sessionId === undefined) return false;
    this.#openRequests.delete(message.id);
    if (message.error) return false;
    this.#restore(sessionId, message)
      .catch(report)
      .then(() => this.#forward(message))
      .catch(report);
    return true;
  }

  #remember(request) {
    const { sessionId } = request.params;
    this.#refresh();
    const session = (this.#sessions[sessionId] ??= { calls: {} });
    session.updated = Date.now();
    session.calls[slotOf(request)] = { method: request.method, params: request.params };
    this.#write();
  }

  async #restore(sessionId, response) {
    this.#refresh();
    const session = this.#sessions[sessionId];
    const configOptions = response.result?.configOptions;
    let calls = session ? Object.values(session.calls) : [];
    let bootstrap;
    if (calls.length === 0) {
      bootstrap = await this.#bootstrapModel(sessionId, configOptions);
      if (!bootstrap) return;
      calls = [bootstrap];
    }
    calls.sort((a, b) => rank(slotOf(a)) - rank(slotOf(b)));

    let restored;
    const deadline = Date.now() + RESTORE_TIMEOUT_MS;
    for (const call of calls) {
      const sent = asConfigOption(call, configOptions);
      const reply = await this.#request(sent.method, sent.params, deadline - Date.now());
      if (reply.timedOut) break;
      if (reply.error) continue;
      if (call === bootstrap) this.#remember(call);
      if (Array.isArray(reply.result?.configOptions)) restored = reply.result.configOptions;
    }
    if (!restored || !response.result) return;
    response.result.configOptions = restored;
    // The legacy fields are not part of the option list.
    const mode = restored.find((option) => option.id === "mode")?.currentValue;
    if (mode && response.result.modes) response.result.modes.currentModeId = mode;
    const model = restored.find((option) => option.id === "model")?.currentValue;
    if (model && response.result.models) response.result.models.currentModelId = model;
    if (session) {
      session.updated = Date.now();
      this.#write();
    }
  }

  #request(method, params, timeoutMs) {
    if (timeoutMs <= 0) return Promise.resolve({ timedOut: true });
    const id = `${RESTORE_PREFIX}${++this.#sequence}`;
    return new Promise((resolve) => {
      const finish = (reply) => {
        clearTimeout(timer);
        this.#restoreReplies.delete(id);
        resolve(reply);
      };
      const timer = setTimeout(() => finish({ timedOut: true }), timeoutMs);
      this.#restoreReplies.set(id, finish);
      this.#send({ jsonrpc: "2.0", id, method, params });
    });
  }

  async #bootstrapModel(sessionId, configOptions) {
    const modelOption = configOptions?.find((option) => option.id === "model");
    if (!modelOption || !Array.isArray(modelOption.options)) return undefined;
    const transcriptModel = await lastTranscriptModel(sessionId);
    const family = MODEL_FAMILIES.find((name) => transcriptModel?.includes(name));
    if (!family || modelOption.currentValue === family) return undefined;
    if (!modelOption.options.some((option) => option.value === family)) return undefined;
    return {
      method: "session/set_config_option",
      params: { sessionId, configId: "model", value: family },
    };
  }

  // Another Zed window runs its own proxy on the same file.
  #refresh() {
    this.#sessions = { ...this.#sessions, ...this.#read() };
  }

  #read() {
    try {
      const { sessions } = JSON.parse(readFileSync(this.#file, "utf8"));
      return Object.fromEntries(Object.entries(sessions ?? {}).filter(([, session]) => isSession(session)));
    } catch {
      return {};
    }
  }

  #write() {
    try {
      const newest = Object.entries(this.#sessions)
        .sort(([, a], [, b]) => (b.updated ?? 0) - (a.updated ?? 0))
        .slice(0, MAX_SESSIONS);
      this.#sessions = Object.fromEntries(newest);
      mkdirSync(dirname(this.#file), { recursive: true });
      const temporary = `${this.#file}.${process.pid}.tmp`;
      writeFileSync(temporary, `${JSON.stringify({ sessions: this.#sessions }, null, 1)}\n`);
      renameSync(temporary, this.#file);
    } catch (error) {
      report(`could not save: ${error?.message ?? error}`);
    }
  }
}

function isSession(session) {
  const calls = session?.calls;
  if (typeof calls !== "object" || calls === null) return false;
  return Object.values(calls).every((call) => typeof call?.method === "string" && typeof call.params?.sessionId === "string");
}

/** The option a request sets, so that the legacy and the option form of one setting share a slot. */
function slotOf(call) {
  if (call.method === "session/set_config_option") return String(call.params.configId);
  return LEGACY_SETTERS[call.method]?.[0] ?? call.method;
}

/** A legacy request becomes the option request when the adapter offers that option: its reply has the new option list. */
function asConfigOption(call, configOptions) {
  const legacy = LEGACY_SETTERS[call.method];
  if (!legacy || !configOptions?.some((option) => option.id === legacy[0])) return call;
  const [configId, field] = legacy;
  return { method: "session/set_config_option", params: { sessionId: call.params.sessionId, configId, value: call.params[field] } };
}

/** The model goes first: a model can change which efforts are offered. */
function rank(slot) {
  const index = SLOT_ORDER.indexOf(slot);
  return index === -1 ? SLOT_ORDER.length : index;
}

async function lastTranscriptModel(sessionId) {
  const projects = join(process.env.CLAUDE_CONFIG_DIR ?? join(homedir(), ".claude"), "projects");
  let directories;
  try {
    directories = await readdir(projects);
  } catch {
    return undefined;
  }
  for (const directory of directories) {
    let handle;
    try {
      handle = await open(join(projects, directory, `${sessionId}.jsonl`), "r");
    } catch {
      continue;
    }
    try {
      const { size } = await handle.stat();
      const length = Math.min(size, TRANSCRIPT_TAIL_BYTES);
      const tail = Buffer.alloc(length);
      await handle.read(tail, 0, length, size - length);
      const models = [...tail.toString("utf8").matchAll(/"model":"(claude-[^"]+)"/g)];
      return models.at(-1)?.[1];
    } finally {
      await handle.close();
    }
  }
  return undefined;
}
