# claude-acp-proxy

[![CI](https://github.com/ovflowd/claude-acp-proxy/actions/workflows/ci.yml/badge.svg)](https://github.com/ovflowd/claude-acp-proxy/actions/workflows/ci.yml)
[![License: MIT](https://img.shields.io/badge/license-MIT-blue.svg)](LICENSE)

Safer defaults, full history and per-thread settings for Claude in [Zed](https://zed.dev) and other
[ACP](https://agentclientprotocol.com) editors.

It wraps
[`@agentclientprotocol/claude-agent-acp`](https://github.com/agentclientprotocol/claude-agent-acp),
the adapter that lets an ACP editor drive Claude Code, and fixes what surprised its author. It is an
unofficial project, not affiliated with Anthropic or Zed.

| Without it                                                                                                                     | With it                                                                                                                                                                                     |
| ------------------------------------------------------------------------------------------------------------------------------ | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| The adapter loads a repository's own `.claude/settings.json`, so the hooks of a repo you just cloned run with no trust prompt. | Claude Code loads only your user settings, as with `claude --setting-sources user`: a cloned repository's hooks, `CLAUDE.md` and permission rules do not apply. You can choose the sources. |
| A thread that Claude compacted reopens from its summary on. Claude remembers the rest, the editor does not show it.            | The whole thread replays, including prompts typed while Claude was working and background-task notifications.                                                                               |
| A reopened thread forgets its model, effort, Ultracode and fast toggles and goes back to your defaults.                        | Each thread comes back as you left it.                                                                                                                                                      |
| The model list shows every model, including ones you never use, under the names of the adapter.                                | Optional: a picker file hides models and renames the others.                                                                                                                                |
| Sending a message while Claude works interrupts the turn: it is cancelled and the new message starts again.                    | Optional: the message steers the running turn instead.                                                                                                                                      |
| Remote Control is never turned on for editor threads.                                                                          | Optional: turn it on for every thread.                                                                                                                                                      |

## What you need

- Node 22.15 or later (on Node 23, 23.5 or later)
- A working [Claude Code](https://claude.com/claude-code) login
- Zed, or another editor that runs ACP agents

## Install

```sh
git clone https://github.com/ovflowd/claude-acp-proxy.git
cd claude-acp-proxy
npm ci --omit=dev
```

`npm ci` installs the adapter at the version this repository pins. If your global `.npmrc` points at
another registry, add `--registry=https://registry.npmjs.org/`: the lockfile only refers to the
public one.

Then add the proxy to Zed's `settings.json` as a custom agent, with the absolute path to
`bin/claude-acp-proxy.mjs`:

```jsonc
"agent_servers": {
  "claude-acp": {
    "type": "custom",
    "command": "node", // an absolute path is safer: /usr/bin/node, /opt/homebrew/bin/node
    "args": ["/absolute/path/to/claude-acp-proxy/bin/claude-acp-proxy.mjs"],
    "env": {
      // Which Claude Code profile the threads use. Leave it out for the default one.
      "CLAUDE_CONFIG_DIR": "/home/you/.claude"
    }
  }
}
```

`claude-acp` is Claude's id in the ACP registry, and Zed gives the Claude icon only to an agent with
a registry id for its name. The entry takes the place of the registry's own Claude agent. Pick the
name before you start threads: Zed files each thread under it.

`CLAUDE_CONFIG_DIR` decides whose settings, MCP servers and transcripts a thread uses, so set it on
purpose on a machine with more than one profile.

To check the settings behavior, make a throwaway repository with a file `.claude/commands/check.md`,
open a thread in it and type `/check`. With the defaults, the command does not exist.

## Configuration

Set these in the agent's `env`. All are optional, and [docs/configuration.md](docs/configuration.md)
has the details.

| Variable                           | Default                                          | Effect                                                                           |
| ---------------------------------- | ------------------------------------------------ | -------------------------------------------------------------------------------- |
| `CLAUDE_ACP_PROXY_SETTING_SOURCES` | `user`                                           | Which Claude Code settings load: `user`, `project`, `local`, or `default`        |
| `CLAUDE_ACP_PROXY_PICKER`          | none                                             | A [picker file](docs/configuration.md#model-picker) that hides or renames models |
| `CLAUDE_ACP_PROXY_STEERING`        | off                                              | `1`: a message sent mid-turn [steers the turn](docs/configuration.md#steering)   |
| `CLAUDE_ACP_PROXY_REMOTE_CONTROL`  | off                                              | `1`: every thread gets [Remote Control](docs/configuration.md#remote-control)    |
| `CLAUDE_ACP_PROXY_FULL_HISTORY`    | on                                               | `0`: a compacted thread replays from its last summary, as the SDK does           |
| `CLAUDE_ACP_PROXY_SESSION_CONFIG`  | on                                               | `0`: each thread's settings are not remembered                                   |
| `CLAUDE_ACP_PROXY_STATE_FILE`      | `$XDG_STATE_HOME/claude-acp-proxy/sessions.json` | Where the remembered settings are kept                                           |

## Compatibility

| Part    | Status                                                                                  |
| ------- | --------------------------------------------------------------------------------------- |
| Adapter | Pinned to `0.99.1` in [`package.json`](package.json). A workflow proposes each release. |
| Node    | CI runs 22, 24 and 26 on Linux and macOS. Windows is untested.                          |
| Editors | Developed with Zed. Any editor that speaks ACP over stdio should work, but untried.     |

The proxy relies on two things that are not public API: the SDK's `enableRemoteControl` method and
Claude Code's transcript format. [docs/upgrading.md](docs/upgrading.md) covers updates, and what to
check when the adapter changes.

## How it works

The editor runs the proxy as its agent, and the proxy runs the adapter. It rewrites the requests
that start a session, remembers the options each thread was set to and puts them back when the
thread opens again. Inside the adapter, a module hook hands the adapter a wrapped SDK that turns
Remote Control on and returns a compacted thread's whole history.

[docs/how-it-works.md](docs/how-it-works.md) has the details, the modules and the known limitations,
and [docs/security.md](docs/security.md) what the proxy reads, writes and changes.

## Something not working?

[docs/troubleshooting.md](docs/troubleshooting.md) covers the usual problems. To report a bug, see
[CONTRIBUTING.md](CONTRIBUTING.md#reporting-a-problem), and for a security problem,
[SECURITY.md](SECURITY.md).

## Development

```sh
npm ci
node --run test
node --run lint
node --run format:check
node --run typecheck
```

The tests start the installed adapter on synthetic transcripts, so they need no Claude account or
network. See [CONTRIBUTING.md](CONTRIBUTING.md).

## License

The code in this repository is under the [MIT license](LICENSE), and it includes no other software.
`npm ci` downloads
[`@agentclientprotocol/claude-agent-acp`](https://github.com/agentclientprotocol/claude-agent-acp)
(Apache-2.0) and, through it, Anthropic's Claude Agent SDK and the Claude Code binary, which are
proprietary and used under [Anthropic's terms](https://www.anthropic.com/legal/consumer-terms). You
need your own Claude account. "Claude" is a trademark of Anthropic, PBC.
