// Loaded into the adapter's process with `node --import`. It hands the adapter a module that re-exports the SDK
// with query() and getSessionMessages() from shim.mjs in place of the SDK's own.
//
// That module is served at the SDK's own URL plus a query, not at shim.mjs: the adapter finds the Claude Code
// binary with createRequire(import.meta.resolve(SDK)), which would otherwise look next to the proxy and fail
// with "Claude native binary not found".
import { registerHooks } from "node:module";

const SDK = "@anthropic-ai/claude-agent-sdk";
const QUERY = "?claude-acp-proxy";
const SHIM = new URL("./shim.mjs", import.meta.url).href;

registerHooks({
  resolve(specifier, context, nextResolve) {
    const resolved = nextResolve(specifier, context);
    if (specifier !== SDK) return resolved;
    return { ...resolved, url: `${resolved.url}${QUERY}` };
  },
  load(url, context, nextLoad) {
    if (!url.endsWith(QUERY)) return nextLoad(url, context);
    const sdk = JSON.stringify(url.slice(0, -QUERY.length));
    const source = [
      `import * as sdk from ${sdk};`,
      `import { wrapSdk } from ${JSON.stringify(SHIM)};`,
      `export * from ${sdk};`,
      `export const { query, getSessionMessages } = wrapSdk(sdk);`,
    ].join("\n");
    return { format: "module", source, shortCircuit: true };
  },
});
