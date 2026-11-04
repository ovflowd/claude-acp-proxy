# Security policy

## Reporting a vulnerability

Please report a vulnerability privately, through
[GitHub's private vulnerability reporting](https://github.com/ovflowd/claude-acp-proxy/security/advisories/new),
and not in a public issue. Include what you found, how to reproduce it and what it
affects. You will get an answer within a week.

If that page does not open, open an issue that only says you have a security problem to
report, and without any detail, so that a way to talk privately can be arranged.

## Scope

This project is a small wrapper around
[`@agentclientprotocol/claude-agent-acp`](https://github.com/agentclientprotocol/claude-agent-acp)
and Claude Code. In scope are problems in this repository's code: for example a way to
make the proxy run a repository's hooks that the user did not trust, to leak the content of
a thread, or to write outside its state file.

Problems in the adapter, in the Claude Agent SDK, in Claude Code or in your editor belong
to those projects.

## What the proxy touches

See [Security and privacy](README.md#security-and-privacy) in the README: what it reads,
what it writes, and which behavior is off by default.

## Supported versions

Only the latest commit on `main`.
