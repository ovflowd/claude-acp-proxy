// Loaded by proxy.mjs with `node --import`. Routes the adapter's import of the SDK through
// remote-control-sdk.mjs, which turns Remote Control on and returns the full history of a compacted thread.
// The shim is served at the SDK's own URL plus a query, because the adapter finds the CLI binary
// with a require bound to wherever the SDK resolves.
import { readFileSync } from "node:fs";
import { registerHooks } from "node:module";

const SDK = "@anthropic-ai/claude-agent-sdk";
const SHIM = "?remote-control";
const SHIM_SOURCE = new URL("./remote-control-sdk.mjs", import.meta.url);

registerHooks({
  resolve(specifier, context, nextResolve) {
    const resolved = nextResolve(specifier, context);
    if (specifier !== SDK || context.parentURL?.endsWith(SHIM)) return resolved;
    return { ...resolved, url: resolved.url + SHIM };
  },
  load(url, context, nextLoad) {
    if (!url.endsWith(SHIM)) return nextLoad(url, context);
    return { format: "module", source: readFileSync(SHIM_SOURCE, "utf8"), shortCircuit: true };
  },
});
