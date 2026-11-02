# claude-acp-proxy

A thin wrapper around [`@agentclientprotocol/claude-agent-acp`](https://github.com/agentclientprotocol/claude-agent-acp), the adapter that lets Zed (or any ACP client) drive Claude Code. It runs the adapter the way a terminal `claude --setting-sources user` runs, and turns Remote Control on for every thread.

## What it changes

- **User settings only.** `proxy.mjs` adds `settingSources: ["user"]` to every `session/new`, `session/load`, `session/resume` and `session/fork` through `_meta.claudeCode.options`. Left alone, the adapter loads `user,project,local`, so a cloned repo's `.claude/settings.json` hooks run with no trust prompt.
- **Remote Control on by default.** Under the SDK the CLI only reports `remote_control_auto_enable` and leaves the `enableRemoteControl()` call to the host, which the adapter never makes. `remote-control.mjs` is loaded with `node --import`. It registers a `module.registerHooks` resolve and load hook that serves `remote-control-sdk.mjs` in place of `@anthropic-ai/claude-agent-sdk`. The shim re-exports the SDK and wraps `query()` to call `enableRemoteControl(true)` once the session has initialized. It skips the call when the account reports `remote_control_available: false`. Set `CLAUDIO_ZED_REMOTE_CONTROL=0` in the agent's `env` to turn it off.

The shim is served at the SDK's own URL plus a `?remote-control` query. The adapter finds the CLI binary with `createRequire(import.meta.resolve(SDK))`, so a shim served from anywhere else fails with "Claude native binary not found".

## Install

```sh
git clone git@github.com:ovflowd/claude-acp-proxy.git ~/.local/share/claude-acp-proxy
cd ~/.local/share/claude-acp-proxy/adapter
npm ci
```

Use the public npm registry. The lockfile only references `registry.npmjs.org`; on a machine whose global `.npmrc` points elsewhere, pass `--registry=https://registry.npmjs.org/` (and set `pnpm_config_registry` / `npm_config_registry` if you use pnpm). Node 22.15 or later, for `module.registerHooks` (developed on Node 24).

## Zed

```jsonc
"agent_servers": {
  "claude": {
    "type": "custom",
    "command": "node",              // an absolute path is safer: /usr/bin/node, /opt/homebrew/bin/node
    "args": ["/absolute/path/to/claude-acp-proxy/proxy.mjs"],
    "env": {
      // Which Claude Code profile the threads use. Leave it out for the default one.
      "CLAUDE_CONFIG_DIR": "/home/you/.claude-personal"
    }
  }
}
```

`CLAUDE_CONFIG_DIR` decides whose settings, MCP servers and transcripts a Zed thread uses, so set it deliberately on a machine that has more than one profile.

## Upgrading the adapter

```sh
cd adapter
npm install --save-exact @agentclientprotocol/claude-agent-acp@<version>
grep -c enableRemoteControl node_modules/@anthropic-ai/claude-agent-sdk/sdk.mjs   # must not be 0
```

`enableRemoteControl` is not in the SDK's public types, so the grep is the check that the shim still has something to call. Also confirm that `_meta.claudeCode.options.settingSources` still wins over the adapter's own default: open a thread in a repo with a `CLAUDE.md` and check that it stays out of context.

A thread that was started before the shim loaded gets Remote Control by sending `/remote-control` in it. The adapter matches only the full name, so `/rc` goes to Claude as plain text.
