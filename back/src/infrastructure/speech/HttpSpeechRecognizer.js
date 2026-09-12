import { Readable } from 'node:stream';
import { AppError } from '../../domain/errors.js';
import { privateServiceFetch, privateServiceUrl } from '../ai/PrivateOllamaTransport.js';

const MAX_RESPONSE_BYTES = 128 * 1024;
const unavailable = () => new AppError(503, 'SHADOWING_UNAVAILABLE', 'Speech recognition is temporarily unavailable. Please try again. Your attempt was not marked wrong.');
const cancelled = () => new AppError(499, 'SPEECH_CANCELLED', 'Speech recognition was cancelled.');
const object = (value) => value !== null && typeof value === 'object' && !Array.isArray(value);
const exactKeys = (value, keys) => object(value) && Object.keys(value).length === keys.length
  && Object.keys(value).every((key) => keys.includes(key));
const safeText = (value, maximum) => typeof value === 'string' && value.length <= maximum
  && !/[\p{Cc}\p{Cs}\u202a-\u202e\u2066-\u2069]/u.test(value);

function detailedResult(data, final) {
  if (!exactKeys(data, ['schemaVersion', 'status', 'text', 'confidence', 'wordEvidence', 'providerIdentity'])
    || data.schemaVersion !== 1 || data.confidence !== null || !safeText(data.text, 8000)
    || !Array.isArray(data.wordEvidence) || data.wordEvidence.length > 500
    || (final ? !['transcribed', 'insufficient_evidence'].includes(data.status) : data.status !== 'partial')
    || (data.status === 'transcribed' && !data.text.trim())
    || (data.status === 'insufficient_evidence' && (data.text.trim() || data.wordEvidence.length))) throw unavailable();
  const identity = data.providerIdentity;
  if (!exactKeys(identity, ['provider', 'runtimeVersion', 'modelId', 'modelDigest']) || identity.provider !== 'vosk'
    || [identity.runtimeVersion, identity.modelId].some((value) => value !== null
      && (!safeText(value, 128) || !value.trim()))
    || (identity.modelDigest !== null && (typeof identity.modelDigest !== 'string'
      || !/^sha256:[a-f0-9]{64}$/.test(identity.modelDigest)))) throw unavailable();
  let previousStart = 0;
  for (const word of data.wordEvidence) {
    if (!exactKeys(word, ['word', 'startSeconds', 'endSeconds', 'confidence'])
      || !safeText(word.word, 128) || !word.word.trim()
      || !Number.isFinite(word.startSeconds) || !Number.isFinite(word.endSeconds)
      || word.startSeconds < previousStart || word.endSeconds < word.startSeconds || word.endSeconds > 30
      || (word.confidence !== null && (!Number.isFinite(word.confidence) || word.confidence < 0 || word.confidence > 1))) {
      throw unavailable();
    }
    previousStart = word.startSeconds;
  }
  return data;
}

async function boundedJson(response, signal) {
  const declared = response.headers.get('content-length');
  if (!response.body || (declared !== null && (!/^\d+$/.test(declared) || Number(declared) > MAX_RESPONSE_BYTES))) {
    response.body?.cancel().catch(() => {});
    throw unavailable();
  }
  const stream = Readable.fromWeb(response.body, { signal });
  const chunks = [];
  let bytes = 0;
  try {
    for await (const chunk of stream) {
      bytes += chunk.length;
      if (bytes > MAX_RESPONSE_BYTES) throw unavailable();
      chunks.push(chunk);
    }
    return JSON.parse(new TextDecoder('utf-8', { fatal: true }).decode(Buffer.concat(chunks)));
  } finally {
    stream.destroy();
  }
}

export class HttpSpeechRecognizer {
  constructor({ url = '', timeoutMs = 10000, fetchImpl, privateOnly = false } = {}) {
    this.url = url.replace(/\/$/u, '');
    this.fetch = fetchImpl ?? (privateOnly ? privateServiceFetch : globalThis.fetch);
    this.timeoutMs = timeoutMs;
    if (privateOnly && this.url) {
      try { this.url = privateServiceUrl(this.url, ['speech']).origin; } catch { throw unavailable(); }
    }
    if (this.url && !/^https?:\/\//u.test(this.url)) throw new Error('SHADOWING_SPEECH_URL must be an HTTP(S) URL.');
    if (!Number.isSafeInteger(timeoutMs) || timeoutMs < 1 || timeoutMs > 120000) throw new Error('Speech request timeout is invalid.');
  }
  async request(path, method = 'POST', body, { signal } = {}) {
    if (signal?.aborted) throw cancelled();
    if (!this.url) throw new AppError(503, 'SHADOWING_UNAVAILABLE', 'Speech recognition is not configured. Start the speech service to use Shadowing.');
    const operationSignal = signal ? AbortSignal.any([signal, AbortSignal.timeout(this.timeoutMs)]) : AbortSignal.timeout(this.timeoutMs);
    try {
      const response = await this.fetch(`${this.url}${path}`, {
        method, body, signal: operationSignal, redirect: 'error',
        headers: { 'Content-Type': 'application/octet-stream' },
      });
      if (!response.ok) {
        response.body?.cancel().catch(() => {});
        throw unavailable();
      }
      const data = await boundedJson(response, operationSignal);
      if (!object(data) || (data.text !== undefined && !safeText(data.text, 8000))) throw unavailable();
      if (signal?.aborted) throw cancelled();
      return data;
    } catch {
      if (signal?.aborted) throw cancelled();
      throw unavailable();
    }
  }
  async ready(options) { await this.request('/health', 'GET', undefined, options); }
  async start(id, options) { await this.request(`/sessions/${encodeURIComponent(id)}`, 'PUT', undefined, options); }
  async chunk(id, sequence, pcm, options) {
    const data = await this.#chunk(id, sequence, pcm, options);
    return data.text ?? '';
  }
  async finish(id, options) {
    const data = await this.request(`/sessions/${encodeURIComponent(id)}/finish`, 'POST', undefined, options);
    return data.text ?? '';
  }
  async chunkDetailed(id, sequence, pcm, options) {
    return detailedResult(await this.#chunk(id, sequence, pcm, options), false);
  }
  async finishDetailed(id, options) {
    return detailedResult(await this.request(`/sessions/${encodeURIComponent(id)}/finish`, 'POST', undefined, options), true);
  }
  async #chunk(id, sequence, pcm, options) {
    if (!Number.isSafeInteger(sequence) || sequence < 0 || !(pcm instanceof Uint8Array)
      || !pcm.length || pcm.length > 32000 || pcm.length % 2) {
      throw new AppError(400, 'INVALID_SPEECH_CHUNK', 'Expected bounded, ordered PCM16 mono audio.');
    }
    return this.request(`/sessions/${encodeURIComponent(id)}/chunks?sequence=${sequence}`, 'POST', pcm, options);
  }
  async cancel(id, options) {
    try { await this.request(`/sessions/${encodeURIComponent(id)}`, 'DELETE', undefined, options); } catch { /* Provider TTL also releases interrupted recordings. */ }
  }
}
