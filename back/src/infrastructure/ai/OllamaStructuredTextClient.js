import { createHash } from 'node:crypto';
import { StructuredInferenceError } from './StructuredInferenceError.js';
import { privateOllamaFetch, privateOllamaUrl } from './PrivateOllamaTransport.js';

const MODEL = 'qwen3:4b-instruct-2507-q4_K_M';
const DIGEST = /^sha256:[a-f0-9]{64}$/;
const MAX_RESPONSE_BYTES = 65536;
const MAX_MODEL_TEXT_BYTES = 16384;
const METRICS = ['total_duration', 'load_duration', 'prompt_eval_count', 'prompt_eval_cached_count',
  'prompt_eval_duration', 'eval_count', 'eval_duration'];
const fail = code => { throw new StructuredInferenceError(code); };

async function boundedJson(response) {
  if (response.status < 200 || response.status >= 300) {
    await response.body?.cancel(); fail('STRUCTURED_INFERENCE_PROVIDER_UNAVAILABLE');
  }
  if (Number(response.headers.get('content-length')) > MAX_RESPONSE_BYTES) {
    await response.body?.cancel(); fail('STRUCTURED_INFERENCE_OUTPUT_LIMIT');
  }
  if (!response.body) fail('STRUCTURED_INFERENCE_INVALID_RESULT');
  const reader = response.body.getReader(); const chunks = []; let size = 0;
  try {
    while (true) {
      const { done, value } = await reader.read();
      if (done) break;
      size += value.byteLength;
      if (size > MAX_RESPONSE_BYTES) { await reader.cancel(); fail('STRUCTURED_INFERENCE_OUTPUT_LIMIT'); }
      chunks.push(value);
    }
    return JSON.parse(new TextDecoder('utf-8', { fatal: true }).decode(Buffer.concat(chunks)));
  } catch (error) {
    if (error instanceof StructuredInferenceError) throw error;
    fail('STRUCTURED_INFERENCE_INVALID_RESULT');
  } finally { reader.releaseLock(); }
}

export class OllamaStructuredTextClient {
  constructor({ baseUrl = 'http://ollama:11434', model = MODEL, modelDigest, tokenizer,
    numCtx = 4096, numPredict = 768, timeoutMs = 120000, fetchImpl = privateOllamaFetch } = {}) {
    this.baseUrl = privateOllamaUrl(baseUrl);
    const normalizedDigest = typeof modelDigest === 'string' ? `sha256:${modelDigest.replace(/^sha256:/, '')}` : '';
    if (model !== MODEL || !DIGEST.test(normalizedDigest)
        || !Number.isInteger(numCtx) || numCtx < 1024 || numCtx > 32768
        || !Number.isInteger(numPredict) || numPredict < 64 || numPredict > 2048 || numPredict >= numCtx
        || !Number.isInteger(timeoutMs) || timeoutMs < 1 || timeoutMs > 300000) fail('STRUCTURED_INFERENCE_CONFIGURATION');
    this.model = model; this.modelDigest = normalizedDigest; this.tokenizer = tokenizer;
    this.options = Object.freeze({ num_ctx: numCtx, num_predict: numPredict, temperature: 0, num_gpu: 0 });
    this.timeoutMs = timeoutMs; this.fetchImpl = fetchImpl; this.busy = false;
  }

  getIdentity() {
    return { model: this.model, modelDigest: this.modelDigest, decodingVersion: 'cpu-pilot-v1',
      tokenizerIdentity: this.tokenizer?.getIdentity?.() ?? null, options: { ...this.options } };
  }

  async call(path, payload, signal) {
    return boundedJson(await this.fetchImpl(new URL(path, this.baseUrl), {
      method: payload === undefined ? 'GET' : 'POST',
      headers: { 'Content-Type': 'application/json' },
      ...(payload === undefined ? {} : { body: JSON.stringify(payload) }), signal,
    }));
  }

  async verifyModel(signal) {
    const tags = await this.call('/api/tags', undefined, signal);
    const matches = tags?.models?.filter(item => item.name === this.model || item.model === this.model);
    if (!Array.isArray(matches) || matches.length !== 1
        || `sha256:${matches[0].digest?.replace(/^sha256:/, '')}` !== this.modelDigest) fail('STRUCTURED_INFERENCE_MODEL_MISMATCH');
  }

  async infer({ messages, format, signal }) {
    if (!this.tokenizer?.count) fail('STRUCTURED_INFERENCE_TOKENIZER_UNAVAILABLE');
    if (this.busy) fail('STRUCTURED_INFERENCE_BUSY');
    if (signal?.aborted) fail('STRUCTURED_INFERENCE_CANCELLED');
    this.busy = true;
    const controller = new AbortController(); let timedOut = false;
    const cancel = () => controller.abort();
    signal?.addEventListener('abort', cancel, { once: true });
    const timer = setTimeout(() => { timedOut = true; controller.abort(); }, this.timeoutMs);
    try {
      await this.verifyModel(controller.signal);
      const details = await this.call('/api/show', { model: this.model }, controller.signal);
      if (typeof details?.template !== 'string' || !details.template
          || !details.capabilities?.includes('completion')
          || details.details?.family !== 'qwen3' || details.details?.quantization_level !== 'Q4_K_M') {
        fail('STRUCTURED_INFERENCE_MODEL_MISMATCH');
      }
      const budget = await this.tokenizer.count({ model: this.model, modelDigest: this.modelDigest,
        messages, format, numCtx: this.options.num_ctx,
        numPredict: this.options.num_predict, template: details.template }, { signal: controller.signal });
      if (budget?.modelDigest !== this.modelDigest || typeof budget.rawPrompt !== 'string'
          || !budget.rawPrompt || !Number.isSafeInteger(budget.inputTokens) || budget.inputTokens < 1
          || budget.templateSha256 !== createHash('sha256').update(details.template).digest('hex')
          || !budget.tokenizerIdentity) fail('STRUCTURED_INFERENCE_TOKENIZER_MISMATCH');
      if (budget.inputTokens + this.options.num_predict > this.options.num_ctx) fail('STRUCTURED_INFERENCE_INPUT_TOO_LARGE');
      if (controller.signal.aborted) fail(timedOut ? 'STRUCTURED_INFERENCE_TIMEOUT' : 'STRUCTURED_INFERENCE_CANCELLED');
      const output = await this.call('/api/generate', { model: this.model, prompt: budget.rawPrompt,
        raw: true, stream: false, format, options: this.options, keep_alive: '1m' }, controller.signal);
      if (output?.model !== this.model) fail('STRUCTURED_INFERENCE_MODEL_MISMATCH');
      if (output.done !== true || output.done_reason !== 'stop'
          || !Number.isSafeInteger(output.eval_count) || output.eval_count >= this.options.num_predict
          || typeof output.response !== 'string' || Buffer.byteLength(output.response) > MAX_MODEL_TEXT_BYTES) {
        fail('STRUCTURED_INFERENCE_OUTPUT_LIMIT');
      }
      if (output.prompt_eval_count !== budget.inputTokens) fail('STRUCTURED_INFERENCE_TOKENIZER_MISMATCH');
      let decoded;
      try { decoded = JSON.parse(output.response); } catch { fail('STRUCTURED_INFERENCE_INVALID_RESULT'); }
      await this.verifyModel(controller.signal);
      const metrics = {};
      for (const key of METRICS) {
        if (output[key] !== undefined) {
          if (!Number.isSafeInteger(output[key]) || output[key] < 0) fail('STRUCTURED_INFERENCE_INVALID_RESULT');
          metrics[key] = output[key];
        }
      }
      return { decoded, provenance: { tokenizerIdentity: budget.tokenizerIdentity,
        templateSha256: budget.templateSha256, rawTemplateVersion: budget.rawTemplateVersion }, metrics };
    } catch (error) {
      if (timedOut) fail('STRUCTURED_INFERENCE_TIMEOUT');
      if (signal?.aborted) fail('STRUCTURED_INFERENCE_CANCELLED');
      if (error instanceof StructuredInferenceError) throw error;
      if (error?.code === 'TOKENIZER_CONTEXT_EXCEEDED') fail('STRUCTURED_INFERENCE_INPUT_TOO_LARGE');
      if (error?.code === 'TOKENIZER_IDENTITY_MISMATCH') fail('STRUCTURED_INFERENCE_TOKENIZER_MISMATCH');
      if (['TOKENIZER_NOT_PROVISIONED', 'TOKENIZER_UNAVAILABLE'].includes(error?.code)) fail('STRUCTURED_INFERENCE_TOKENIZER_UNAVAILABLE');
      fail('STRUCTURED_INFERENCE_PROVIDER_UNAVAILABLE');
    } finally {
      clearTimeout(timer); signal?.removeEventListener('abort', cancel); this.busy = false;
    }
  }
}
