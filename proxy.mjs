// An ACP agent for editors such as Zed. It runs claude-agent-acp, changes the requests
// that start a thread, and keeps what each thread was set to (see README.md).
import { spawn } from "node:child_process";
import { existsSync } from "node:fs";
import * as nodeModule from "node:module";
import { createInterface } from "node:readline";
import { fileURLToPath } from "node:url";
import { SessionConfigMemory } from "./session-config.mjs";
import { parseSettingSources, withSettingSources } from "./setting-sources.mjs";

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

const memory =
  process.env.CLAUDE_ACP_PROXY_SESSION_CONFIG === "0"
    ? undefined
    : new SessionConfigMemory({
        send: (message) => child.stdin.write(`${JSON.stringify(message)}\n`),
        forward: (message) => process.stdout.write(`${JSON.stringify(message)}\n`),
      });

const child = spawn(
  process.execPath,
  ["--import", sdkHook, adapter, ...process.argv.slice(2)],
  { stdio: ["pipe", memory ? "pipe" : "inherit", "inherit"] },
);

if (memory) {
  createInterface({ input: child.stdout, crlfDelay: Infinity }).on("line", (line) => {
    if (!line.includes('"method":"session/update"') && memory.fromAgent(parse(line)))
      return;
    process.stdout.write(`${line}\n`);
  });
}

createInterface({ input: process.stdin, crlfDelay: Infinity })
  .on("line", (line) => child.stdin.write(`${fromClient(line)}\n`))
  .on("close", () => child.stdin.end());

function parse(line) {
  try {
    return JSON.parse(line);
  } catch {
    return undefined;
  }
}

function fromClient(line) {
  const parsed = parse(line);
  if (parsed === undefined) return line;
  let changed = false;
  for (const message of Array.isArray(parsed) ? parsed : [parsed]) {
    memory?.fromClient(message);
    if (settingSources && withSettingSources(message, settingSources)) changed = true;
  }
  return changed ? JSON.stringify(parsed) : line;
}

// The adapter's last lines can still be in the pipe when it exits.
child.on("exit", (code) => {
  const finish = () => process.stdout.write("", () => process.exit(code ?? 1));
  if (!memory || child.stdout.readableEnded) return finish();
  child.stdout.once("end", finish);
  setTimeout(finish, 2000).unref();
});
for (const signal of ["SIGINT", "SIGTERM", "SIGHUP"])
  process.on(signal, () => child.kill(signal));
