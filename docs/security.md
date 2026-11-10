# Security and privacy

What the proxy reads, writes and changes. To report a problem, see [SECURITY.md](../SECURITY.md).

- **No network of its own, no telemetry.** The proxy talks to the editor, the adapter and the local
  disk. The adapter and Claude Code talk to Anthropic as they always do.
- **What it reads.** Your Claude Code transcripts under `$CLAUDE_CONFIG_DIR/projects`, to replay a
  thread and to find its model. A thread id is checked against the UUID form before it becomes part
  of a path. Nothing is copied or sent anywhere.
- **What it writes.** One file, the state file, created with mode `0600`, in a directory that is
  created with `0700` when it does not exist (an existing directory keeps its mode). It is written
  under a new random name and renamed into place, so a planted link is not followed. It holds thread
  ids and the options you chose (`model`, `effort`, `mode`, toggles), no messages and no
  credentials.
- **Settings sources.** With the default `user`, Claude Code does not load a cloned repository's
  `.claude/settings.json`, so its hooks, `CLAUDE.md` and permission rules do not apply. The adapter
  still reads the project's settings for its own purposes, such as the model list and the starting
  permission mode. Setting `project` or `local` brings the rest back, so do it only for repositories
  you trust.
- **Remote Control is off by default.** When you turn it on, every thread becomes reachable from
  your Claude account on claude.ai and in the Claude app, until you end it.
- **It runs inside the adapter.** The import hook loads `src/sdk/` in the adapter's process, so
  treat this repository like the adapter: review it, and install from the lockfile (`npm ci`).
- **Its own requests keep to themselves.** The requests that the proxy sends to the adapter carry
  ids with a random prefix, so an editor's id cannot be mistaken for one of them.
