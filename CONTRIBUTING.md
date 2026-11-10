# Contributing

Thanks for helping. The proxy runs inside people's editors with their Claude account, so a change
should be small and easy to review: one change per pull request, and a behavior change comes with a
test.

## Setup

```sh
git clone https://github.com/ovflowd/claude-acp-proxy.git
cd claude-acp-proxy
npm ci
node --run test
node --run lint
node --run format:check
node --run typecheck
```

Node 22.15 or later is needed (`module.registerHooks`; on Node 23, 23.5). The tests need no Claude
account and no network: they start the installed adapter and read synthetic transcripts. Without the
adapter installed, the tests that run it are skipped.

## Style

- oxfmt formats, at 120 columns, and oxlint lints, with the settings in `.oxfmtrc.json` and
  `.oxlintrc.json`. `tsc` checks the JSDoc types of `bin/` and `src/` strictly. CI checks all three.
  `node --run format` fixes the formatting.
- A comment says why, not what. Do not restate the code.
- No runtime dependency other than the adapter. Everything else is in `devDependencies`.
- Commit messages are an imperative sentence with a type, as in `fix: keep the state file private`,
  and the body says why.

## Changing what the proxy does

- Read [docs/how-it-works.md](docs/how-it-works.md) first. Anything that changes what the adapter or
  Claude Code does by default needs a good reason in the pull request.
- Keep `src/session-config.mjs` free of any dependency on `src/proxy.mjs`: other proxies reuse it
  through `send` and `forward`.
- The shim depends on details of Claude Code's transcript format and of the SDK. Say in the pull
  request which adapter versions you tried.
- A new variable goes in `src/config.mjs`, with a test, and in
  [docs/configuration.md](docs/configuration.md).

## Upgrading the adapter

See [docs/upgrading.md](docs/upgrading.md#upgrading-the-adapter).

## AI assistants

If you used an AI assistant for a change, say so in the pull request. You remain responsible for it,
and for having read it.

## License of contributions

By contributing, you agree that your work is licensed under the [MIT license](LICENSE). This project
follows a [code of conduct](CODE_OF_CONDUCT.md).

## Reporting a problem

Questions and ideas are welcome as issues too. For a bug, include the version of the adapter (`npm
ls @agentclientprotocol/claude-agent-acp`), the commit of your checkout, your Node version, your
editor, and what you saw. Never paste transcripts or settings files: they contain your
conversations. For a security problem, see [SECURITY.md](SECURITY.md).
