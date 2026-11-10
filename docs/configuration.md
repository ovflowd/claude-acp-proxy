# Configuration

The proxy reads environment variables, which you set in the agent's `env` in the editor. All of them
are optional, and the defaults change as little of Claude Code as the fixes allow.

- [Variables](#variables)
- [Remote Control](#remote-control)
- [Model picker](#model-picker)
- [Steering](#steering)

## Variables

| Variable                           | Default                                          | Effect                                                                                                                                                                                                                                              |
| ---------------------------------- | ------------------------------------------------ | --------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `CLAUDE_ACP_PROXY_SETTING_SOURCES` | `user`                                           | Which Claude Code settings load: a comma-separated list of `user`, `project` and `local`, or `default` for the adapter's own choice (all three). The names are lower case. A value that is not valid is ignored with a warning, and `user` is used. |
| `CLAUDE_ACP_PROXY_PICKER`          | none                                             | The path of a [picker file](#model-picker) that hides models and renames the others.                                                                                                                                                                |
| `CLAUDE_ACP_PROXY_STEERING`        | off                                              | `1` makes a message that you send while Claude works steer the running turn instead of cancelling it. See [Steering](#steering).                                                                                                                    |
| `CLAUDE_ACP_PROXY_REMOTE_CONTROL`  | off                                              | `1` (only that value) turns [Remote Control](#remote-control) on for every thread.                                                                                                                                                                  |
| `CLAUDE_ACP_PROXY_FULL_HISTORY`    | on                                               | `0` goes back to the SDK's history, which starts at the last compaction.                                                                                                                                                                            |
| `CLAUDE_ACP_PROXY_SESSION_CONFIG`  | on                                               | `0` stops remembering per-thread settings. With no picker and no steering either, the adapter's stdout then goes straight to the editor.                                                                                                            |
| `CLAUDE_ACP_PROXY_STATE_FILE`      | `$XDG_STATE_HOME/claude-acp-proxy/sessions.json` | Where the per-thread settings are kept (`~/.local/state` when `XDG_STATE_HOME` is not set).                                                                                                                                                         |
| `CLAUDE_CONFIG_DIR`                | `~/.claude`                                      | Not the proxy's own: the Claude Code profile that the threads use, and where the proxy reads their transcripts.                                                                                                                                     |

The switches take only the values above: `CLAUDE_ACP_PROXY_STEERING=true` leaves steering off.

The proxy writes its problems to stderr, which Zed keeps in the agent's log, as lines that start
with `claude-acp-proxy:`.

## Remote Control

With `CLAUDE_ACP_PROXY_REMOTE_CONTROL=1`, every thread turns on [Remote
Control](https://code.claude.com/docs/en/remote-control) when it starts, so you can pick it up from
the Claude app or claude.ai/code. It needs a claude.ai login, not an API key. A failure is logged as
`claude-acp-proxy: remote control: …`, and the thread goes on without it.

Every thread then becomes reachable from your Claude account until you end it: see
[security.md](security.md). A thread that was started before you turned it on gets it by sending
`/remote-control` in it. The adapter matches only the full name.

## Model picker

`CLAUDE_ACP_PROXY_PICKER` names a JSON file:

```json
{
  "hide": ["^default$", "^claude-.*-4-"],
  "labels": { "opus": "Opus 5.5", "sonnet": "Sonnet 5.5" }
}
```

`hide` is a list of regular expressions, tested against the model values that the adapter offers
(`opus`, `claude-opus-4-8` and so on). `labels` maps a model value to the name that the editor
shows. The model that a thread runs is never hidden, so the list stays valid. A remembered model
that the picker hides is not restored: the thread keeps the model it starts with. A file that cannot
be read stops the proxy with the reason.

## Steering

When you send a message while Claude works, Zed interrupts: it sends `session/cancel`, waits for the
answer to the running prompt, and then sends the new prompt. Claude Code itself would take the
message into the running turn. The adapter has a request for that, `_session/steering`, but Zed does
not use it with an external agent.

With `CLAUDE_ACP_PROXY_STEERING=1` the proxy holds the cancel back for 300 ms and answers the
running prompt as cancelled, so the editor moves on. A prompt that follows in that time goes to the
adapter as `_session/steering`: the turn keeps running, its tool calls are not killed, and Claude
reads the message at its next step. The real answer of the turn then answers the new prompt. If no
prompt follows, the cancel goes to the adapter when the 300 ms are over, so Stop still stops the
turn, 300 ms later. A turn that has ended by then gets the message as an ordinary prompt.

It needs an adapter that says it supports steering (0.99 does) and does nothing otherwise. Zed
queues a message that you send while Claude works until the turn ends, unless you send it with "Send
Now": only that interrupt is changed.
