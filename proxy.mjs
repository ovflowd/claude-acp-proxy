// An ACP agent for editors such as Zed. It runs claude-agent-acp, changes the requests
// that start a thread, and keeps what each thread was set to (see README.md).
import { spawn } from "node:child_process";
import { existsSync } from "node:fs";
import * as nodeModule from "node:module";
import { createInterface } from "node:readline";
import { fileURLToPath } from "node:url";
import { loadPicker } from "./model-picker.mjs";
import { SessionConfigMemory } from "./session-config.mjs";
import { parseSettingSources, withSettingSources } from "./setting-sources.mjs";
import { Steering } from "./steering.mjs";

const adapter = fileURLToPath(
  new URL(
    "./adapter/node_modules/@agentclientprotocol/claude-agent-acp/dist/index.js",
    import.meta.url,
  ),
);
const sdkHook = new URL("./remote-control.mjs", import.meta.url).href;

if (typeof nodeModule.registerHooks !== "function") {
  console.error(
    `claude-acp-proxy needs Node 22.15 or later, this is ${process.version}.`,
  );
  process.exit(1);
}
if (!existsSync(adapter)) {
  const dir = fileURLToPath(new URL("./adapter", import.meta.url));
  console.error(
    `claude-acp-proxy: the adapter is not installed. Run "npm ci" in ${dir}.`,
  );
  process.exit(1);
}

const settingSources = parseSettingSources(
  process.env.CLAUDE_ACP_PROXY_SETTING_SOURCES,
);

const picker = loadPickerFromEnv(process.env.CLAUDE_ACP_PROXY_PICKER);

const memory =
  process.env.CLAUDE_ACP_PROXY_SESSION_CONFIG === "0"
    ? undefined
    : new SessionConfigMemory({ send: sendToAdapter, forward: sendToClient });

const steering =
  process.env.CLAUDE_ACP_PROXY_STEERING === "1"
    ? new Steering({ send: writeToAdapter, forward: sendToClient })
    : undefined;

const child = spawn(
  process.execPath,
  ["--import", sdkHook, adapter, ...process.argv.slice(2)],
  { stdio: ["pipe", memory || picker || steering ? "pipe" : "inherit", "inherit"] },
);

if (memory || picker || steering) {
  createInterface({ input: child.stdout, crlfDelay: Infinity }).on("line", (line) => {
    const out = fromAdapter(line);
    if (out !== undefined) process.stdout.write(`${out}\n`);
  });
}

createInterface({ input: process.stdin, crlfDelay: Infinity })
  .on("line", (line) => {
    const out = fromClient(line);
    if (out !== undefined) child.stdin.write(`${out}\n`);
  })
  .on("close", () => child.stdin.end());

function loadPickerFromEnv(file) {
  if (!file) return undefined;
  try {
    return loadPicker(file);
  } catch (error) {
    console.error(
      `claude-acp-proxy: cannot use CLAUDE_ACP_PROXY_PICKER: ${error.message}`,
    );
    process.exit(1);
  }
}

// A request of the memory for a model that the picker hides gets the answer of an
// adapter that refuses it, so the thread keeps the model that it has.
function sendToAdapter(message) {
  if (picker?.picksHiddenModel(message)) {
    const error = { code: -32602, message: "The picker hides this model" };
    setImmediate(() => memory.fromAgent({ jsonrpc: "2.0", id: message.id, error }));
    return;
  }
  writeToAdapter(message);
}

function writeToAdapter(message) {
  child.stdin.write(`${JSON.stringify(message)}\n`);
}

function sendToClient(message) {
  picker?.apply(message);
  process.stdout.write(`${JSON.stringify(message)}\n`);
}

// Returns the line to pass on, or undefined when the memory took the message.
function fromAdapter(line) {
  const isUpdate = line.includes('"method":"session/update"');
  if (isUpdate && !line.includes("config_option_update")) return line;
  const message = parse(line);
  if (message === undefined) return line;
  if (memory?.fromAgent(message) || steering?.fromAgent(message)) return undefined;
  return picker?.apply(message) ? JSON.stringify(message) : line;
}

function parse(line) {
  try {
    return JSON.parse(line);
  } catch {
    return undefined;
  }
}

// Returns the line to pass on, or undefined when nothing is left of it.
function fromClient(line) {
  const parsed = parse(line);
  if (parsed === undefined) return line;
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
}

// The adapter's last lines can still be in the pipe when it exits.
child.on("exit", (code) => {
  const finish = () => process.stdout.write("", () => process.exit(code ?? 1));
  if (!child.stdout || child.stdout.readableEnded) return finish();
  child.stdout.once("end", finish);
  setTimeout(finish, 2000).unref();
});
for (const signal of ["SIGINT", "SIGTERM", "SIGHUP"])
  process.on(signal, () => child.kill(signal));
