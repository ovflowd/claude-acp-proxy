# Updating and upgrading

- [Updating the proxy](#updating-the-proxy)
- [Updating from 0.1](#updating-from-01)
- [Upgrading the adapter](#upgrading-the-adapter)
- [Compatibility](#compatibility)

## Updating the proxy

```sh
git pull --ff-only
npm ci --omit=dev
```

Then restart the agent, or open a new thread.

## Updating from 0.1

0.2 moved the agent command and the adapter:

- The command is `bin/claude-acp-proxy.mjs`, not `proxy.mjs`. Change the path in the agent's `args`.
- The adapter installs with the rest, from the root of the checkout: run `npm ci --omit=dev` there,
  and delete the old `adapter/` folder.
- The proxy's own lines in the agent's log start with `claude-acp-proxy:`, so a Remote Control
  failure is `claude-acp-proxy: remote control: …`.

The variables and the state file did not change, so every thread keeps its settings.

## Upgrading the adapter

A workflow, [Update the adapter](../.github/workflows/update-adapter.yml), looks for a new release
of the adapter every day. When there is one, it changes the pin and the lockfile and opens a pull
request that lists the changes and the checks below. It holds a write token, so it never runs the
new release itself: CI does, on the pull request's branch, with the tests and a check that the SDK
still has `enableRemoteControl`. The workflow never merges: that is yours to do after you have
looked at the checks. [Dependabot](../.github/dependabot.yml) keeps the development tools and the
GitHub Actions up to date.

By hand:

```sh
npm install --save-exact @agentclientprotocol/claude-agent-acp@<version>
grep -c enableRemoteControl node_modules/@anthropic-ai/claude-agent-sdk/sdk.mjs   # not 0
node --run test
```

Commit `package.json` and `package-lock.json` together. `enableRemoteControl` is not in the SDK's
public types, so the grep checks that the shim still has something to call. Then check in the
editor:

- A thread in a repository with a `CLAUDE.md` keeps it out of context.
- A compacted thread's history starts before its summary.
- A thread changed to another model and effort comes back as it was after a restart.
- Stop and "Send Now" still behave, if steering is on.

## Compatibility

- **Adapter:** pinned to `0.99.1` in [`package.json`](../package.json). Its history and per-thread
  settings were also checked against `0.93.0`.
- **Platforms:** CI runs Node 22, 24 and 26 on Linux and macOS. Windows is untested.
- **Ultracode and fast mode:** the adapter offers them as options from `0.99`. Zed shows them as
  toggles. An older adapter has no Ultracode option.
- **Editors:** developed with Zed. The proxy speaks plain ACP over stdio, so another editor should
  work, but only Zed has been tried.
- **What it depends on:** the shim relies on two things that are not public API: the
  `enableRemoteControl` method of the SDK, and the transcript format of Claude Code. Either can
  change in an upgrade, so check the list above after each one.
