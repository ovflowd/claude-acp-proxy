import { readFileSync } from "node:fs";

/** @typedef {import("./protocol.mjs").Message} Message */

/**
 * @typedef {object} Picker
 * @property {(value: unknown) => boolean} hides Whether the picker leaves a model value out.
 * @property {(message: Message) => boolean} apply Edits a message from the adapter in place, and says whether it
 *   changed.
 * @property {(message: Message) => boolean} picksHiddenModel Whether a request would pick a model that the
 *   picker hides.
 */

const MODEL_OPTION = "model";

/**
 * Reads a picker file: `hide` is a list of regular expressions for the model values to leave out, and `labels`
 * maps a model value to the name that the editor shows.
 *
 * @param {string} file
 * @returns {Picker}
 */
export function loadPicker(file) {
  const config = JSON.parse(readFileSync(file, "utf8"));
  /** @type {RegExp[]} */
  const hide = (config.hide ?? []).map((/** @type {string} */ pattern) => new RegExp(pattern));
  /** @type {Record<string, unknown>} */
  const labels = config.labels ?? {};
  /** @param {unknown} value */
  const hides = (value) => typeof value === "string" && hide.some((re) => re.test(value));

  /**
   * The model that a thread runs is never hidden, so the current value stays one of the options.
   *
   * @param {any[]} list
   * @param {(item: any) => string} valueOf
   * @param {unknown} current
   */
  function pick(list, valueOf, current) {
    const kept = list.filter((item) => valueOf(item) === current || !hides(valueOf(item)));
    for (const item of kept) {
      const label = labels[valueOf(item)];
      if (typeof label === "string") item.name = label;
    }
    return kept;
  }

  /** @param {any[]} configOptions */
  function applyToOptions(configOptions) {
    let changed = false;
    for (const option of configOptions) {
      if (option?.id !== MODEL_OPTION || !Array.isArray(option.options)) continue;
      const before = JSON.stringify(option.options);
      option.options = pick(option.options, (item) => item.value, option.currentValue);
      changed ||= before !== JSON.stringify(option.options);
    }
    return changed;
  }

  /** @param {{ availableModels: any[], currentModelId?: string }} models */
  function applyToModels(models) {
    const before = JSON.stringify(models.availableModels);
    models.availableModels = pick(models.availableModels, (item) => item.modelId, models.currentModelId);
    return before !== JSON.stringify(models.availableModels);
  }

  return {
    hides,

    apply(message) {
      let changed = false;
      for (const list of [message?.result?.configOptions, message?.params?.update?.configOptions]) {
        if (Array.isArray(list)) changed = applyToOptions(list) || changed;
      }
      if (Array.isArray(message?.result?.models?.availableModels)) {
        changed = applyToModels(message.result.models) || changed;
      }
      return changed;
    },

    picksHiddenModel(message) {
      const { method, params } = message ?? {};
      if (method === "session/set_model") return hides(params?.modelId);
      if (method !== "session/set_config_option") return false;
      return params?.configId === MODEL_OPTION && hides(params.value);
    },
  };
}
