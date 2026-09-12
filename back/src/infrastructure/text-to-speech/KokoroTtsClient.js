import { Readable } from "node:stream";

import { AppError } from "../../domain/errors.js";
import { TTS_LANGUAGE_CODES } from "../../domain/text-to-speech/TtsRequest.js";
import { privateServiceFetch, privateServiceUrl } from "../ai/PrivateOllamaTransport.js";

const MAX_AUDIO_BYTES = 64 * 1024 * 1024;

function providerError(error, signal) {
  if (signal?.aborted) return new AppError(499, "TTS_CANCELLED", "Speech generation was cancelled.");
  if (error instanceof AppError) return error;
  if (error?.name === "TimeoutError" || error?.name === "AbortError") {
    return new AppError(504, "TTS_PROVIDER_TIMEOUT", "Speech generation timed out. Please try again.");
  }
  return new AppError(503, "TTS_PROVIDER_UNAVAILABLE", "Speech generation is temporarily unavailable.");
}

export class KokoroTtsClient {
  constructor({ baseUrl = "", timeoutMs = 120000, fetchImpl, privateOnly = false } = {}) {
    this.baseUrl = baseUrl.replace(/\/+$/u, "");
    this.timeoutMs = timeoutMs;
    this.fetch = fetchImpl ?? (privateOnly ? privateServiceFetch : globalThis.fetch);
    if (privateOnly && this.baseUrl) {
      try { this.baseUrl = privateServiceUrl(this.baseUrl, ["kokoro"]).origin; }
      catch { throw providerError(); }
    }
    if (this.baseUrl && !/^https?:\/\//u.test(this.baseUrl)) {
      throw new Error("KOKORO_TTS_URL must be an HTTP(S) URL.");
    }
    if (!Number.isSafeInteger(timeoutMs) || timeoutMs < 1 || timeoutMs > 600000) {
      throw new Error("Speech generation timeout is invalid.");
    }
  }

  async generate(request, { signal, maxAudioBytes = MAX_AUDIO_BYTES } = {}) {
    if (signal?.aborted) throw providerError(null, signal);
    if (!Number.isSafeInteger(maxAudioBytes) || maxAudioBytes < 1 || maxAudioBytes > MAX_AUDIO_BYTES) {
      throw new AppError(400, "INVALID_TTS_AUDIO_LIMIT", "The audio size limit is invalid.");
    }
    if (!this.baseUrl) {
      throw new AppError(503, "TTS_PROVIDER_UNAVAILABLE", "Speech generation is not configured.");
    }

    const payload = {
      model: request.model,
      input: request.text,
      voice: request.voice,
      speed: request.speed,
      response_format: request.format,
      stream: true,
      normalization_options: { normalize: false },
      ...(request.language === "auto" ? {} : { lang_code: TTS_LANGUAGE_CODES[request.language] })
    };

    let response;
    const timeoutSignal = AbortSignal.timeout(this.timeoutMs);
    const operationSignal = signal ? AbortSignal.any([signal, timeoutSignal]) : timeoutSignal;
    try {
      response = await this.fetch(`${this.baseUrl}/v1/audio/speech`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify(payload),
        redirect: "error",
        signal: operationSignal
      });
    } catch (error) {
      throw providerError(error, signal);
    }

    if (!response.ok || !response.body) {
      response.body?.cancel().catch(() => {});
      throw new AppError(502, "TTS_GENERATION_FAILED", "The speech service could not generate audio.");
    }

    if (signal?.aborted) {
      response.body.cancel().catch(() => {});
      throw providerError(null, signal);
    }
    const declared = response.headers.get("content-length");
    if (declared !== null && (!/^\d+$/u.test(declared) || Number(declared) > maxAudioBytes)) {
      response.body.cancel().catch(() => {});
      throw new AppError(502, "TTS_AUDIO_TOO_LARGE", "The speech service returned too much audio.");
    }
    const providerStream = Readable.fromWeb(response.body, { signal: operationSignal });
    // Cancellation can arrive before the returned stream's consumer starts reading.
    // The iterator still observes the stored error; this prevents an unhandled event.
    providerStream.on("error", () => {});
    const audio = Readable.from((async function* safeProviderStream() {
      let bytes = 0;
      try {
        for await (const chunk of providerStream) {
          bytes += chunk.length;
          if (bytes > maxAudioBytes) {
            throw new AppError(502, "TTS_AUDIO_TOO_LARGE", "The speech service returned too much audio.");
          }
          yield chunk;
        }
        if (!bytes) throw new AppError(502, "TTS_GENERATION_FAILED", "The speech service returned empty audio.");
      } catch (error) {
        throw providerError(error, signal);
      } finally {
        providerStream.destroy();
      }
    })(), { objectMode: false });
    audio.once("close", () => providerStream.destroy());
    return audio;
  }
}
