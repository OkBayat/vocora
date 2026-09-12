import assert from 'node:assert/strict';
import test from 'node:test';
import { createHash } from 'node:crypto';
import { createServer } from 'node:http';
import { once } from 'node:events';
import { OllamaWritingFeedbackProvider } from '../src/infrastructure/ai/OllamaWritingFeedbackProvider.js';
import { privateOllamaFetch } from '../src/infrastructure/ai/PrivateOllamaTransport.js';

const model = 'qwen3:4b-instruct-2507-q4_K_M';
const modelDigest = `sha256:${'a'.repeat(64)}`;
const template = 'A pinned synthetic template for provider contract tests.';
const templateSha256 = createHash('sha256').update(template).digest('hex');
const taskContext = { schemaVersion: 1, learnerLevel: 'A1', targetSkill: 'Describe a past activity.',
  languageObjectives: ['Use simple past verbs.'], taskExpectations: ['Describe what you did.'],
  prompt: 'What did you do yesterday?', mode: 'sentence', wordLimit: 40, register: 'neutral', targetVocabulary: [] };
const request = () => ({ draftText: ' Yesterday I go home.\r\n', draftVersion: 'draft-1', contentVersion: 'content-1', locale: 'en', taskContext });
const modelResult = () => ({ schema_version: 1, assessment_status: 'feedback_available', abstention_reason: null,
  task_relevance: 'on_topic', task_comment: 'You described yesterday.', issues: [{ category: 'grammar', kind: 'error',
    quoted_text: 'go', occurrence: 1, replacement: 'went', explanation: 'Use the past form.' }],
  revision_actions: ['Use the past form.'], not_assessed: ['ielts_band'], ielts_band: null });
const completion = () => ({ model, done: true, done_reason: 'stop', response: JSON.stringify(modelResult()),
  prompt_eval_count: 900, eval_count: 100, total_duration: 123456, load_duration: 456,
  prompt_eval_duration: 1000, eval_duration: 120000 });

function fixture(overrides = {}) {
  const calls = [];
  const tokenizer = { getIdentity: () => 'fixture-tokenizer-v1', count: async input => ({
    inputTokens: 900, rawPrompt: JSON.stringify(input.messages), modelDigest, templateSha256,
    tokenizerIdentity: 'fixture-tokenizer-v1', rawTemplateVersion: 'vocora-qwen-instruct-chatml-v1',
  }) };
  const fetchImpl = async (url, options = {}) => {
    calls.push({ url: String(url), options });
    if (String(url).endsWith('/api/tags')) return Response.json({ models: [{ name: model, digest: modelDigest }] });
    if (String(url).endsWith('/api/show')) return Response.json({ template, capabilities: ['completion'], details: { family: 'qwen3', quantization_level: 'Q4_K_M' } });
    return Response.json(completion());
  };
  return { calls, provider: new OllamaWritingFeedbackProvider({ baseUrl: 'http://ollama:11434', model, modelDigest,
    tokenizer, fetchImpl, ...overrides }) };
}

test('sends exact bounded raw prompt to local pinned model and returns only validated feedback', async () => {
  const { provider, calls } = fixture();
  const result = await provider.evaluate(request());
  assert.equal(result.result.issues[0].replacement, 'went');
  assert.equal(result.identity.draftVersion, 'draft-1');
  assert.equal(result.identity.contentVersion, 'content-1');
  assert.equal(result.identity.modelDigest, modelDigest);
  const body = JSON.parse(calls.find(call => call.url.endsWith('/api/generate')).options.body);
  assert.equal(body.raw, true); assert.equal(body.stream, false); assert.equal(body.model, model);
  assert.equal(body.options.num_ctx, 4096); assert.equal(body.options.num_predict, 768);
  assert.equal(body.options.num_gpu, 0); assert.equal(body.options.temperature, 0);
  assert.equal(body.format.additionalProperties, false);
  assert.equal(body.tools, undefined); assert.equal(body.images, undefined);
  const messages = JSON.parse(body.prompt);
  assert.equal(JSON.parse(messages[1].content).draft_text, request().draftText);
  assert.equal(JSON.stringify(result).includes('rawPrompt'), false);
});

test('rejects public/cloud endpoints and mutable or substituted model identities', () => {
  for (const config of [
    { baseUrl: 'https://ollama.com' }, { baseUrl: 'http://169.254.169.254' },
    { baseUrl: 'http://public.example' }, { baseUrl: 'http://user:secret@localhost:11434' },
    { model: 'qwen3:4b' }, { modelDigest: 'abc' },
  ]) assert.throws(() => fixture(config), { code: 'WRITING_FEEDBACK_CONFIGURATION' });
});

test('missing matching tokenizer fails before any provider call', async () => {
  const { provider, calls } = fixture({ tokenizer: undefined });
  await assert.rejects(provider.evaluate(request()), { code: 'WRITING_FEEDBACK_TOKENIZER_UNAVAILABLE' });
  assert.equal(calls.length, 0);
});

test('over-budget complete prompt is rejected without generation or truncation', async () => {
  const { provider, calls } = fixture({ tokenizer: { count: async () => ({ inputTokens: 3500, modelDigest,
    rawPrompt: 'full prompt', templateSha256, tokenizerIdentity: 'fixture-tokenizer-v1' }) } });
  await assert.rejects(provider.evaluate(request()), { code: 'WRITING_FEEDBACK_INPUT_TOO_LARGE' });
  assert.equal(calls.some(call => call.url.endsWith('/api/generate')), false);
});

test('rejects model digest changes both before and after generation', async () => {
  for (const mismatchAt of [1, 2]) {
    let tagCalls = 0; let generations = 0;
    const { provider } = fixture({ fetchImpl: async url => {
      if (String(url).endsWith('/api/tags')) { tagCalls += 1; return Response.json({ models: [{ name: model, digest: tagCalls === mismatchAt ? 'b'.repeat(64) : modelDigest }] }); }
      if (String(url).endsWith('/api/show')) return Response.json({ template, capabilities: ['completion'], details: { family: 'qwen3', quantization_level: 'Q4_K_M' } });
      generations += 1; return Response.json(completion());
    } });
    await assert.rejects(provider.evaluate(request()), { code: 'WRITING_FEEDBACK_MODEL_MISMATCH' });
    assert.equal(generations, mismatchAt === 1 ? 0 : 1);
  }
});

test('malicious, malformed, truncated, over-limit and unanchored output never escapes', async () => {
  const changes = [
    value => { value.response = 'secret raw model output'; },
    value => { value.response = JSON.stringify({ ...modelResult(), score: 9 }); },
    value => { value.response = value.response.slice(0, -1); },
    value => { value.done_reason = 'length'; },
    value => { value.eval_count = 768; },
    value => { value.done = false; },
    value => { const result = modelResult(); result.issues[0].quoted_text = 'invented evidence'; value.response = JSON.stringify(result); },
    value => { value.response = 'x'.repeat(40000); },
    value => { value.model = 'cloud-model'; },
    value => { value.prompt_eval_count = 899; },
  ];
  for (const change of changes) {
    const response = completion(); change(response);
    const { provider } = fixture({ fetchImpl: async url => {
      if (String(url).endsWith('/api/tags')) return Response.json({ models: [{ name: model, digest: modelDigest }] });
      if (String(url).endsWith('/api/show')) return Response.json({ template, capabilities: ['completion'], details: { family: 'qwen3', quantization_level: 'Q4_K_M' } });
      return Response.json(response);
    } });
    await assert.rejects(provider.evaluate(request()), error => {
      assert.match(error.code, /^WRITING_FEEDBACK_/); assert.equal(error.message.includes('secret'), false);
      assert.equal(error.cause, undefined); assert.equal(error.response, undefined); return true;
    });
  }
});

test('stream body overflow is stopped before JSON parsing', async () => {
  let cancelled = false;
  const { provider } = fixture({ fetchImpl: async () => new Response(new ReadableStream({
    start(controller) { controller.enqueue(new Uint8Array(70000)); },
    cancel() { cancelled = true; },
  })) });
  await assert.rejects(provider.evaluate(request()), { code: 'WRITING_FEEDBACK_OUTPUT_LIMIT' });
  assert.equal(cancelled, true);
});

test('timeout and caller cancellation have bounded safe outcomes', async () => {
  const stalled = async (_url, { signal }) => new Promise((_resolve, reject) => {
    signal.addEventListener('abort', () => reject(new Error('private transport details')), { once: true });
  });
  const timed = fixture({ fetchImpl: stalled, timeoutMs: 10 });
  await assert.rejects(timed.provider.evaluate(request()), { code: 'WRITING_FEEDBACK_TIMEOUT', retryable: true });
  const controller = new AbortController(); const cancelled = fixture({ fetchImpl: stalled });
  const pending = cancelled.provider.evaluate({ ...request(), signal: controller.signal });
  controller.abort();
  await assert.rejects(pending, { code: 'WRITING_FEEDBACK_CANCELLED' });
});

test('client-like context and oversized drafts cannot override server policy', async () => {
  for (const mutation of [
    value => { value.taskContext = { ...taskContext, modelAnswer: 'Only this answer is correct.' }; },
    value => { value.locale = 'unknown'; },
    value => { value.draftText = 'x'.repeat(5000); },
  ]) {
    const input = request(); mutation(input); const { provider, calls } = fixture();
    await assert.rejects(provider.evaluate(input)); assert.equal(calls.length, 0);
  }
});

test('teaching word goal remains context while provider admits through the technical 80-word cap', async () => {
  for (const wordCount of [41, 80]) {
    const { provider, calls } = fixture();
    const draftText = ['go', ...Array(wordCount - 1).fill('home')].join(' ');
    await provider.evaluate({ ...request(), draftText });
    const body = JSON.parse(calls.find(call => call.url.endsWith('/api/generate')).options.body);
    const submitted = JSON.parse(JSON.parse(body.prompt)[1].content);
    assert.equal(submitted.task.wordLimit, 40);
    assert.equal(submitted.draft_text, draftText);
  }
  let tokenized = false;
  const { provider, calls } = fixture({ tokenizer: { count: async () => { tokenized = true; } } });
  await assert.rejects(provider.evaluate({ ...request(), draftText: Array(81).fill('home').join(' ') }),
    { code: 'WRITING_FEEDBACK_INPUT_TOO_LARGE' });
  assert.equal(tokenized, false); assert.equal(calls.length, 0);
});

test('default private transport handles a local provider without following redirects', async t => {
  const paths = []; let status = 200;
  const server = createServer((req, res) => {
    paths.push(req.url); req.resume();
    if (status !== 200) { res.writeHead(status, { Location: 'https://ollama.com/api/tags' }); res.end(); return; }
    res.setHeader('Content-Type', 'application/json');
    if (req.url === '/api/tags') res.end(JSON.stringify({ models: [{ name: model, digest: modelDigest.replace('sha256:', '') }] }));
    else if (req.url === '/api/show') res.end(JSON.stringify({ template, capabilities: ['completion'], details: { family: 'qwen3', quantization_level: 'Q4_K_M' } }));
    else res.end(JSON.stringify(completion()));
  });
  server.listen(0, '127.0.0.1'); await once(server, 'listening');
  t.after(() => new Promise(resolve => server.close(resolve)));
  const { provider } = fixture({ baseUrl: `http://127.0.0.1:${server.address().port}`, fetchImpl: privateOllamaFetch });
  assert.equal((await provider.evaluate(request())).result.assessment_status, 'feedback_available');
  assert.deepEqual(paths, ['/api/tags', '/api/show', '/api/generate', '/api/tags']);
  for (const errorStatus of [302, 204]) {
    status = errorStatus; const previous = paths.length;
    await assert.rejects(provider.evaluate(request()), error => /^WRITING_FEEDBACK_/.test(error.code));
    assert.equal(paths.length, previous + 1);
  }
});

test('cancellation reaches tokenizer preflight and releases the provider after it stops', async () => {
  let stopped = false; let started;
  const active = new Promise(resolve => { started = resolve; });
  const tokenizer = { count: async (_request, { signal }) => new Promise((_resolve, reject) => {
    started(); signal.addEventListener('abort', () => { stopped = true; reject(new Error('TOKENIZER_ABORTED')); }, { once: true });
  }) };
  const { provider } = fixture({ tokenizer }); const controller = new AbortController();
  const pending = provider.evaluate({ ...request(), signal: controller.signal });
  await active;
  await assert.rejects(provider.evaluate(request()), { code: 'WRITING_FEEDBACK_BUSY' });
  controller.abort();
  await assert.rejects(pending, { code: 'WRITING_FEEDBACK_CANCELLED' });
  assert.equal(stopped, true); assert.equal(provider.busy, false);
});
