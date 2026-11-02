// The SDK as claude-agent-acp sees it (see remote-control.mjs): unchanged, except that query()
// turns Remote Control on once the session has initialized. `enableRemoteControl` is not in the
// SDK's public types, so check it after every adapter upgrade (see the README).
// CLAUDIO_ZED_REMOTE_CONTROL=0 in Zed's agent env turns it off.
import { query as sdkQuery } from "@anthropic-ai/claude-agent-sdk";

export * from "@anthropic-ai/claude-agent-sdk";

export function query(params) {
  const session = sdkQuery(params);
  if (process.env.CLAUDIO_ZED_REMOTE_CONTROL !== "0") enableRemoteControl(session);
  return session;
}

async function enableRemoteControl(session) {
  try {
    const init = await session.initializationResult();
    if (init.remote_control_available === false) return;
    await session.enableRemoteControl(true);
  } catch (error) {
    console.error(`remote control: ${error?.message ?? error}`);
  }
}
