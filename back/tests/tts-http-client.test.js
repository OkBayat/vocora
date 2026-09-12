import assert from "node:assert/strict";
import { Readable } from "node:stream";
import { describe, it } from "node:test";

import { KokoroTtsClient } from "../src/infrastructure/text-to-speech/KokoroTtsClient.js";

const request = {
  text: "Hello.",
  voice: "af_heart",
  speed: 1,
  language: "auto",
  model: "kokoro",
  format: "mp3"
};

describe("KokoroTtsClient", () => {
  it("restricts adaptive conversation audio to the private service when opted in", async () => {
    for (const baseUrl of ["https://example.com", "http://8.8.8.8", "http://169.254.169.254",
      "http://user:secret@kokoro:8880", "http://kokoro:8880/proxy", "http://kokoro:8880?target=public"]) {
      assert.throws(() => new KokoroTtsClient({ baseUrl, privateOnly: true }), { code: "TTS_PROVIDER_UNAVAILABLE" });
    }
    const client = new KokoroTtsClient({ baseUrl: "http://kokoro:8880", privateOnly: true,
      fetchImpl: async () => new Response("audio") });
    assert.equal((await (await client.generate(request)).toArray()).join(""), "audio");
    assert.doesNotThrow(() => new KokoroTtsClient({ baseUrl: "https://example.com" }));
  });

  it("uses the private OpenAI-compatible speech contract without forwarding internal errors", async () => {
    const calls = [];
    const client = new KokoroTtsClient({
      baseUrl: "http://kokoro:8880",
      timeoutMs: 1000,
      fetchImpl: async (url, options) => {
        calls.push({ url, options });
        return new Response(Readable.toWeb(Readable.from([Buffer.from("audio")])), { status: 200 });
      }
    });
    const audio = await client.generate(request);
    assert.equal((await audio.toArray()).join(""), "audio");
    assert.equal(calls[0].url, "http://kokoro:8880/v1/audio/speech");
    assert.deepEqual(JSON.parse(calls[0].options.body), {
      model: "kokoro",
      input: "Hello.",
      voice: "af_heart",
      speed: 1,
      response_format: "mp3",
      stream: true,
      normalization_options: { normalize: false }
    });
    assert.equal(calls[0].options.redirect, "error");
  });

  it("maps timeout, unavailable, and failed generation to safe application errors", async () => {
    const timeout = new KokoroTtsClient({
      baseUrl: "http://kokoro:8880",
      timeoutMs: 1000,
      fetchImpl: async () => { throw new DOMException("secret", "TimeoutError"); }
    });
    await assert.rejects(timeout.generate(request), { code: "TTS_PROVIDER_TIMEOUT", statusCode: 504 });

    const unavailable = new KokoroTtsClient({
      baseUrl: "http://kokoro:8880",
      timeoutMs: 1000,
      fetchImpl: async () => { throw new TypeError("private network address"); }
    });
    await assert.rejects(unavailable.generate(request), { code: "TTS_PROVIDER_UNAVAILABLE", statusCode: 503 });

    const failed = new KokoroTtsClient({
      baseUrl: "http://kokoro:8880",
      timeoutMs: 1000,
      fetchImpl: async () => new Response("private provider trace", { status: 500 })
    });
    await assert.rejects(failed.generate(request), (error) =>
      error.code === "TTS_GENERATION_FAILED" && !error.message.includes("private provider trace"));
  });

  it("maps the public language name to Kokoro's language code", async () => {
    let body;
    const client = new KokoroTtsClient({
      baseUrl: "http://kokoro:8880",
      timeoutMs: 1000,
      fetchImpl: async (_url, options) => {
        body = JSON.parse(options.body);
        return new Response(Readable.toWeb(Readable.from([Buffer.from("audio")])), { status: 200 });
      }
    });
    await client.generate({ ...request, language: "en-gb" });
    assert.equal(body.lang_code, "b");
  });

  it("cancels an uncached audio stream and prevents an already aborted generation", { timeout: 2000 }, async () => {
    let called = 0;
    let cancelled = false;
    const controller = new AbortController();
    const client = new KokoroTtsClient({ baseUrl: "http://kokoro:8880", timeoutMs: 1000, privateOnly: true,
      fetchImpl: async () => {
        called += 1;
        return new Response(new ReadableStream({ cancel() { cancelled = true; } }));
      } });
    const audio = await client.generate(request, { signal: controller.signal });
    const reading = audio.toArray();
    controller.abort();
    await assert.rejects(reading, { code: "TTS_CANCELLED" });
    assert.equal(cancelled, true);
    await assert.rejects(client.generate(request, { signal: controller.signal }), { code: "TTS_CANCELLED" });
    assert.equal(called, 1);
  });

  it("limits uncached streaming bytes and rejects empty audio", async () => {
    let cancelled = false;
    const oversized = new KokoroTtsClient({ baseUrl: "http://kokoro:8880", timeoutMs: 1000,
      fetchImpl: async () => new Response(new ReadableStream({
        pull(controller) { controller.enqueue(new Uint8Array(5)); },
        cancel() { cancelled = true; },
      })) });
    const audio = await oversized.generate(request, { maxAudioBytes: 4 });
    await assert.rejects(audio.toArray(), { code: "TTS_AUDIO_TOO_LARGE" });
    assert.equal(cancelled, true);
    const empty = new KokoroTtsClient({ baseUrl: "http://kokoro:8880", timeoutMs: 1000,
      fetchImpl: async () => new Response(new ReadableStream({ start(controller) { controller.close(); } })) });
    const emptyAudio = await empty.generate(request);
    await assert.rejects(emptyAudio.toArray(), { code: "TTS_GENERATION_FAILED" });
  });

  it("releases upstream audio when the consumer closes before reading", async () => {
    let cancelled = false;
    const client = new KokoroTtsClient({ baseUrl: "http://kokoro:8880", timeoutMs: 1000,
      fetchImpl: async () => new Response(new ReadableStream({ cancel() { cancelled = true; } })) });
    const audio = await client.generate(request);
    await new Promise((resolve) => { audio.once("close", resolve); audio.destroy(); });
    await new Promise((resolve) => setImmediate(resolve));
    assert.equal(cancelled, true);
  });

  it("keeps the timeout active during a stalled audio body", async () => {
    let cancelled = false;
    const client = new KokoroTtsClient({ baseUrl: "http://kokoro:8880", timeoutMs: 20,
      fetchImpl: async () => new Response(new ReadableStream({ cancel() { cancelled = true; } })) });
    const audio = await client.generate(request);
    const keepAlive = setTimeout(() => {}, 200);
    try {
      await assert.rejects(audio.toArray(), { code: "TTS_PROVIDER_TIMEOUT" });
      assert.equal(cancelled, true);
    } finally { clearTimeout(keepAlive); }
  });
});
