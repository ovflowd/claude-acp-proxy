import { randomUUID } from "node:crypto";

import { logProblem } from "./log.mjs";

/** @typedef {import("./protocol.mjs").Message} Message */

/**
 * @typedef {object} Turn
 * @property {Message["id"]} promptId The prompt that started the turn at the adapter.
 * @property {Message["id"]} waiting The editor's prompt that the turn's answer goes to.
 * @property {Message | undefined} prompt That prompt.
 * @property {boolean} released Whether the editor was told the turn was cancelled.
 * @property {boolean} steering Whether a steering request is on its way.
 * @property {ReturnType<typeof setTimeout> | undefined} timer The held cancel.
 * @property {Message | undefined} final The turn's answer, when it came before the steering reply.
 */

const STEER_METHOD = "_session/steering";
const CANCEL_WINDOW_MS = 300;

/** @param {unknown} problem */
const report = (problem) => logProblem("steering", problem);

/**
 * Turns "stop, then send a new message" into a message that steers the running turn.
 *
 * An editor that interrupts sends `session/cancel`, waits for the answer to the running prompt, and only then
 * sends the new `session/prompt`. So the cancel is held back and the running prompt is answered as cancelled at
 * once. A prompt that follows within the window is sent as `_session/steering`, and the real answer of the turn
 * then answers that prompt. With no prompt, the cancel goes to the adapter when the window is over.
 *
 * Nothing changes unless the adapter advertises steering in `initialize`.
 */
export class Steering {
  /** @type {(message: Message) => void} */
  #send;
  /** @type {(message: Message) => void} */
  #forward;
  /** @type {number} */
  #windowMs;
  #prefix = `steer:${randomUUID()}:`;
  #sequence = 0;
  #supported = false;
  /** @type {Set<Message["id"]>} */
  #initializeIds = new Set();
  /** @type {Map<string, Turn>} */
  #turns = new Map();
  /** @type {Map<Message["id"], string>} */
  #turnIdByPromptId = new Map();
  /** @type {Set<Message["id"]>} */
  #orphans = new Set();
  /** @type {Map<Message["id"], string>} */
  #steers = new Map();

  /**
   * @param {object} options
   * @param {(message: Message) => void} options.send To the adapter.
   * @param {(message: Message) => void} options.forward To the editor.
   * @param {number} [options.windowMs] How long a cancel is held back.
   */
  constructor({ send, forward, windowMs = CANCEL_WINDOW_MS }) {
    this.#send = send;
    this.#forward = forward;
    this.#windowMs = windowMs;
  }

  /**
   * @param {Message} message
   * @returns {Message | undefined} The message to pass on, or undefined when steering took it.
   */
  fromClient(message) {
    try {
      return this.#fromClient(message);
    } catch (error) {
      report(error);
      return message;
    }
  }

  /**
   * @param {Message} message
   * @returns {boolean} True when steering took the message, which must then not be forwarded.
   */
  fromAgent(message) {
    try {
      return this.#fromAgent(message);
    } catch (error) {
      report(error);
      return false;
    }
  }

  /** @param {Message} message */
  #fromClient(message) {
    if (message?.method === "initialize" && message.id !== undefined) {
      this.#initializeIds.add(message.id);
      return message;
    }
    const sessionId = message?.params?.sessionId;
    if (typeof sessionId !== "string") return message;
    if (message.method === "session/prompt" && message.id !== undefined) return this.#prompt(sessionId, message);
    if (message.method === "session/cancel") return this.#cancel(sessionId, message);
    return message;
  }

  /**
   * @param {string} sessionId
   * @param {Message} message
   */
  #prompt(sessionId, message) {
    const turn = this.#turns.get(sessionId);
    if (!turn?.released || !turn.timer) {
      this.#begin(sessionId, message);
      return message;
    }
    clearTimeout(turn.timer);
    turn.timer = undefined;
    turn.waiting = message.id;
    turn.prompt = message;
    turn.steering = true;
    const id = `${this.#prefix}${++this.#sequence}`;
    this.#steers.set(id, sessionId);
    this.#send({
      jsonrpc: "2.0",
      id,
      method: STEER_METHOD,
      params: {
        sessionId,
        prompt: message.params.prompt,
        _meta: { steering: { idleBehavior: "promptRequired" } },
      },
    });
    return undefined;
  }

  /**
   * @param {string} sessionId
   * @param {Message} message
   */
  #cancel(sessionId, message) {
    const turn = this.#turns.get(sessionId);
    if (!this.#supported || !turn) return message;
    if (turn.timer) return undefined;
    if (turn.waiting === undefined) return message;
    this.#answer(turn.waiting, turn.prompt, { stopReason: "cancelled" });
    turn.waiting = undefined;
    turn.prompt = undefined;
    turn.released = true;
    turn.timer = setTimeout(() => {
      turn.timer = undefined;
      this.#send(message);
    }, this.#windowMs);
    turn.timer.unref?.();
    return undefined;
  }

  /** @param {Message} message */
  #fromAgent(message) {
    if (message?.id === undefined || message.method !== undefined) return false;
    if (this.#initializeIds.delete(message.id)) {
      this.#supported = message.result?._meta?.steering?.supported === true;
      return false;
    }
    if (this.#steers.has(message.id)) {
      this.#steerReply(message);
      return true;
    }
    const sessionId = this.#turnIdByPromptId.get(message.id);
    if (sessionId === undefined) return false;
    this.#turnIdByPromptId.delete(message.id);
    // The editor was answered for this prompt already, and has moved on.
    if (this.#orphans.delete(message.id)) return true;
    const turn = this.#turns.get(sessionId);
    if (turn?.promptId !== message.id) return false;
    if (turn.steering) {
      turn.final = message;
      return true;
    }
    return this.#finish(sessionId, turn, message);
  }

  /**
   * The adapter answered the turn that the editor started: pass the answer on.
   *
   * @param {string} sessionId
   * @param {Turn} turn
   * @param {Message} message
   */
  #finish(sessionId, turn, message) {
    clearTimeout(turn.timer);
    this.#turns.delete(sessionId);
    if (turn.waiting === undefined) return true;
    if (turn.waiting === message.id) return false;
    this.#answer(turn.waiting, turn.prompt, message.result, message.error);
    return true;
  }

  /** @param {Message} message */
  #steerReply(message) {
    const sessionId = this.#steers.get(message.id);
    this.#steers.delete(message.id);
    const turn = sessionId === undefined ? undefined : this.#turns.get(sessionId);
    if (!turn || sessionId === undefined) return;
    turn.steering = false;
    const prompt = turn.prompt;
    const stillWanted = prompt !== undefined && turn.waiting === prompt.id;
    if (!stillWanted || message.result?.outcome === "injected") {
      if (turn.final) this.#finish(sessionId, turn, turn.final);
      return;
    }
    // The turn is over, or cannot be steered: the prompt goes the ordinary way.
    this.#begin(sessionId, prompt);
    this.#send(prompt);
  }

  /**
   * @param {string} sessionId
   * @param {Message} prompt
   */
  #begin(sessionId, prompt) {
    const previous = this.#turns.get(sessionId);
    clearTimeout(previous?.timer);
    if (previous && this.#turnIdByPromptId.has(previous.promptId)) this.#orphans.add(previous.promptId);
    const promptId = prompt.id;
    this.#turns.set(sessionId, {
      promptId,
      waiting: promptId,
      prompt,
      released: false,
      steering: false,
      timer: undefined,
      final: undefined,
    });
    this.#turnIdByPromptId.set(promptId, sessionId);
  }

  /**
   * @param {Message["id"]} id
   * @param {Message | undefined} prompt
   * @param {any} result
   * @param {any} [error]
   */
  #answer(id, prompt, result, error) {
    const messageId = prompt?.params?.messageId;
    const withId = messageId === undefined || !result ? result : { ...result, userMessageId: messageId };
    this.#forward({ jsonrpc: "2.0", id, ...(error ? { error } : { result: withId }) });
  }
}
