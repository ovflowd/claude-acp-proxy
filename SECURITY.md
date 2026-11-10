# Security policy

## Reporting a vulnerability

Please report a vulnerability privately, through [GitHub's private vulnerability
reporting](https://github.com/ovflowd/claude-acp-proxy/security/advisories/new), and not in a public
issue. Include what you found, how to reproduce it and what it affects. You will get an answer
within a week.

If that page does not open, open an issue that only says you have a security problem to report, and
without any detail, so that a way to talk privately can be arranged.

## Scope

This project is a small wrapper around
[`@agentclientprotocol/claude-agent-acp`](https://github.com/agentclientprotocol/claude-agent-acp)
and Claude Code. In scope are problems in this repository's code, for example a way to:

- make Claude Code load a repository's settings, hooks or `CLAUDE.md` that the user did not choose;
- leak the content of a thread, or read a transcript other than the thread's own;
- make the proxy write outside its state file, or follow a link planted next to it;
- turn Remote Control on when it is off.

Problems in the adapter, in the Claude Agent SDK, in Claude Code or in your editor belong to those
projects.

## What the proxy touches

[docs/security.md](docs/security.md) has what it reads, what it writes, and which behavior is off by
default.

## Supported versions

Only the latest commit on `main`.
