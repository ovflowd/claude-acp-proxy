// Zed's Claude agent, run the way `claudio` runs Claude Code: Zed's env sets
// CLAUDE_CONFIG_DIR, and every session loads user settings only, like
// `--setting-sources user`. The adapter otherwise also loads a repo's
// .claude/settings.json, whose hooks would run without a trust prompt.
// The adapter also runs with remote-control.mjs preloaded, which turns
// Remote Control on for every session.
import { spawn } from "node:child_process";
import { createInterface } from "node:readline";
import { fileURLToPath } from "node:url";

const adapter = fileURLToPath(
  new URL("./adapter/node_modules/@agentclientprotocol/claude-agent-acp/dist/index.js", import.meta.url),
);
const remoteControl = fileURLToPath(new URL("./remote-control.mjs", import.meta.url));
const SESSION_METHODS = new Set(["session/new", "session/load", "session/resume", "session/fork"]);

const child = spawn(process.execPath, ["--import", remoteControl, adapter, ...process.argv.slice(2)], {
  stdio: ["pipe", "inherit", "inherit"],
});

createInterface({ input: process.stdin, crlfDelay: Infinity })
  .on("line", (line) => child.stdin.write(`${withUserSettingsOnly(line)}\n`))
  .on("close", () => child.stdin.end());

function withUserSettingsOnly(line) {
  let message;
  try {
    message = JSON.parse(line);
  } catch {
    return line;
  }
  if (!SESSION_METHODS.has(message?.method) || typeof message.params !== "object") return line;
  const claudeCode = ((message.params._meta ??= {}).claudeCode ??= {});
  claudeCode.options = { ...claudeCode.options, settingSources: ["user"] };
  return JSON.stringify(message);
}

child.on("exit", (code) => process.exit(code ?? 1));
for (const signal of ["SIGINT", "SIGTERM", "SIGHUP"]) process.on(signal, () => child.kill(signal));
