# Contributing

Thanks for helping. The proxy is small on purpose, so a change should be too: one change
per pull request, and a behavior change comes with a test.

## Setup

```sh
git clone https://github.com/ovflowd/claude-acp-proxy.git
cd claude-acp-proxy/adapter
npm ci
cd ..
npm test
```

Node 22.15 or later is needed (`module.registerHooks`; on Node 23, 23.5). The tests need
no Claude account and no network: they start the installed adapter and read synthetic
transcripts. Without `npm ci` in `adapter/`, 6 of the tests are skipped.

## Style

- Format with `npx prettier@3.6.2 --write "*.mjs" "test/*.mjs"`. `.prettierrc.json` sets
  the width to 88 columns, which keeps diffs readable, and CI checks it.
- A comment says why, not what. Do not restate the code.
- No runtime dependencies. The proxy runs on Node alone.
- Commit messages are an imperative sentence with a type, as in `fix: keep the state file
  private`, and the body says why.

## Changing what the proxy does

- Read [How it works](README.md#how-it-works) first. Anything that changes what the
  adapter or Claude Code does by default needs a good reason in the pull request.
- Keep `session-config.mjs` free of any dependency on `proxy.mjs`: other proxies reuse it
  through `send` and `forward`.
- The shim depends on details of Claude Code's transcript format and of the SDK. Say in
  the pull request which adapter versions you tried.

## Upgrading the adapter

See [Upgrading the adapter](README.md#upgrading-the-adapter).

## License of contributions

By contributing, you agree that your work is licensed under the [MIT license](LICENSE).
This project follows a [code of conduct](CODE_OF_CONDUCT.md).

## Reporting a problem

Questions and ideas are welcome as issues too. For a bug, include the adapter version
(`adapter/package.json`), your Node version, your editor, and what you saw. Do not paste transcripts or settings files: they contain your
conversations. For a security problem, see [SECURITY.md](SECURITY.md).
