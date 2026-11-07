# claude-acp-proxy

[![CI](https://github.com/ovflowd/claude-acp-proxy/actions/workflows/ci.yml/badge.svg)](https://github.com/ovflowd/claude-acp-proxy/actions/workflows/ci.yml)
[![License: MIT](https://img.shields.io/badge/license-MIT-blue.svg)](LICENSE)

Safer defaults, full history and per-thread settings for Claude in [Zed](https://zed.dev)
and other [ACP](https://agentclientprotocol.com) editors.

It wraps [`@agentclientprotocol/claude-agent-acp`](https://github.com/agentclientprotocol/claude-agent-acp),
the adapter that lets an ACP editor drive Claude Code, and fixes four things that
surprised its author. It is an unofficial project, not affiliated with Anthropic or Zed.

| Without it | With it |
| --- | --- |
| The adapter loads a repository's own `.claude/settings.json`, so the hooks of a repo you just cloned run with no trust prompt. | Claude Code loads only your user settings, as with `claude --setting-sources user`: a cloned repository's hooks, `CLAUDE.md` and permission rules do not apply. You can choose the sources. |
| A thread that Claude compacted reopens from its summary on. Claude remembers the rest, the editor does not show it. | The whole thread replays, including prompts typed while Claude was working and background-task notifications. |
| A reopened thread forgets its model, effort, Ultracode and fast toggles and goes back to your defaults. | Each thread comes back as you left it. |
| The model list shows every model, including ones you never use, under the names of the adapter. | Optional: a picker file hides models and renames the others. |
| Sending a message while Claude works interrupts the turn: it is cancelled and the new message starts again. | Optional: the message steers the running turn instead. |
| Remote Control is never turned on for editor threads. | Optional: turn it on for every thread. |

## Quick start

You need Node 22.15 or later (on Node 23, 23.5 or later) and a working
[Claude Code](https://claude.com/claude-code) login.

```sh
git clone https://github.com/ovflowd/claude-acp-proxy.git
cd claude-acp-proxy/adapter
npm ci
```

Add the proxy to Zed's `settings.json` as a custom agent, with the absolute path to
`proxy.mjs`:

```jsonc
"agent_servers": {
  "claude": {
    "type": "custom",
    "command": "node", // an absolute path is safer: /usr/bin/node, /opt/homebrew/bin/node
    "args": ["/absolute/path/to/claude-acp-proxy/proxy.mjs"],
    "env": {
      // Which Claude Code profile the threads use. Leave it out for the default one.
      "CLAUDE_CONFIG_DIR": "/home/you/.claude"
    }
  }
}
```

Open a new thread with that agent. To check the settings behavior, make a throwaway
repository with a file `.claude/commands/check.md`, open a thread in it and type `/check`.
With the default, the command does not exist. With
`CLAUDE_ACP_PROXY_SETTING_SOURCES=user,project` it does.

`CLAUDE_CONFIG_DIR` decides whose settings, MCP servers and transcripts a thread uses, so
set it on purpose on a machine with more than one profile.

If your global `.npmrc` points at another registry, add
`--registry=https://registry.npmjs.org/` to `npm ci`: the lockfile only refers to the
public registry.

## Configuration

Set these in the agent's `env`. All are optional.

| Variable | Default | Effect |
| --- | --- | --- |
| `CLAUDE_ACP_PROXY_SETTING_SOURCES` | `user` | Which Claude Code settings load: a comma-separated list of `user`, `project` and `local`, or `default` for the adapter's own choice (all three). The names are lower case. A value that is not valid is ignored with a warning, and `user` is used. |
| `CLAUDE_ACP_PROXY_PICKER` | none | The path of a [picker file](#model-picker) that hides models and renames the others. |
| `CLAUDE_ACP_PROXY_STEERING` | off | `1` makes a message that you send while Claude works steer the running turn instead of cancelling it. See [Steering](#steering). |
| `CLAUDE_ACP_PROXY_REMOTE_CONTROL` | off | `1` (only that value) turns [Remote Control](https://code.claude.com/docs/en/remote-control) on for every thread, so you can pick it up from the Claude app or claude.ai/code. It needs a claude.ai login, not an API key. A failure is written to the agent's stderr as `remote control: …`. See [Security and privacy](#security-and-privacy). |
| `CLAUDE_ACP_PROXY_FULL_HISTORY` | on | `0` goes back to the SDK's history, which starts at the last compaction. |
| `CLAUDE_ACP_PROXY_SESSION_CONFIG` | on | `0` stops remembering per-thread settings. The adapter's stdout then goes straight to the editor. |
| `CLAUDE_ACP_PROXY_STATE_FILE` | `$XDG_STATE_HOME/claude-acp-proxy/sessions.json` | Where the per-thread settings are kept (`~/.local/state` when `XDG_STATE_HOME` is not set). |

A thread that was started before you turned Remote Control on gets it by sending
`/remote-control` in it. The adapter matches only the full name.

## Model picker

`CLAUDE_ACP_PROXY_PICKER` names a JSON file:

```json
{
  "hide": ["^default$", "^claude-.*-4-"],
  "labels": { "opus": "Opus 5.5", "sonnet": "Sonnet 5.5" }
}
```

`hide` is a list of regular expressions, tested against the model values that the adapter
offers (`opus`, `claude-opus-4-8` and so on). `labels` maps a model value to the name that
the editor shows. The model that a thread runs is never hidden, so the list stays valid. A
remembered model that the picker hides is not restored: the thread keeps the model it
starts with. A file that cannot be read stops the proxy with the reason.

## Steering

When you send a message while Claude works, Zed interrupts: it sends `session/cancel`,
waits for the answer to the running prompt, and then sends the new prompt. Claude Code
itself would take the message into the running turn. The adapter has a request for that,
`_session/steering`, but Zed does not use it with an external agent.

With `CLAUDE_ACP_PROXY_STEERING=1` the proxy holds the cancel back for 300 ms and answers
the running prompt as cancelled, so the editor moves on. A prompt that follows in that time
goes to the adapter as `_session/steering`: the turn keeps running, its tool calls are not
killed, and Claude reads the message at its next step. The real answer of the turn then
answers the new prompt. If no prompt follows, the cancel goes to the adapter when the 300 ms
are over, so Stop still stops the turn, 300 ms later. A turn that has ended by then gets the
message as an ordinary prompt.

It needs an adapter that says it supports steering (0.99 does) and does nothing otherwise.
Zed queues a message that you send while Claude works until the turn ends, unless you send
it with "Send Now": only that interrupt is changed.

## How it works

```
editor ⇄ proxy.mjs ⇄ claude-agent-acp ⇄ Claude Code
           │              └─ loaded with: node --import remote-control.mjs
           └─ session-config.mjs
```

| File | Job |
| --- | --- |
| `proxy.mjs` | The agent command. Starts the adapter, adds `settingSources` to `session/new`, `session/load`, `session/resume` and `session/fork` through `_meta.claudeCode.options`, and passes everything else through. |
| `setting-sources.mjs` | The rewrite of the session requests and the parsing of `CLAUDE_ACP_PROXY_SETTING_SOURCES`. |
| `model-picker.mjs` | Hides and renames the models that the adapter offers. |
| `steering.mjs` | Turns "stop, then send a new message" into a steering request to the adapter. |
| `session-config.mjs` | Remembers the last successful `session/set_config_option`, `session/set_model` and `session/set_mode` request of each thread and sends them to the adapter again when the thread is loaded or resumed. |
| `remote-control.mjs` | Loaded into the adapter with `node --import`. A `module.registerHooks` hook that serves `remote-control-sdk.mjs` in place of `@anthropic-ai/claude-agent-sdk`. |
| `remote-control-sdk.mjs` | The shim. Re-exports the SDK, wraps `query()` to enable Remote Control, and replaces `getSessionMessages()` with a version that also reads the history from before each compaction. |

The two `remote-control` file names are historical: the shim also does the history.

**Per-thread settings.** An editor applies its configured defaults (Zed's
`default_config_options`) to new sessions only. On a load or resume it shows what the
adapter answers, and the adapter answers from your settings, so a reopened thread went back
to the default model and effort. After a successful load, the proxy replays the thread's
remembered requests to the adapter, model first, holds the load response until they are
done (30 seconds at most), and gives the editor the option list that the last one returned.
A thread without a record takes the model family of its transcript. The newest 300 threads
are kept.

**Full history.** The SDK builds a thread's history from its last message up through
`parentUuid` and stops at the last `compact_boundary`, a record with no parent that keeps
the leaf of the history it replaced in `logicalParentUuid`. The shim reads the transcript
itself, crosses every boundary, and puts the earlier history in front of the SDK's
messages. It changes the calls without options, which are the replay and the fork point
lookup. A call with options is left alone.

**Why the shim sits at the SDK's URL.** The shim is served at the SDK's own URL plus a
`?remote-control` query, because the adapter finds the Claude Code binary with
`createRequire(import.meta.resolve(SDK))`. Served from anywhere else, it fails with
"Claude native binary not found".

## Security and privacy

- **No network of its own, no telemetry.** The proxy talks to the editor, the adapter and
  the local disk. The adapter and Claude Code talk to Anthropic as they always do.
- **What it reads.** Your Claude Code transcripts under `$CLAUDE_CONFIG_DIR/projects`,
  to replay a thread and to find its model. Nothing is copied or sent anywhere.
- **What it writes.** One file, the state file, created with mode `0600`, in a directory
  that is created with `0700` when it does not exist (an existing directory keeps its
  mode). It holds thread ids and the options you chose (`model`, `effort`, `mode`,
  toggles), no messages and no credentials.
- **Settings sources.** With the default `user`, Claude Code does not load a cloned
  repository's `.claude/settings.json`, so its hooks, `CLAUDE.md` and permission rules do
  not apply. The adapter still reads the project's settings for its own purposes, such as
  the model list and the starting permission mode. Setting `project` or `local` brings
  the rest back, so do it only for repositories you trust.
- **Remote Control is off by default.** When you turn it on, every thread becomes
  reachable from your Claude account on claude.ai and in the Claude app, until you end it.
- **It runs inside the adapter.** The import hook loads `remote-control-sdk.mjs` in the
  adapter's process, so treat this repository like the adapter: review it, and install the
  adapter from the lockfile (`npm ci`).

Found a problem? See [SECURITY.md](SECURITY.md).

## Compatibility

- **Adapter:** pinned to `0.99.1` in [`adapter/package.json`](adapter/package.json). Its
  history and per-thread settings were also checked against `0.93.0`.
- **Platforms:** CI runs Node 22 and 24 on Linux and macOS. Windows is untested.
- **Ultracode and fast mode:** the adapter offers them as options from `0.99`. Zed shows
  them as toggles. An older adapter has no Ultracode option.
- **Editors:** developed with Zed. The proxy speaks plain ACP over stdio, so another editor
  should work, but only Zed has been tried.
- **What it depends on:** the shim relies on two things that are not public API: the
  `enableRemoteControl` method of the SDK, and the transcript format of Claude Code. Either
  can change in an upgrade, see below.

## Limitations

- A transcript of about 512 MB or more cannot be read in one piece: the thread then
  replays as the SDK would, and the proxy logs why.
- A running background task is not shown in Zed. The adapter publishes background tasks as
  async tasks only to a client that advertises JetBrains AIR's capability. Their
  notifications do come back when a thread is replayed.
- Zed gives every custom agent the same generic icon. It has no setting for another.
- Steering moves a running tool call (a shell command, a subagent) to the background, as
  Claude Code does. The editor shows the turn that it interrupted as cancelled for a moment.
- Only the requests that the editor sends are remembered. A change the adapter makes on its
  own is not.

## Updating the proxy

```sh
git pull
cd adapter && npm ci
```

Then restart the agent, or open a new thread.

## Upgrading the adapter

A workflow, [Update the adapter](.github/workflows/update-adapter.yml), looks for a new
release of the adapter every day. When there is one, it installs it, runs the tests, checks
that the SDK still has `enableRemoteControl`, and opens a pull request that lists the
changes and the checks below, with CI running on its branch. It never merges: that is
yours to do after you have looked at the thread checks. [Dependabot](.github/dependabot.yml)
keeps the GitHub Actions of this repository up to date.

By hand:

```sh
cd adapter
npm install --save-exact @agentclientprotocol/claude-agent-acp@<version>
grep -c enableRemoteControl node_modules/@anthropic-ai/claude-agent-sdk/sdk.mjs   # not 0
cd .. && npm test
```

Commit `adapter/package.json` and `adapter/package-lock.json` together.
`enableRemoteControl` is not in the SDK's public types, so the grep checks that the shim
still has something to call. Then check in the editor:

- A thread in a repository with a `CLAUDE.md` keeps it out of context.
- A compacted thread's history starts before its summary.
- A thread changed to another model and effort comes back as it was after a restart.

## Troubleshooting

- **`Cannot find module … claude-agent-acp/dist/index.js`, or "the adapter is not
  installed"**: run `npm ci` in `adapter/`.
- **"Claude native binary not found"**: the shim is not served at the SDK's URL. Run `npm ci`
  in `adapter/` again, and do not move `remote-control.mjs` away from the other files.
- **A thread hangs when it opens**: set `CLAUDE_ACP_PROXY_SESSION_CONFIG=0` and tell us. The
  load response waits for the restore for 30 seconds at most.
- **A thread keeps the old model**: the proxy records a change only after the adapter
  accepted it. Change the model once more and reopen.
- **"needs Node 22.15 or later"**, or `does not provide an export named 'registerHooks'`:
  Node is older than 22.15 (23.5 on Node 23).

## Using `session-config.mjs` in another proxy

It does not depend on `proxy.mjs`. `new SessionConfigMemory({ send, forward, file? })` takes:

- `send(message)`, which writes a JSON-RPC request to the adapter. The restore requests are
  the editor's own requests again, so run them through the same rewriting as a message from
  the editor.
- `forward(message)`, which writes the held load or resume response to the editor, through
  the same rewriting as any other adapter response.
- `fromClient(message)`, for every parsed editor message, before any rewriting.
- `fromAgent(message)`, for every parsed adapter message. When it returns `true`, it took the
  message and you must not forward it. The adapter's stdout has to be piped for this.

## Development

```sh
cd adapter && npm ci && cd ..
npm test
```

The tests start the installed adapter on synthetic transcripts and need no Claude account
or network. Without `npm ci` in `adapter/`, 6 of them are skipped. See
[CONTRIBUTING.md](CONTRIBUTING.md).

## License

The code in this repository is under the [MIT license](LICENSE), and it includes no other
software. `npm ci` downloads [`@agentclientprotocol/claude-agent-acp`](https://github.com/agentclientprotocol/claude-agent-acp)
(Apache-2.0) and, through it, Anthropic's Claude Agent SDK and the Claude Code binary,
which are proprietary and used under
[Anthropic's terms](https://www.anthropic.com/legal/consumer-terms). You need your own
Claude account. "Claude" is a trademark of Anthropic, PBC.
