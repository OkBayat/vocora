import { spawn } from 'node:child_process';
import { createHash } from 'node:crypto';
import { isAbsolute } from 'node:path';
import { fileURLToPath } from 'node:url';

const MODEL = 'qwen3:4b-instruct-2507-q4_K_M';
const MAX_PROMPT_BYTES = 131072;
const MAX_RESULT_BYTES = 8192;
const RAW_TEMPLATE_VERSION = 'vocora-qwen-instruct-chatml-v1';
const HELPER = fileURLToPath(new URL('../../../scripts/writing-feedback-tokenize.py', import.meta.url));
const SHA256 = /^[a-f0-9]{64}$/;
const sha256 = (value) => createHash('sha256').update(value).digest('hex');
const failure = (code) => Object.assign(new Error(code), { code });

function runLocalTokenizer(payload, { pythonExecutable, timeoutMs, signal }) {
  return new Promise((resolve, reject) => {
    // Prompt data travels only through stdin, never process arguments or logs.
    const child = spawn(pythonExecutable, ['-I', '-B', HELPER], {
      shell: false, stdio: ['pipe', 'pipe', 'ignore'],
      env: { PATH: process.env.PATH || '', LANG: 'C.UTF-8' },
    });
    let output = '';
    let bytes = 0;
    let pendingError;
    const stop = (code = 'TOKENIZER_UNAVAILABLE') => {
      pendingError ||= failure(code);
      child.kill('SIGKILL');
    };
    const onAbort = () => stop('TOKENIZER_ABORTED');
    const timer = setTimeout(stop, timeoutMs);
    signal?.addEventListener('abort', onAbort, { once: true });
    if (signal?.aborted) onAbort();
    child.on('error', () => stop());
    child.stdin.on('error', () => stop());
    child.stdout.on('data', (chunk) => {
      bytes += chunk.length;
      if (bytes > MAX_RESULT_BYTES) return stop();
      output += chunk.toString('utf8');
    });
    child.on('close', (code) => {
      clearTimeout(timer);
      signal?.removeEventListener('abort', onAbort);
      // Do not release the caller's concurrency slot while native work is alive.
      if (pendingError) return reject(pendingError);
      if (code !== 0) return reject(failure('TOKENIZER_UNAVAILABLE'));
      try { resolve(JSON.parse(output)); } catch { reject(failure('TOKENIZER_UNAVAILABLE')); }
    });
    child.stdin.end(JSON.stringify(payload));
  });
}

function rawPromptFor({ model, modelDigest, messages, format, numCtx, numPredict, template }) {
  if (model !== MODEL || !/^sha256:[a-f0-9]{64}$/.test(modelDigest)
    || typeof template !== 'string' || !template || Buffer.byteLength(template) > MAX_PROMPT_BYTES
    || !Number.isSafeInteger(numCtx) || numCtx < 1
    || !Number.isSafeInteger(numPredict) || numPredict < 1 || numPredict >= numCtx
    || !Array.isArray(messages) || messages.length !== 2
    || !format || typeof format !== 'object' || Array.isArray(format)) {
    throw failure('TOKENIZER_REQUEST_INVALID');
  }
  for (const [index, message] of messages.entries()) {
    if (!message || message.role !== ['system', 'user'][index]
      || typeof message.content !== 'string' || !message.content
      || Object.keys(message).some((key) => !['role', 'content'].includes(key))
      || /<\|[^\n]*?\|>/.test(message.content)) {
      throw failure('TOKENIZER_REQUEST_INVALID');
    }
  }
  let schema;
  try { schema = JSON.stringify(format); } catch { throw failure('TOKENIZER_REQUEST_INVALID'); }
  if (/<\|[^\n]*?\|>/.test(schema)) throw failure('TOKENIZER_REQUEST_INVALID');
  const system = `${messages[0].content}\n\nReturn JSON matching this schema:\n${schema}`;
  // This bounded no-tools rendering follows Qwen Instruct's system/user format.
  // raw:true bypasses Ollama's Go template; its separately verified hash is provenance.
  const prompt = `<|im_start|>system\n${system}<|im_end|>\n`
    + `<|im_start|>user\n${messages[1].content}<|im_end|>\n<|im_start|>assistant\n`;
  if (Buffer.byteLength(prompt) > MAX_PROMPT_BYTES) throw failure('TOKENIZER_REQUEST_INVALID');
  return prompt;
}

export class WritingFeedbackTokenizer {
  constructor({ manifestPath, modelPath, pythonExecutable = 'python3', llamaCppVersion,
    nativeLibrarySha256, timeoutMs = 30000, runTokenizer = runLocalTokenizer } = {}) {
    this.configuration = { manifestPath, modelPath, pythonExecutable, llamaCppVersion,
      nativeLibrarySha256, timeoutMs };
    this.runTokenizer = runTokenizer;
  }

  getIdentity() {
    return `llama-cpp-python:${this.configuration.llamaCppVersion};`
      + `native-sha256:${this.configuration.nativeLibrarySha256};raw-template:${RAW_TEMPLATE_VERSION};`
      + 'add_special=true;parse_special=true';
  }

  async count(request, { signal } = {}) {
    if (signal?.aborted) throw failure('TOKENIZER_ABORTED');
    const config = this.configuration;
    if (typeof config.manifestPath !== 'string' || !isAbsolute(config.manifestPath)
      || typeof config.modelPath !== 'string' || !isAbsolute(config.modelPath)
      || typeof config.llamaCppVersion !== 'string' || !config.llamaCppVersion
      || !SHA256.test(config.nativeLibrarySha256)
      || typeof config.pythonExecutable !== 'string' || !config.pythonExecutable
      || !Number.isSafeInteger(config.timeoutMs) || config.timeoutMs < 1 || config.timeoutMs > 60000) {
      throw failure('TOKENIZER_NOT_PROVISIONED');
    }
    const rawPrompt = rawPromptFor(request);
    const templateSha256 = sha256(request.template);
    let result;
    try {
      result = await this.runTokenizer({
        manifest_path: config.manifestPath, model_path: config.modelPath,
        model_digest: request.modelDigest, template_sha256: templateSha256,
        llama_cpp_version: config.llamaCppVersion,
        native_library_sha256: config.nativeLibrarySha256, prompt: rawPrompt,
      }, { ...config, signal });
    } catch {
      if (signal?.aborted) throw failure('TOKENIZER_ABORTED');
      throw failure('TOKENIZER_UNAVAILABLE');
    }
    if (signal?.aborted) throw failure('TOKENIZER_ABORTED');
    if (!result || !Number.isSafeInteger(result.input_tokens) || result.input_tokens < 1
      || result.model_digest !== request.modelDigest || result.template_sha256 !== templateSha256
      || result.llama_cpp_version !== config.llamaCppVersion
      || result.native_library_sha256 !== config.nativeLibrarySha256
      || typeof result.tokenizer_identity !== 'string' || !result.tokenizer_identity
      || result.tokenizer_identity.length > 1024) {
      throw failure('TOKENIZER_IDENTITY_MISMATCH');
    }
    if (result.input_tokens + request.numPredict > request.numCtx) {
      throw failure('TOKENIZER_CONTEXT_EXCEEDED');
    }
    return { inputTokens: result.input_tokens, rawPrompt, modelDigest: request.modelDigest,
      templateSha256, tokenizerIdentity: result.tokenizer_identity, rawTemplateVersion: RAW_TEMPLATE_VERSION };
  }
}
