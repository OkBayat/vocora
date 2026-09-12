import assert from 'node:assert/strict';
import test from 'node:test';
import { createServer } from 'node:http';
import { once } from 'node:events';
import { createPrivateServiceFetch, privateServiceUrl } from '../src/infrastructure/ai/PrivateOllamaTransport.js';

test('private service URLs allow only the requested verified alias and private addresses', () => {
  assert.equal(privateServiceUrl('http://speech:8080', ['speech']).hostname, 'speech');
  assert.equal(privateServiceUrl('http://kokoro:8880', ['kokoro']).hostname, 'kokoro');
  for (const url of ['https://public.example', 'http://169.254.169.254', 'http://speech:8080/path',
    'http://user:secret@localhost', 'http://kokoro:8880']) {
    assert.throws(() => privateServiceUrl(url, ['speech']), { code: 'STRUCTURED_INFERENCE_CONFIGURATION' });
  }
});

test('private socket lookup rejects public or mixed DNS answers before connecting', async () => {
  for (const addresses of [[{ address: '203.0.113.1', family: 4 }],
    [{ address: '127.0.0.1', family: 4 }, { address: '203.0.113.1', family: 4 }]]) {
    let resolved = false;
    const fetch = createPrivateServiceFetch({ lookupImpl: (hostname, options, callback) => {
      assert.equal(hostname, 'speech'); assert.equal(options.all, true); resolved = true; callback(null, addresses);
    } });
    await assert.rejects(fetch('http://speech:8080/health'), { code: 'STRUCTURED_INFERENCE_PROVIDER_UNAVAILABLE' });
    assert.equal(resolved, true);
  }
});

test('private transport pins the socket DNS result, does not redirect and cancels an active body', async t => {
  let requested; let closed; const started = new Promise(resolve => { requested = resolve; });
  const disconnected = new Promise(resolve => { closed = resolve; });
  const server = createServer((req, res) => {
    if (req.url === '/redirect') { res.writeHead(302, { Location: 'https://public.example' }); res.end(); return; }
    res.writeHead(200, { 'Content-Type': 'application/octet-stream' }); res.write('audio');
    res.on('close', closed); requested();
  });
  server.listen(0, '127.0.0.1'); await once(server, 'listening');
  t.after(() => new Promise(resolve => server.close(resolve)));
  const fetch = createPrivateServiceFetch({ lookupImpl: (_hostname, _options, callback) => {
    callback(null, [{ address: '127.0.0.1', family: 4 }]);
  } });
  const base = `http://speech:${server.address().port}`;
  const redirect = await fetch(`${base}/redirect`);
  assert.equal(redirect.status, 302); await redirect.body.cancel();
  const controller = new AbortController(); const response = await fetch(`${base}/stream`, { signal: controller.signal });
  await started; const reading = response.text(); controller.abort();
  await assert.rejects(reading); await disconnected;
  await assert.rejects(fetch('http://203.0.113.1/'), { code: 'STRUCTURED_INFERENCE_CONFIGURATION' });
});
