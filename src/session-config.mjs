import { randomUUID } from "node:crypto";
import { mkdirSync, readFileSync, renameSync, rmSync, writeFileSync } from "node:fs";
import { dirname } from "node:path";

import { readConfig } from "./config.mjs";
import { logProblem } from "./log.mjs";
import { readTranscriptTail } from "./transcripts.mjs";

/** @typedef {import("./protocol.mjs").Message} Message */

/**
 * A request that set one of a thread's options, as the editor sent it.
 *
 * @typedef {{ method: string, params: { sessionId: string, [key: string]: any } }} Call
 */

/** @typedef {{ updated?: number, calls: Record<string, Call> }} Session */

/** @typedef {{ result?: any, error?: any, timedOut?: boolean }} Reply */

const SET_METHODS = new Set(["session/set_config_option", "session/set_model", "session/set_mode"]);
const OPEN_METHODS = new Set(["session/load", "session/resume"]);
/** @type {Record<string, [configId: string, field: string]>} */
const LEGACY_SETTERS = {
  "session/set_model": ["model", "modelId"],
  "session/set_mode": ["mode", "modeId"],
};
const RESTORE_TIMEOUT_MS = 30_000;
const MAX_SESSIONS = 300;
const TRANSCRIPT_TAIL_BYTES = 512 * 1024;
const MODEL_FAMILIES = ["opus", "sonnet", "haiku", "fable", "mythos"];
// The model goes first: a model can change which efforts are offered.
const SLOT_ORDER = ["model", "effort", "ultracode", "fast"];

/** @param {unknown} problem */
const report = (problem) => logProblem("session config", problem);

/**
 * Puts a thread's model, effort and toggles back when the editor opens it again.
 *
 * Zed applies its `default_config_options` to new sessions only, and shows what the adapter answers on load and
 * resume, which comes from the user's settings. So after a successful load or resume, the memory sends the
 * thread's remembered requests to the adapter again and holds the response until they are done.
 *
 * It does not depend on src/proxy.mjs, only on config.mjs, log.mjs and transcripts.mjs. The host calls `fromClient(message)` for each message from the
 * editor, before any rewriting, and `fromAgent(message)` for each message from the adapter.
 */
export class SessionConfigMemory {
  /** @type {string} */
  #file;
  /** @type {(message: Message) => void} */
  #send;
  /** @type {(message: Message) => void} */
  #forward;
  /** @type {string} */
  #claudeConfigDir;
  /** @type {Record<string, Session>} */
  #sessions;
  /** @type {Map<Message["id"], Call>} */
  #setRequests = new Map();
  /** @type {Map<Message["id"], string>} */
  #openRequests = new Map();
  /** @type {Map<string, (reply: Reply) => void>} */
  #restoreReplies = new Map();
  #sequence = 0;
  // The ids of the requests that the memory sends: a client cannot use one by chance.
  #restorePrefix = `restore:${randomUUID()}:`;

  /**
   * @param {object} options
   * @param {(message: Message) => void} options.send Writes a request to the adapter. The restore requests are the
   *   editor's own requests again, so they should go through the same rewriting as a message from the editor.
   * @param {(message: Message) => void} options.forward Writes the held load or resume response to the editor,
   *   through the same rewriting as any other adapter response.
   * @param {string} [options.file]
   * @param {string} [options.claudeConfigDir] The Claude Code profile, for a thread's model in its transcript.
   */
  constructor({ send, forward, file, claudeConfigDir }) {
    const config = readConfig(process.env, () => {});
    this.#send = send;
    this.#forward = forward;
    this.#file = file ?? config.stateFile;
    this.#claudeConfigDir = claudeConfigDir ?? config.claudeConfigDir;
    this.#sessions = this.#read();
  }

  /** @param {Message} message */
  fromClient(message) {
    try {
      if (message?.id === undefined || typeof message.method !== "string") return;
      const sessionId = message.params?.sessionId;
      if (typeof sessionId !== "string") return;
      if (SET_METHODS.has(message.method)) {
        this.#setRequests.set(message.id, { method: message.method, params: message.params });
      } else if (OPEN_METHODS.has(message.method)) {
        this.#openRequests.set(message.id, sessionId);
      }
    } catch (error) {
      report(error);
    }
  }

  /**
   * @param {Message} message
   * @returns {boolean} True when the memory took the message, which must then not be forwarded.
   */
  fromAgent(message) {
    try {
      return this.#takeFromAgent(message);
    } catch (error) {
      report(error);
      return false;
    }
  }

  /** @param {Message} message */
  #takeFromAgent(message) {
    if (message?.id === undefined || message.method !== undefined) return false;
    if (typeof message.id === "string" && message.id.startsWith(this.#restorePrefix)) {
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

  /** @param {Call} request */
  #remember(request) {
    const { sessionId } = request.params;
    this.#refresh();
    const session = (this.#sessions[sessionId] ??= { calls: {} });
    session.updated = Date.now();
    session.calls[slotOf(request)] = { method: request.method, params: request.params };
    this.#write();
  }

  /**
   * @param {string} sessionId
   * @param {Message} response The adapter's response to the load or resume, changed in place.
   */
  async #restore(sessionId, response) {
    this.#refresh();
    const session = this.#sessions[sessionId];
    const configOptions = response.result?.configOptions;
    let calls = session ? Object.values(session.calls) : [];
    /** @type {Call | undefined} */
    let bootstrap;
    if (calls.length === 0) {
      bootstrap = await this.#bootstrapModel(sessionId, configOptions);
      if (!bootstrap) return;
      calls = [bootstrap];
    }
    calls.sort((a, b) => rank(slotOf(a)) - rank(slotOf(b)));

    /** @type {any[] | undefined} */
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

  /**
   * @param {string} method
   * @param {Call["params"]} params
   * @param {number} timeoutMs
   * @returns {Promise<Reply>}
   */
  #request(method, params, timeoutMs) {
    if (timeoutMs <= 0) return Promise.resolve({ timedOut: true });
    const id = `${this.#restorePrefix}${++this.#sequence}`;
    return new Promise((resolve) => {
      /** @param {Reply} reply */
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

  /**
   * A thread with no record takes the model family of its transcript.
   *
   * @param {string} sessionId
   * @param {any[] | undefined} configOptions
   * @returns {Promise<Call | undefined>}
   */
  async #bootstrapModel(sessionId, configOptions) {
    const modelOption = configOptions?.find((option) => option.id === "model");
    if (!modelOption || !Array.isArray(modelOption.options)) return undefined;
    const tail = await readTranscriptTail(sessionId, this.#claudeConfigDir, TRANSCRIPT_TAIL_BYTES);
    const models = tail === undefined ? [] : [...tail.matchAll(/"model":"(claude-[^"]+)"/g)];
    const transcriptModel = models.at(-1)?.[1];
    const family = MODEL_FAMILIES.find((name) => transcriptModel?.includes(name));
    if (!family || modelOption.currentValue === family) return undefined;
    if (!modelOption.options.some((/** @type {any} */ option) => option.value === family)) return undefined;
    return {
      method: "session/set_config_option",
      params: { sessionId, configId: "model", value: family },
    };
  }

  // Another editor window runs its own proxy on the same file.
  #refresh() {
    this.#sessions = { ...this.#sessions, ...this.#read() };
  }

  /** @returns {Record<string, Session>} */
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
        .toSorted(([, a], [, b]) => (b.updated ?? 0) - (a.updated ?? 0))
        .slice(0, MAX_SESSIONS);
      this.#sessions = Object.fromEntries(newest);
      mkdirSync(dirname(this.#file), { recursive: true, mode: 0o700 });
      // A new file under a name nobody can guess, so a planted link is not followed.
      const temporary = `${this.#file}.${randomUUID()}.tmp`;
      const content = `${JSON.stringify({ sessions: this.#sessions }, null, 1)}\n`;
      try {
        writeFileSync(temporary, content, { mode: 0o600, flag: "wx" });
        renameSync(temporary, this.#file);
      } catch (error) {
        rmSync(temporary, { force: true });
        throw error;
      }
    } catch (error) {
      report(`could not save: ${error instanceof Error ? error.message : error}`);
    }
  }
}

/**
 * @param {any} session
 * @returns {session is Session}
 */
function isSession(session) {
  const calls = session?.calls;
  if (typeof calls !== "object" || calls === null) return false;
  return Object.values(calls).every(
    (call) => typeof call?.method === "string" && typeof call.params?.sessionId === "string",
  );
}

/**
 * The option that a request sets: both forms of one setting share a slot.
 *
 * @param {Call} call
 */
function slotOf(call) {
  if (call.method === "session/set_config_option") return String(call.params.configId);
  return LEGACY_SETTERS[call.method]?.[0] ?? call.method;
}

/**
 * A legacy request becomes the option request when the adapter offers that option, because the reply to the
 * option request has the new option list.
 *
 * @param {Call} call
 * @param {any[] | undefined} configOptions
 * @returns {Call}
 */
function asConfigOption(call, configOptions) {
  const legacy = LEGACY_SETTERS[call.method];
  if (!legacy || !configOptions?.some((option) => option.id === legacy[0])) return call;
  const [configId, field] = legacy;
  return {
    method: "session/set_config_option",
    params: { sessionId: call.params.sessionId, configId, value: call.params[field] },
  };
}

/** @param {string} slot */
function rank(slot) {
  const index = SLOT_ORDER.indexOf(slot);
  return index === -1 ? SLOT_ORDER.length : index;
}
