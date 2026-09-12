import assert from 'node:assert/strict';
import { it } from 'node:test';
import { HttpSpeechRecognizer } from '../src/infrastructure/speech/HttpSpeechRecognizer.js';

it('keeps provider credentials, raw errors and target text out of browser responses', async () => {
  const unavailable = new HttpSpeechRecognizer();
  await assert.rejects(unavailable.ready(), { code: 'SHADOWING_UNAVAILABLE', statusCode: 503 });
  const broken = new HttpSpeechRecognizer({ url: 'http://speech:8080', fetchImpl: async () => { throw new Error('private-provider-secret'); } });
  await assert.rejects(broken.finish('id'), error => error.statusCode === 503 && !error.message.includes('private-provider-secret'));
  await broken.cancel('id');
});

it('sends only bounded PCM and recording identity to the private speech protocol', async () => {
  const calls = [];
  const speech = new HttpSpeechRecognizer({ url: 'http://speech:8080/', fetchImpl: async (url, options) => {
    calls.push({ url, options });
    return Response.json({ text: 'my name is sara' });
  } });
  await speech.ready(); await speech.start('recording');
  const pcm = Buffer.alloc(16000);
  assert.equal(await speech.chunk('recording', 0, pcm), 'my name is sara');
  await speech.finish('recording'); await speech.cancel('recording');
  assert.deepEqual(calls.map(call => call.options.method), ['GET', 'PUT', 'POST', 'POST', 'DELETE']);
  assert.equal(calls[2].options.body, pcm);
  assert.equal(calls[2].url, 'http://speech:8080/sessions/recording/chunks?sequence=0');
  assert.ok(calls.every(call => call.options.signal instanceof AbortSignal && call.options.redirect === 'error'));
});

it('rejects malformed transcripts and non-HTTP configuration', async () => {
  assert.throws(() => new HttpSpeechRecognizer({ url: 'file:///etc/passwd' }));
  for (const text of [42, 'x'.repeat(8001)]) {
    const speech = new HttpSpeechRecognizer({ url: 'http://speech:8080', fetchImpl: async () => Response.json({ text }) });
    await assert.rejects(speech.finish('id'), { code: 'SHADOWING_UNAVAILABLE' });
  }
});

it('restricts adaptive conversation speech to the private service when opted in', async () => {
  for (const url of ['https://example.com', 'http://8.8.8.8', 'http://169.254.169.254',
    'http://user:secret@speech:8080', 'http://speech:8080/proxy', 'http://speech:8080?target=public']) {
    assert.throws(() => new HttpSpeechRecognizer({ url, privateOnly: true }), { code: 'SHADOWING_UNAVAILABLE' });
  }
  const speech = new HttpSpeechRecognizer({ url: 'http://speech:8080', privateOnly: true,
    fetchImpl: async () => Response.json({ text: 'hello' }) });
  assert.equal(await speech.finish('id'), 'hello');
  assert.doesNotThrow(() => new HttpSpeechRecognizer({ url: 'https://example.com' }));
});

const detailed = {
  schemaVersion: 1, status: 'transcribed', text: 'hello', confidence: null,
  wordEvidence: [{ word: 'hello', startSeconds: 0, endSeconds: 0.4, confidence: 0.82 }],
  providerIdentity: { provider: 'vosk', runtimeVersion: '0.3.45', modelId: null, modelDigest: null },
};

it('returns versioned recognition evidence and preserves the legacy text port', async () => {
  const speech = new HttpSpeechRecognizer({ url: 'http://speech:8080',
    fetchImpl: async (url) => Response.json({ ...detailed, status: url.includes('/chunks') ? 'partial' : 'transcribed' }) });
  assert.deepEqual(await speech.finishDetailed('id'), detailed);
  assert.equal((await speech.chunkDetailed('id', 0, Buffer.alloc(2))).status, 'partial');
  assert.equal(await speech.finish('id'), 'hello');
});

it('rejects invalid evidence and never upgrades a legacy text-only response to assessed evidence', async () => {
  for (const data of [
    { text: 'hello' }, { ...detailed, schemaVersion: 2 }, { ...detailed, confidence: 0.8 },
    { ...detailed, text: 'hello\u0000' }, { ...detailed, text: 'hello\ud800' },
    { ...detailed, status: 'transcribed', text: '' }, { ...detailed, secret: 'private prompt' },
    { ...detailed, wordEvidence: [{ ...detailed.wordEvidence[0], confidence: 1.1 }] },
    { ...detailed, wordEvidence: [{ ...detailed.wordEvidence[0], startSeconds: -1 }] },
    { ...detailed, wordEvidence: [{ ...detailed.wordEvidence[0], word: 'hello\n' }] },
    { ...detailed, wordEvidence: Array(501).fill(detailed.wordEvidence[0]) },
    { ...detailed, providerIdentity: { ...detailed.providerIdentity, modelDigest: 'invented' } },
    { ...detailed, providerIdentity: { ...detailed.providerIdentity, modelDigest: ['sha256:' + 'a'.repeat(64)] } },
    { ...detailed, providerIdentity: { ...detailed.providerIdentity, modelId: 'model\ud800' } },
  ]) {
    const speech = new HttpSpeechRecognizer({ url: 'http://speech:8080', fetchImpl: async () => Response.json(data) });
    await assert.rejects(speech.finishDetailed('id'), { code: 'SHADOWING_UNAVAILABLE' });
  }
});

it('bounds streamed JSON and cancels the provider body when the limit is exceeded', async () => {
  let cancelled = false;
  const speech = new HttpSpeechRecognizer({ url: 'http://speech:8080', fetchImpl: async () => new Response(new ReadableStream({
    pull(controller) { controller.enqueue(new TextEncoder().encode(' '.repeat(140000))); },
    cancel() { cancelled = true; },
  })) });
  await assert.rejects(speech.finishDetailed('id'), { code: 'SHADOWING_UNAVAILABLE' });
  assert.equal(cancelled, true);
});

it('propagates caller cancellation and never starts an already cancelled request', async () => {
  const controller = new AbortController();
  let called = 0;
  const speech = new HttpSpeechRecognizer({ url: 'http://speech:8080', privateOnly: true, fetchImpl: async (_url, { signal }) => {
    called += 1;
    return new Promise((_resolve, reject) => signal.addEventListener('abort', () => reject(signal.reason), { once: true }));
  } });
  const pending = speech.finishDetailed('id', { signal: controller.signal });
  controller.abort();
  await assert.rejects(pending, { code: 'SPEECH_CANCELLED' });
  await assert.rejects(speech.finishDetailed('id', { signal: controller.signal }), { code: 'SPEECH_CANCELLED' });
  assert.equal(called, 1);
});

it('cancels a stalled transcript response on timeout and hides malformed JSON', async () => {
  let cancelled = false;
  const stalled = new HttpSpeechRecognizer({ url: 'http://speech:8080', timeoutMs: 20,
    fetchImpl: async () => new Response(new ReadableStream({ cancel() { cancelled = true; } })) });
  const keepAlive = setTimeout(() => {}, 200);
  try {
    await assert.rejects(stalled.finishDetailed('id'), { code: 'SHADOWING_UNAVAILABLE' });
    assert.equal(cancelled, true);
  } finally { clearTimeout(keepAlive); }
  const malformed = new HttpSpeechRecognizer({ url: 'http://speech:8080',
    fetchImpl: async () => new Response('{private-transcript') });
  await assert.rejects(malformed.finishDetailed('id'), (error) =>
    error.code === 'SHADOWING_UNAVAILABLE' && !error.message.includes('private-transcript'));
});
