import assert from "node:assert/strict";
import { describe, it } from "node:test";
import { loadConfig } from "../src/config/loadConfig.js";

const enabled = {
  NODE_ENV: "test", WRITING_FEEDBACK_ENABLED: "true",
  WRITING_FEEDBACK_MODEL_DIGEST: "sha256:" + "a".repeat(64),
  WRITING_FEEDBACK_GGUF_PATH: "/private/model.gguf",
  WRITING_FEEDBACK_OLLAMA_MANIFEST_PATH: "/private/model-manifest",
  WRITING_FEEDBACK_TOKENIZER_LIBRARY_SHA256: "b".repeat(64),
};
describe("Writing feedback configuration", () => {
  it("defaults off without requiring provider assets or changing existing service readiness", () => {
    const config = loadConfig({ NODE_ENV: "test" }).writingFeedback;
    assert.equal(config.enabled, false);
    assert.equal(config.retentionDays, 30);
    assert.equal(config.timeoutMs, 120000);
    assert.equal(config.model, "qwen3:4b-instruct-2507-q4_K_M");
  });
  it("accepts only complete private pinned pilot configuration", () => {
    const config = loadConfig(enabled).writingFeedback;
    assert.equal(config.enabled, true);
    assert.equal(config.providerUrl, "http://ollama:11434");
    assert.equal(config.tokenizer.modelPath, "/private/model.gguf");
    assert.equal(config.tokenizer.llamaCppVersion, "0.3.16");
  });
  it("rejects missing pins, external/credential URLs and unbounded controls", () => {
    for (const values of [
      { ...enabled, WRITING_FEEDBACK_MODEL_DIGEST: "" },
      { ...enabled, WRITING_FEEDBACK_GGUF_PATH: "relative.gguf" },
      { ...enabled, WRITING_FEEDBACK_OLLAMA_URL: "https://cloud.example.com" },
      { ...enabled, WRITING_FEEDBACK_OLLAMA_URL: "http://name:secret@ollama:11434" },
      { ...enabled, WRITING_FEEDBACK_TIMEOUT_MS: "999999" },
      { ...enabled, WRITING_FEEDBACK_RETENTION_DAYS: "0" },
      { ...enabled, WRITING_FEEDBACK_ENABLED: "yes" },
    ]) assert.throws(() => loadConfig(values), { code: "INVALID_CONFIGURATION" });
  });
});
