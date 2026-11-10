# Troubleshooting

The proxy writes its problems to the agent's stderr, in lines that start with `claude-acp-proxy:`.
In Zed, the `dev: open acp logs` command shows them.

- **"the adapter is not installed"**, or `Cannot find module … claude-agent-acp`: run `npm ci
  --omit=dev` in the checkout.
- **The agent fails to start after an update from 0.1**: the command moved. See [Updating from
  0.1](upgrading.md#updating-from-01).
- **"Claude native binary not found"**: the platform package with the Claude Code binary
  (`@anthropic-ai/claude-agent-sdk-<os>-<arch>`) is not installed, usually because npm skipped
  optional dependencies. Run `npm ci --omit=dev` without `--omit=optional`, and check that your
  `.npmrc` has no `optional=false`. Or set `CLAUDE_CODE_EXECUTABLE` to a `claude` binary.
- **A thread hangs when it opens**: set `CLAUDE_ACP_PROXY_SESSION_CONFIG=0` and open an issue. The
  load response waits for the restore for 30 seconds at most.
- **A thread keeps the old model**: the proxy records a change only after the adapter accepted it.
  Change the model once more and reopen the thread. A model that the picker hides is not restored.
- **"needs Node 22.15 or later"**, or `does not provide an export named 'registerHooks'`: Node is
  older than 22.15 (23.5 on Node 23). Point the agent's `command` at a newer `node`.
- **`claude-acp-proxy: remote control: …`**: Remote Control could not be turned on, often because
  the profile uses an API key and not a claude.ai login. The thread works without it.
- **`claude-acp-proxy: configuration: ignoring CLAUDE_ACP_PROXY_SETTING_SOURCES=…`**: the value has
  a name that is not `user`, `project` or `local`, or is not lower case. The proxy uses `user`.
