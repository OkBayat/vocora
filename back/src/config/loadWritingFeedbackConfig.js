import path from "node:path";
import { ValidationError } from "../domain/errors.js";

function invalid(message) { throw new ValidationError("INVALID_CONFIGURATION", message); }
function boundedInteger(value, fallback, minimum, maximum, name) {
  const number = Number(value ?? fallback);
  if (!Number.isSafeInteger(number) || number < minimum || number > maximum) invalid(`${name} must be an integer from ${minimum} to ${maximum}.`);
  return number;
}

export function loadWritingFeedbackConfig(env, { requireProvider = false } = {}) {
  const rawEnabled = String(env.WRITING_FEEDBACK_ENABLED ?? "false").toLowerCase();
  if (!["false", "true"].includes(rawEnabled)) invalid("WRITING_FEEDBACK_ENABLED must be true or false.");
  const enabled = rawEnabled === "true";
  const providerUrl = env.WRITING_FEEDBACK_OLLAMA_URL?.trim() || "http://ollama:11434";
  let url;
  try { url = new URL(providerUrl); } catch { invalid("WRITING_FEEDBACK_OLLAMA_URL must be the private local Ollama endpoint."); }
  if (url.protocol !== "http:" || !["ollama", "localhost", "127.0.0.1", "[::1]"].includes(url.hostname)
    || url.username || url.password || url.pathname !== "/" || url.search || url.hash) invalid("WRITING_FEEDBACK_OLLAMA_URL must be the private local Ollama endpoint.");
  const modelDigest = env.WRITING_FEEDBACK_MODEL_DIGEST?.trim() || "";
  const tokenizer = {
    pythonExecutable: env.WRITING_FEEDBACK_TOKENIZER_PYTHON?.trim() || "/opt/writing-feedback/bin/python",
    modelPath: env.WRITING_FEEDBACK_GGUF_PATH?.trim() || "",
    manifestPath: env.WRITING_FEEDBACK_OLLAMA_MANIFEST_PATH?.trim() || "",
    llamaCppVersion: env.WRITING_FEEDBACK_TOKENIZER_VERSION?.trim() || "0.3.16",
    nativeLibrarySha256: env.WRITING_FEEDBACK_TOKENIZER_LIBRARY_SHA256?.trim() || "",
    timeoutMs: 30_000,
  };
  if ((enabled || requireProvider) && (!/^sha256:[a-f0-9]{64}$/u.test(modelDigest)
    || !path.isAbsolute(tokenizer.modelPath) || !path.isAbsolute(tokenizer.manifestPath)
    || !path.isAbsolute(tokenizer.pythonExecutable)
    || !/^\d+\.\d+\.\d+$/u.test(tokenizer.llamaCppVersion)
    || !/^[a-f0-9]{64}$/u.test(tokenizer.nativeLibrarySha256))) {
    invalid("Enabled local text feedback requires the full model digest and pinned local tokenizer paths, version and library hash.");
  }
  return {
    enabled, providerUrl, model: "qwen3:4b-instruct-2507-q4_K_M", modelDigest,
    timeoutMs: boundedInteger(env.WRITING_FEEDBACK_TIMEOUT_MS, 120_000, 1000, 180_000, "WRITING_FEEDBACK_TIMEOUT_MS"),
    retentionDays: boundedInteger(env.WRITING_FEEDBACK_RETENTION_DAYS, 30, 1, 90, "WRITING_FEEDBACK_RETENTION_DAYS"),
    tokenizer,
  };
}
