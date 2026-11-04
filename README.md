# claude-acp-proxy

A thin wrapper around [`@agentclientprotocol/claude-agent-acp`](https://github.com/agentclientprotocol/claude-agent-acp), the adapter that lets Zed (or any ACP client) drive Claude Code. It runs the adapter the way a terminal `claude --setting-sources user` runs, turns Remote Control on for every thread, replays a compacted thread in full, and remembers each thread's model, effort and toggles.

## What it changes

- **User settings only.** `proxy.mjs` adds `settingSources: ["user"]` to every `session/new`, `session/load`, `session/resume` and `session/fork` through `_meta.claudeCode.options`. Left alone, the adapter loads `user,project,local`, so a cloned repo's `.claude/settings.json` hooks run with no trust prompt.
- **Remote Control on by default.** Under the SDK the CLI only reports `remote_control_auto_enable` and leaves the `enableRemoteControl()` call to the host, which the adapter never makes. `remote-control.mjs` is loaded with `node --import`. It registers a `module.registerHooks` resolve and load hook that serves `remote-control-sdk.mjs` in place of `@anthropic-ai/claude-agent-sdk`. The shim re-exports the SDK and wraps `query()` to call `enableRemoteControl(true)` once the session has initialized, unless the account reports `remote_control_available: false`. The shim is served at the SDK's own URL plus a `?remote-control` query, because the adapter finds the CLI binary with `createRequire(import.meta.resolve(SDK))` and a shim served from anywhere else fails with "Claude native binary not found". `CLAUDIO_ZED_REMOTE_CONTROL=0` turns it off.
- **Full history after a compaction.** The SDK builds a thread's history from its last message up through `parentUuid` and stops at the last `compact_boundary`, so Zed reopens a compacted thread from its summary on while Claude still has the whole conversation. The shim's `getSessionMessages` reads the transcript itself and puts the history from before each compaction in front of the SDK's messages, prompts typed while Claude was working and background-task notifications included. It changes every call without options, which is the replay (`resumed-session.js`, `acp-agent.js`) and the fork point lookup (`fork-session.js`). A call with options is left alone. `CLAUDIO_ZED_FULL_HISTORY=0` turns it off.
- **Model, effort and toggles per thread.** Zed applies `default_config_options` to new sessions only. On `session/load` and `session/resume` it shows what the adapter answers, and the adapter answers from the user settings (`model`, the per-model `effortLevel`), so a reopened thread went back to the default model and effort. `session-config.mjs` records the last successful `session/set_config_option`, `session/set_model` and `session/set_mode` request of each of the newest 300 sessions in `sessions.json`. When a load or resume succeeds, it sends them to the adapter again, holds the load response until they are done (at most 30 s), and gives Zed the option list that the last one returned. A thread without a record takes the model family of its transcript. `CLAUDIO_ZED_SESSION_CONFIG=0` turns it off. The file is in `$XDG_STATE_HOME/claude-acp-proxy/` (default `~/.local/state`); `CLAUDIO_ZED_STATE_FILE` moves it.

Not covered: the adapter publishes background tasks as async tasks only to a client that advertises JetBrains AIR's capability, so Zed does not show a task that runs.

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

A thread that was started before the shim loaded gets Remote Control by sending `/remote-control` in it. The adapter matches only the full name, so `/rc` goes to Claude as plain text.

## Upgrading the adapter

```sh
cd adapter
npm install --save-exact @agentclientprotocol/claude-agent-acp@<version>
grep -c enableRemoteControl node_modules/@anthropic-ai/claude-agent-sdk/sdk.mjs   # must not be 0
```

`enableRemoteControl` is not in the SDK's public types, so the grep is the check that the shim still has something to call. Then check in Zed:

- A thread in a repo with a `CLAUDE.md` keeps it out of context (`_meta.claudeCode.options.settingSources` still wins over the adapter's default).
- A compacted thread's history starts before its summary.
- A thread changed to another model and effort comes back as it was after Zed restarts.

## Using `session-config.mjs` in another proxy

It has no dependency on `proxy.mjs`. `new SessionConfigMemory({ send, forward, file? })` takes:

- `send(message)`, which writes a JSON-RPC request to the adapter. The restore requests are Zed's own requests again, so run them through the same rewriting as a message from the client (a picker, an effort mapping).
- `forward(message)`, which writes the held load or resume response to the client. Run it through the rewriting of an adapter response too.
- `fromClient(message)` for every parsed client message, before any rewriting, so the record holds what Zed sent.
- `fromAgent(message)` for every parsed adapter message. When it returns `true` the message was taken and must not be forwarded. The adapter's stdout has to be piped for this.
