import assert from 'node:assert/strict';
import test from 'node:test';
import { createHash } from 'node:crypto';
import { OllamaStructuredTextClient } from '../src/infrastructure/ai/OllamaStructuredTextClient.js';

const model = 'qwen3:4b-instruct-2507-q4_K_M';
const modelDigest = `sha256:${'a'.repeat(64)}`;
const template = 'Synthetic pinned template';
const templateSha256 = createHash('sha256').update(template).digest('hex');
const format = { type: 'object', additionalProperties: false, required: ['ok'], properties: { ok: { const: true } } };
const messages = [{ role: 'system', content: 'Return JSON.' }, { role: 'user', content: '{"answer":"hello"}' }];

test('generic client sends one exact structured prompt and returns only decoded data plus provenance', async () => {
  const calls = [];
  const client = new OllamaStructuredTextClient({ modelDigest,
    tokenizer: { getIdentity: () => 'test-tokenizer', count: async request => {
      assert.deepEqual(request.format, format); assert.deepEqual(request.messages, messages);
      return { inputTokens: 50, rawPrompt: 'exact synthetic raw prompt', modelDigest, templateSha256,
        tokenizerIdentity: 'test-tokenizer', rawTemplateVersion: 'test-template' };
    } },
    fetchImpl: async (url, options) => {
      calls.push({ url: String(url), options });
      if (String(url).endsWith('/api/tags')) return Response.json({ models: [{ name: model, digest: modelDigest }] });
      if (String(url).endsWith('/api/show')) return Response.json({ template, capabilities: ['completion'], details: { family: 'qwen3', quantization_level: 'Q4_K_M' } });
      return Response.json({ model, done: true, done_reason: 'stop', response: '{"ok":true}', prompt_eval_count: 50, eval_count: 7 });
    } });
  const output = await client.infer({ messages, format });
  assert.deepEqual(output.decoded, { ok: true });
  assert.equal(output.provenance.templateSha256, templateSha256);
  assert.equal(JSON.stringify(output).includes('raw prompt'), false);
  assert.deepEqual(calls.map(call => new URL(call.url).pathname), ['/api/tags', '/api/show', '/api/generate', '/api/tags']);
  const payload = JSON.parse(calls[2].options.body);
  assert.equal(payload.prompt, 'exact synthetic raw prompt'); assert.deepEqual(payload.format, format);
});

test('shared client holds capacity until cancelled tokenizer has actually settled', async () => {
  let started; let stop; const active = new Promise(resolve => { started = resolve; });
  const stopped = new Promise(resolve => { stop = resolve; });
  const client = new OllamaStructuredTextClient({ modelDigest,
    tokenizer: { count: async (_request, { signal }) => {
      started(); await new Promise(resolve => signal.addEventListener('abort', resolve, { once: true }));
      await stopped; throw new Error('private tokenizer diagnostics');
    } }, fetchImpl: async url => String(url).endsWith('/api/tags')
      ? Response.json({ models: [{ name: model, digest: modelDigest }] })
      : Response.json({ template, capabilities: ['completion'], details: { family: 'qwen3', quantization_level: 'Q4_K_M' } }) });
  const controller = new AbortController(); const pending = client.infer({ messages, format, signal: controller.signal });
  await active; controller.abort();
  await assert.rejects(client.infer({ messages, format }), { code: 'STRUCTURED_INFERENCE_BUSY' });
  stop(); await assert.rejects(pending, { code: 'STRUCTURED_INFERENCE_CANCELLED' });
  assert.equal(client.busy, false);
});
