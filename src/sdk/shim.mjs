import { readConfig } from "../config.mjs";
import { logProblem } from "../log.mjs";
import { readTranscript } from "../transcripts.mjs";
import { withEarlierHistory } from "./history.mjs";

/** @typedef {import("./history.mjs").SessionMessage} SessionMessage */

/**
 * The part of the SDK that the shim wraps. It is typed here rather than taken from the SDK's types, because
 * `enableRemoteControl` is not in them.
 *
 * @typedef {object} Sdk
 * @property {(params: unknown) => Query} query
 * @property {(sessionId: string, options?: unknown) => Promise<SessionMessage[]>} getSessionMessages
 */

/**
 * @typedef {object} Query
 * @property {() => Promise<{ remote_control_available?: boolean }>} initializationResult
 * @property {(enabled: boolean) => Promise<unknown>} enableRemoteControl
 */

/**
 * The SDK functions that the adapter gets in place of the SDK's own (see register.mjs).
 *
 * `query()` turns Remote Control on when the proxy is set to. `getSessionMessages()` without options, which the
 * adapter calls to replay a thread and to find a fork point, also returns the history from before each
 * compaction. A call with options is left alone.
 *
 * @param {Sdk} sdk
 * @param {import("../config.mjs").Config} [config] Read at each call when not given: the adapter applies a managed
 *   policy's `env` only after it has imported the SDK.
 */
export function wrapSdk(sdk, config) {
  const current = () => config ?? readConfig(process.env, () => {});
  return {
    /** @param {unknown} params */
    query(params) {
      const session = sdk.query(params);
      if (current().remoteControl) void enableRemoteControl(session);
      return session;
    },

    /**
     * @param {string} sessionId
     * @param {unknown} [options]
     */
    async getSessionMessages(sessionId, options) {
      const active = await sdk.getSessionMessages(sessionId, options);
      const { fullHistory, claudeConfigDir } = current();
      if (options !== undefined || !fullHistory) return active;
      try {
        const transcript = await readTranscript(sessionId, claudeConfigDir);
        if (transcript === undefined) return active;
        return withEarlierHistory(transcript, active, sessionId);
      } catch (error) {
        logProblem("full history", error);
        return active;
      }
    },
  };
}

/** @param {Query} session */
async function enableRemoteControl(session) {
  try {
    const init = await session.initializationResult();
    if (init.remote_control_available === false) return;
    await session.enableRemoteControl(true);
  } catch (error) {
    logProblem("remote control", error);
  }
}
