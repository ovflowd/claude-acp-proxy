import { spawn } from "node:child_process";
import { existsSync } from "node:fs";
import { createInterface } from "node:readline";
import { fileURLToPath } from "node:url";

import { parseLine } from "./protocol.mjs";
import { SessionConfigMemory } from "./session-config.mjs";
import { withSettingSources } from "./setting-sources.mjs";
import { Steering } from "./steering.mjs";

/** @typedef {import("./config.mjs").Config} Config */
/** @typedef {import("./model-picker.mjs").Picker} Picker */
/** @typedef {import("./protocol.mjs").Message} Message */

/**
 * @typedef {object} Router
 * @property {boolean} routesAdapterOutput Whether anything needs to see the adapter's output. When nothing does,
 *   the adapter writes to the editor directly.
 * @property {(line: string) => string | undefined} fromClient Takes a line from the editor and returns the line
 *   to send to the adapter, or undefined when nothing is left of it.
 * @property {(line: string) => string | undefined} fromAdapter Takes a line from the adapter and returns the line
 *   to send to the editor, or undefined when a part of the proxy took it.
 */

const ADAPTER = "@agentclientprotocol/claude-agent-acp/dist/index.js";
const SDK_HOOK = new URL("./sdk/register.mjs", import.meta.url).href;
// The adapter's last lines can still be in the pipe when it exits.
const EXIT_GRACE_MS = 2000;

/** @returns {string | undefined} The adapter's entry point, or undefined when it is not installed. */
export function resolveAdapter() {
  let path;
  try {
    path = fileURLToPath(import.meta.resolve(ADAPTER));
  } catch {
    return undefined;
  }
  // A subpath export resolves whether or not the file is there.
  return existsSync(path) ? path : undefined;
}

/**
 * Starts the adapter, connects it to this process's stdin and stdout, and exits with it.
 *
 * @param {object} options
 * @param {string} options.adapter
 * @param {Config} options.config
 * @param {Picker} [options.picker]
 * @param {string[]} options.args Passed on to the adapter.
 */
export function startProxy({ adapter, config, picker, args }) {
  const router = createRouter({
    config,
    picker,
    toAdapter: (line) => adapterInput.write(`${line}\n`),
    toClient: (line) => process.stdout.write(`${line}\n`),
  });

  const child = spawn(process.execPath, ["--import", SDK_HOOK, adapter, ...args], {
    stdio: ["pipe", router.routesAdapterOutput ? "pipe" : "inherit", "inherit"],
  });
  // Always a pipe: the stdio option above says so, but its types cannot tell for a choice made at run time.
  const adapterInput = /** @type {import("node:stream").Writable} */ (child.stdin);

  if (child.stdout) {
    createInterface({ input: child.stdout, crlfDelay: Infinity }).on("line", (line) => {
      const out = router.fromAdapter(line);
      if (out !== undefined) process.stdout.write(`${out}\n`);
    });
  }

  createInterface({ input: process.stdin, crlfDelay: Infinity })
    .on("line", (line) => {
      const out = router.fromClient(line);
      if (out !== undefined) adapterInput.write(`${out}\n`);
    })
    .on("close", () => adapterInput.end());

  child.on("exit", (code) => {
    const finish = () => process.stdout.write("", () => process.exit(code ?? 1));
    if (!child.stdout || child.stdout.readableEnded) {
      finish();
      return;
    }
    child.stdout.once("end", finish);
    setTimeout(finish, EXIT_GRACE_MS).unref();
  });

  for (const signal of /** @type {const} */ (["SIGINT", "SIGTERM", "SIGHUP"])) {
    process.on(signal, () => child.kill(signal));
  }
}

/**
 * Routes lines between the editor and the adapter through the parts of the proxy that are turned on.
 *
 * @param {object} options
 * @param {Config} options.config
 * @param {Picker} [options.picker]
 * @param {(line: string) => void} options.toAdapter Writes a line that a part of the proxy sends to the adapter.
 * @param {(line: string) => void} options.toClient Writes a line that a part of the proxy sends to the editor.
 * @returns {Router}
 */
export function createRouter({ config, picker, toAdapter, toClient }) {
  const { settingSources } = config;
  const memory = config.sessionConfig
    ? new SessionConfigMemory({
        send: sendToAdapter,
        forward: sendToClient,
        file: config.stateFile,
        claudeConfigDir: config.claudeConfigDir,
      })
    : undefined;
  const steering = config.steering ? new Steering({ send: writeToAdapter, forward: sendToClient }) : undefined;

  /**
   * A request of the memory for a model that the picker hides gets the answer of an adapter that refuses it, so
   * the thread keeps the model that it has.
   *
   * @param {Message} message
   */
  function sendToAdapter(message) {
    if (picker?.picksHiddenModel(message)) {
      const error = { code: -32602, message: "The picker hides this model" };
      setImmediate(() => memory?.fromAgent({ jsonrpc: "2.0", id: message.id, error }));
      return;
    }
    writeToAdapter(message);
  }

  /** @param {Message} message */
  function writeToAdapter(message) {
    toAdapter(JSON.stringify(message));
  }

  /** @param {Message} message */
  function sendToClient(message) {
    picker?.apply(message);
    toClient(JSON.stringify(message));
  }

  return {
    routesAdapterOutput: Boolean(memory || picker || steering),

    fromClient(line) {
      const parsed = parseLine(line);
      if (parsed === undefined) return line;
      /** @type {Message[]} */
      const kept = [];
      let changed = false;
      for (const message of Array.isArray(parsed) ? parsed : [parsed]) {
        memory?.fromClient(message);
        if (settingSources && withSettingSources(message, settingSources)) changed = true;
        const out = steering ? steering.fromClient(message) : message;
        if (out !== message) changed = true;
        if (out !== undefined) kept.push(out);
      }
      if (!changed) return line;
      if (kept.length === 0) return undefined;
      return JSON.stringify(Array.isArray(parsed) ? kept : kept[0]);
    },

    fromAdapter(line) {
      // Streamed output is most of the traffic, and only an option update in it matters here.
      const isUpdate = line.includes('"method":"session/update"');
      if (isUpdate && !line.includes("config_option_update")) return line;
      const message = /** @type {Message | undefined} */ (parseLine(line));
      if (message === undefined) return line;
      if (memory?.fromAgent(message) || steering?.fromAgent(message)) return undefined;
      return picker?.apply(message) ? JSON.stringify(message) : line;
    },
  };
}
