import { readFileSync } from "node:fs";

const MODEL_OPTION = "model";

/**
 * Reads the picker file: `hide` is a list of regular expressions for the model values
 * to leave out, and `labels` maps a model value to the name that the editor shows.
 */
export function loadPicker(file) {
  const config = JSON.parse(readFileSync(file, "utf8"));
  const hide = (config.hide ?? []).map((pattern) => new RegExp(pattern));
  const labels = config.labels ?? {};
  const hides = (value) =>
    typeof value === "string" && hide.some((re) => re.test(value));

  function pickOptions(list, valueOf, current, rename) {
    const kept = list.filter(
      (item) => valueOf(item) === current || !hides(valueOf(item)),
    );
    for (const item of kept) {
      const label = labels[valueOf(item)];
      if (typeof label === "string") rename(item, label);
    }
    return kept;
  }

  function applyToOptions(configOptions) {
    let changed = false;
    for (const option of configOptions) {
      if (option?.id !== MODEL_OPTION || !Array.isArray(option.options)) continue;
      const before = JSON.stringify(option.options);
      option.options = pickOptions(
        option.options,
        (item) => item.value,
        option.currentValue,
        (item, label) => (item.name = label),
      );
      changed ||= before !== JSON.stringify(option.options);
    }
    return changed;
  }

  function applyToModels(models) {
    const before = JSON.stringify(models.availableModels);
    models.availableModels = pickOptions(
      models.availableModels,
      (item) => item.modelId,
      models.currentModelId,
      (item, label) => (item.name = label),
    );
    return before !== JSON.stringify(models.availableModels);
  }

  return {
    hides,

    /** Edits a message from the adapter in place. True when it changed. */
    apply(message) {
      let changed = false;
      const lists = [
        message?.result?.configOptions,
        message?.params?.update?.configOptions,
      ];
      for (const list of lists) {
        if (Array.isArray(list)) changed = applyToOptions(list) || changed;
      }
      if (Array.isArray(message?.result?.models?.availableModels)) {
        changed = applyToModels(message.result.models) || changed;
      }
      return changed;
    },

    /** True for a request that would pick a model that the picker hides. */
    picksHiddenModel(message) {
      const { method, params } = message ?? {};
      if (method === "session/set_model") return hides(params?.modelId);
      if (method !== "session/set_config_option") return false;
      return params?.configId === MODEL_OPTION && hides(params.value);
    },
  };
}
