// Zed's Claude agent, run the way `claudio` runs Claude Code: Zed's env sets CLAUDE_CONFIG_DIR, and
// every session loads user settings only, like `--setting-sources user`. The adapter otherwise also
// loads a repo's .claude/settings.json, whose hooks would run without a trust prompt.
// The adapter runs with remote-control.mjs preloaded (Remote Control, full history), and
// session-config.mjs puts a thread's model, effort and toggles back when Zed opens it again.
import { spawn } from "node:child_process";
import { createInterface } from "node:readline";
import { fileURLToPath } from "node:url";
import { SessionConfigMemory } from "./session-config.mjs";

const adapter = fileURLToPath(
  new URL("./adapter/node_modules/@agentclientprotocol/claude-agent-acp/dist/index.js", import.meta.url),
);
const remoteControl = fileURLToPath(new URL("./remote-control.mjs", import.meta.url));
const SESSION_METHODS = new Set(["session/new", "session/load", "session/resume", "session/fork"]);

const memory =
  process.env.CLAUDIO_ZED_SESSION_CONFIG === "0"
    ? undefined
    : new SessionConfigMemory({
        send: (message) => child.stdin.write(`${JSON.stringify(message)}\n`),
        forward: (message) => process.stdout.write(`${JSON.stringify(message)}\n`),
      });

const child = spawn(process.execPath, ["--import", remoteControl, adapter, ...process.argv.slice(2)], {
  stdio: ["pipe", memory ? "pipe" : "inherit", "inherit"],
});

if (memory) {
  createInterface({ input: child.stdout, crlfDelay: Infinity }).on("line", (line) => {
    if (!line.includes('"method":"session/update"') && memory.fromAgent(parse(line))) return;
    process.stdout.write(`${line}\n`);
  });
}

createInterface({ input: process.stdin, crlfDelay: Infinity })
  .on("line", (line) => child.stdin.write(`${withUserSettingsOnly(line)}\n`))
  .on("close", () => child.stdin.end());

function parse(line) {
  try {
    return JSON.parse(line);
  } catch {
    return undefined;
  }
}

function withUserSettingsOnly(line) {
  const message = parse(line);
  if (message === undefined) return line;
  memory?.fromClient(message);
  if (!SESSION_METHODS.has(message?.method) || typeof message.params !== "object") return line;
  const claudeCode = ((message.params._meta ??= {}).claudeCode ??= {});
  claudeCode.options = { ...claudeCode.options, settingSources: ["user"] };
  return JSON.stringify(message);
}

// The adapter's last lines can still be in the pipe when it exits.
child.on("exit", (code) => {
  const finish = () => process.stdout.write("", () => process.exit(code ?? 1));
  if (!memory || child.stdout.readableEnded) return finish();
  child.stdout.once("end", finish);
  setTimeout(finish, 2000).unref();
});
for (const signal of ["SIGINT", "SIGTERM", "SIGHUP"]) process.on(signal, () => child.kill(signal));
