import assert from "node:assert/strict";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { after, test } from "node:test";
import { loadPicker } from "../model-picker.mjs";

const directories = [];
after(() =>
  directories.forEach((dir) => rmSync(dir, { recursive: true, force: true })),
);

function picker(config) {
  const dir = mkdtempSync(join(tmpdir(), "acp-picker-"));
  directories.push(dir);
  const file = join(dir, "picker.json");
  writeFileSync(file, typeof config === "string" ? config : JSON.stringify(config));
  return loadPicker(file);
}

const modelOption = (currentValue = "sonnet") => ({
  id: "model",
  type: "select",
  currentValue,
  options: ["default", "opus", "sonnet", "claude-opus-4-6", "haiku"].map((value) => ({
    value,
    name: value.toUpperCase(),
  })),
});
const effortOption = {
  id: "effort",
  type: "select",
  currentValue: "high",
  options: [],
};
const values = (option) => option.options.map((item) => item.value);

test("models that match a pattern are left out and others get their label", () => {
  const { apply } = picker({
    hide: ["^claude-.*-4-", "^default$"],
    labels: { opus: "Opus 5.5", sonnet: "Sonnet 5.5" },
  });
  const message = { id: 1, result: { configOptions: [modelOption(), effortOption] } };

  assert.equal(apply(message), true);
  const [model, effort] = message.result.configOptions;
  assert.deepEqual(values(model), ["opus", "sonnet", "haiku"]);
  assert.deepEqual(
    model.options.map((item) => item.name),
    ["Opus 5.5", "Sonnet 5.5", "HAIKU"],
  );
  assert.deepEqual(effort, effortOption, "other options are untouched");
});

test("the model that a thread runs stays, even when it is hidden", () => {
  const { apply } = picker({ hide: ["^claude-"] });
  const message = { result: { configOptions: [modelOption("claude-opus-4-6")] } };
  apply(message);
  assert.deepEqual(values(message.result.configOptions[0]), [
    "default",
    "opus",
    "sonnet",
    "claude-opus-4-6",
    "haiku",
  ]);
  const other = { result: { configOptions: [modelOption("sonnet")] } };
  apply(other);
  assert.ok(!values(other.result.configOptions[0]).includes("claude-opus-4-6"));
});

test("option updates and the legacy model list are changed too", () => {
  const { apply } = picker({ hide: ["^default$"], labels: { opus: "Opus" } });
  const update = { params: { update: { configOptions: [modelOption()] } } };
  assert.equal(apply(update), true);
  assert.ok(!values(update.params.update.configOptions[0]).includes("default"));

  const legacy = {
    result: {
      models: {
        currentModelId: "sonnet",
        availableModels: [
          { modelId: "default", name: "Default" },
          { modelId: "opus", name: "Opus" },
          { modelId: "sonnet", name: "Sonnet" },
        ],
      },
    },
  };
  assert.equal(apply(legacy), true);
  assert.deepEqual(
    legacy.result.models.availableModels.map((item) => item.modelId),
    ["opus", "sonnet"],
  );
});

test("a message without a model option is not changed", () => {
  const { apply } = picker({ hide: ["opus"], labels: { opus: "Opus" } });
  for (const message of [
    { id: 1, result: {} },
    { method: "session/update" },
    null,
    5,
  ]) {
    assert.equal(apply(message), false);
  }
  assert.equal(apply({ result: { configOptions: [effortOption] } }), false);
});

test("a request for a hidden model is recognised", () => {
  const { picksHiddenModel } = picker({ hide: ["^claude-"] });
  const setOption = (configId, value) => ({
    method: "session/set_config_option",
    params: { configId, value },
  });
  assert.equal(picksHiddenModel(setOption("model", "claude-opus-4-6")), true);
  assert.equal(picksHiddenModel(setOption("model", "opus")), false);
  assert.equal(picksHiddenModel(setOption("effort", "claude-x")), false);
  assert.equal(
    picksHiddenModel({ method: "session/set_model", params: { modelId: "claude-a" } }),
    true,
  );
  assert.equal(picksHiddenModel({ method: "session/prompt", params: {} }), false);
  assert.equal(picksHiddenModel(undefined), false);
});

test("an empty or unusable file is reported", () => {
  assert.deepEqual(picker({}).apply({}), false);
  assert.throws(() => picker("{not json"));
  assert.throws(() => picker({ hide: ["("] }));
});
