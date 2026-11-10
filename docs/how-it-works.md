# How it works

- [The pieces](#the-pieces)
- [Settings sources](#settings-sources)
- [Per-thread settings](#per-thread-settings)
- [Full history](#full-history)
- [Why the SDK module sits at the SDK's URL](#why-the-sdk-module-sits-at-the-sdks-url)
- [Reusing the session memory](#reusing-the-session-memory)
- [Limitations](#limitations)

## The pieces

```
editor ⇄ bin/claude-acp-proxy.mjs ⇄ claude-agent-acp ⇄ Claude Code
                  │                      └─ loaded with: node --import src/sdk/register.mjs
                  └─ src/proxy.mjs: setting sources, session memory, picker, steering
```

The proxy speaks JSON-RPC over stdio on both sides. It reads each line from the editor and from the
adapter, lets the parts that are turned on look at it or change it, and passes it on. A line that
nothing changes goes through as it came.

| File                       | Job                                                                                                                                |
| -------------------------- | ---------------------------------------------------------------------------------------------------------------------------------- |
| `bin/claude-acp-proxy.mjs` | The agent command. Checks Node and the adapter, reads the configuration and starts the proxy.                                      |
| `src/proxy.mjs`            | Starts the adapter and routes every line between it and the editor through the parts below.                                        |
| `src/config.mjs`           | Reads the [variables](configuration.md#variables).                                                                                 |
| `src/setting-sources.mjs`  | Adds `settingSources` to `session/new`, `session/load`, `session/resume` and `session/fork`.                                       |
| `src/session-config.mjs`   | Remembers each thread's options and puts them back when it is loaded or resumed.                                                   |
| `src/model-picker.mjs`     | Hides and renames the models that the adapter offers.                                                                              |
| `src/steering.mjs`         | Turns "stop, then send a new message" into a steering request to the adapter.                                                      |
| `src/transcripts.mjs`      | Finds and reads a thread's Claude Code transcript.                                                                                 |
| `src/sdk/register.mjs`     | Loaded into the adapter with `node --import`. A `module.registerHooks` hook that gives the adapter the wrapped SDK.                |
| `src/sdk/shim.mjs`         | The wrapped SDK functions: `query()` turns Remote Control on, `getSessionMessages()` adds the history from before each compaction. |
| `src/sdk/history.mjs`      | Rebuilds that history from the transcript.                                                                                         |

## Settings sources

The proxy sets `settingSources` on every request that starts a session, through
`_meta.claudeCode.options`, which the adapter passes to the SDK. With the default `user`, Claude
Code reads only your own settings, as with `claude --setting-sources user`. Any `settingSources`
that the editor sent is replaced, and its other options are kept.

## Per-thread settings

An editor applies its configured defaults (Zed's `default_config_options`) to new sessions only. On
a load or resume it shows what the adapter answers, and the adapter answers from your settings, so a
reopened thread went back to the default model and effort.

The proxy remembers the last successful `session/set_config_option`, `session/set_model` and
`session/set_mode` request of each thread. After a successful load or resume it sends them to the
adapter again, model first because a model can change which efforts are offered, holds the response
until they are done (30 seconds at most), and gives the editor the option list that the last one
returned. A thread without a record takes the model family of its transcript. The newest 300 threads
are kept, and another editor window that runs its own proxy shares the same file.

## Full history

The SDK builds a thread's history from its last message up through `parentUuid` and stops at the
last `compact_boundary`, a record with no parent that keeps the leaf of the history it replaced in
`logicalParentUuid`. The shim reads the transcript itself, crosses every boundary, and puts the
earlier history in front of the SDK's messages. It changes the calls without options, which are the
replay and the fork point lookup. A call with options is left alone.

## Why the SDK module sits at the SDK's URL

The hook in `src/sdk/register.mjs` resolves the adapter's import of `@anthropic-ai/claude-agent-sdk`
to the SDK's own URL plus a `?claude-acp-proxy` query, and serves a short generated module there. It
re-exports the SDK, with `query()` and `getSessionMessages()` from `src/sdk/shim.mjs` in place of
the SDK's own. The URL has to stay the SDK's, because the adapter finds the Claude Code binary with
`createRequire(import.meta.resolve(SDK))`. Resolved anywhere else, it fails with "Claude native
binary not found".

## Reusing the session memory

`src/session-config.mjs` does not depend on `src/proxy.mjs`, so another proxy can use it, together
with the three files it imports: `src/config.mjs`, `src/log.mjs` and `src/transcripts.mjs`.
`new SessionConfigMemory({ send, forward, file?, claudeConfigDir? })` takes:

- `send(message)`, which writes a JSON-RPC request to the adapter. The restore requests are the
  editor's own requests again, so run them through the same rewriting as a message from the editor.
- `forward(message)`, which writes the held load or resume response to the editor, through the same
  rewriting as any other adapter response.

Then call:

- `fromClient(message)` for every parsed editor message, before any rewriting.
- `fromAgent(message)` for every parsed adapter message. When it returns `true`, it took the message
  and you must not forward it. The adapter's stdout has to be piped for this.

## Limitations

- A transcript of about 512 MB or more cannot be read in one piece: the thread then replays as the
  SDK would, and the proxy logs why.
- A running background task is not shown in Zed. The adapter publishes background tasks as async
  tasks only to a client that advertises JetBrains AIR's capability. Their notifications do come
  back when a thread is replayed.
- Zed shows the Claude icon only for an agent named after an ACP registry id, such as `claude-acp`.
  Under another name, its threads get the generic icon, and saved threads in the sidebar get it
  either way.
- Steering moves a running tool call (a shell command, a subagent) to the background, as Claude Code
  does. The editor shows the turn that it interrupted as cancelled for a moment.
- Only the requests that the editor sends are remembered. A change the adapter makes on its own is
  not.
