import { loadConversationConfig } from "./loadConversationConfig.js";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { ValidationError } from "../domain/errors.js";
import { loadWritingFeedbackConfig } from "./loadWritingFeedbackConfig.js";

const DEFAULT_LISTENING_AUDIO_DIRECTORY = fileURLToPath(
  new URL("../../data/listening/audio/", import.meta.url)
);
const DEFAULT_TTS_CACHE_DIRECTORY = fileURLToPath(
  new URL("../../data/tts-cache/", import.meta.url)
);
const DEFAULT_TTS_VOICES = ["af_bella", "af_heart", "af_sky", "bf_emma"];

function numberFromEnv(value, fallback, name) {
  const parsed = Number(value ?? fallback);
  if (!Number.isFinite(parsed) || parsed <= 0) {
    throw new ValidationError("INVALID_CONFIGURATION", `${name} must be a positive number.`);
  }
  return parsed;
}

function booleanFromEnv(value, fallback = false) {
  if (value === undefined) return fallback;
  return String(value).toLowerCase() === "true";
}

function emailListFromEnv(value) {
  return [...new Set(String(value || "")
    .split(",")
    .map((email) => email.trim().toLowerCase())
    .filter(Boolean))];
}

function originListFromEnv(value) {
  return [...new Set(String(value || '')
    .split(',')
    .map((origin) => origin.trim())
    .filter(Boolean)
    .map((origin) => {
      if (origin === 'capacitor://localhost') return origin;
      const normalized = origin.replace(/\/$/u, '');
      let parsed;
      try {
        parsed = new URL(normalized);
      } catch {
        throw new ValidationError('INVALID_CONFIGURATION', 'CORS_ALLOWED_ORIGINS must contain exact HTTPS or capacitor://localhost origins.');
      }
      if (parsed.protocol !== 'https:' || parsed.origin !== normalized || parsed.username || parsed.password || parsed.hostname.includes('*')) {
        throw new ValidationError('INVALID_CONFIGURATION', 'CORS_ALLOWED_ORIGINS must contain exact HTTPS or capacitor://localhost origins.');
      }
      return normalized;
    }))];
}

function compareSemanticVersions(left, right) {
  const leftParts = left.split('.').map(Number);
  const rightParts = right.split('.').map(Number);
  for (let index = 0; index < 3; index += 1) {
    if (leftParts[index] !== rightParts[index]) return leftParts[index] < rightParts[index] ? -1 : 1;
  }
  return 0;
}

function mobileReleaseFromEnv(env, platform) {
  const prefix = `MOBILE_${platform.toUpperCase()}_`;
  const latestVersion = env[`${prefix}LATEST_VERSION`]?.trim() || '';
  const minimumSupportedVersion = env[`${prefix}MINIMUM_SUPPORTED_VERSION`]?.trim() || '';
  const storeUrl = env[`${prefix}STORE_URL`]?.trim() || '';
  const values = [latestVersion, minimumSupportedVersion, storeUrl];
  if (values.every((value) => !value)) {
    return { enabled: false, platform, latestVersion: '', minimumSupportedVersion: '', storeUrl: '' };
  }
  if (values.some((value) => !value)) {
    throw new ValidationError('INVALID_CONFIGURATION', `${prefix}LATEST_VERSION, ${prefix}MINIMUM_SUPPORTED_VERSION, and ${prefix}STORE_URL must be configured together.`);
  }
  if (!/^\d+\.\d+\.\d+$/u.test(latestVersion) || !/^\d+\.\d+\.\d+$/u.test(minimumSupportedVersion)) {
    throw new ValidationError('INVALID_CONFIGURATION', `${prefix} versions must use MAJOR.MINOR.PATCH.`);
  }
  if (compareSemanticVersions(minimumSupportedVersion, latestVersion) > 0) {
    throw new ValidationError('INVALID_CONFIGURATION', `${prefix}MINIMUM_SUPPORTED_VERSION cannot exceed ${prefix}LATEST_VERSION.`);
  }
  if (!storeUrl.startsWith('https://')) {
    throw new ValidationError('INVALID_CONFIGURATION', `${prefix}STORE_URL must use HTTPS.`);
  }
  return { enabled: true, platform, latestVersion, minimumSupportedVersion, storeUrl };
}

function ttsVoiceListFromEnv(value) {
  const voices = [...new Set(String(value || DEFAULT_TTS_VOICES.join(","))
    .split(",")
    .map((voice) => voice.trim().toLowerCase())
    .filter(Boolean))];
  if (voices.length === 0) {
    throw new ValidationError("INVALID_CONFIGURATION", "TTS_ALLOWED_VOICES must not be empty.");
  }
  return voices;
}

export function loadConfig(env = process.env) {
  const nodeEnv = env.NODE_ENV ?? "development";
  const jwtSecret = env.JWT_SECRET ?? (nodeEnv === "test" ? "test-secret-at-least-thirty-two-characters" : null);

  if (!jwtSecret || (nodeEnv === "production" && jwtSecret.length < 32)) {
    throw new ValidationError(
      "INVALID_CONFIGURATION",
      "JWT_SECRET must contain at least 32 characters in production."
    );
  }

  const sameSite = (env.COOKIE_SAME_SITE ?? "lax").toLowerCase();
  if (!["lax", "strict", "none"].includes(sameSite)) {
    throw new ValidationError("INVALID_CONFIGURATION", "COOKIE_SAME_SITE is invalid.");
  }

  const cookieSecure = booleanFromEnv(env.COOKIE_SECURE, false);
  if (sameSite === "none" && !cookieSecure) {
    throw new ValidationError(
      "INVALID_CONFIGURATION",
      "COOKIE_SAME_SITE=None requires COOKIE_SECURE=true."
    );
  }

  const ttsAllowedVoices = ttsVoiceListFromEnv(env.TTS_ALLOWED_VOICES);
  const ttsDefaultVoice = (env.TTS_DEFAULT_VOICE || "af_heart").trim().toLowerCase();
  if (!ttsAllowedVoices.includes(ttsDefaultVoice)) {
    throw new ValidationError(
      "INVALID_CONFIGURATION",
      "TTS_DEFAULT_VOICE must be included in TTS_ALLOWED_VOICES."
    );
  }
  const ttsDefaultSpeed = numberFromEnv(env.TTS_DEFAULT_SPEED, 1, "TTS_DEFAULT_SPEED");
  if (ttsDefaultSpeed < 0.25 || ttsDefaultSpeed > 4) {
    throw new ValidationError("INVALID_CONFIGURATION", "TTS_DEFAULT_SPEED must be from 0.25 to 4.");
  }
  const ttsDefaultFormat = (env.TTS_DEFAULT_FORMAT || "mp3").trim().toLowerCase();
  if (!["flac", "mp3", "opus", "wav"].includes(ttsDefaultFormat)) {
    throw new ValidationError("INVALID_CONFIGURATION", "TTS_DEFAULT_FORMAT is not supported.");
  }
  const ttsMaxTextLength = numberFromEnv(env.TTS_MAX_TEXT_LENGTH, 5000, "TTS_MAX_TEXT_LENGTH");
  if (!Number.isSafeInteger(ttsMaxTextLength)) {
    throw new ValidationError("INVALID_CONFIGURATION", "TTS_MAX_TEXT_LENGTH must be an integer.");
  }
  const ttsProviderUrl = env.KOKORO_TTS_URL?.trim() || "";
  if (ttsProviderUrl && !/^https?:\/\//u.test(ttsProviderUrl)) {
    throw new ValidationError("INVALID_CONFIGURATION", "KOKORO_TTS_URL must be an HTTP(S) URL.");
  }

  const adaptiveConversation = loadConversationConfig(env);
  return {
    nodeEnv,
    port: numberFromEnv(env.PORT, 3000, "PORT"),
    trustProxy: booleanFromEnv(env.TRUST_PROXY),
    corsAllowedOrigins: originListFromEnv(env.CORS_ALLOWED_ORIGINS),
    mobileReleases: {
      android: mobileReleaseFromEnv(env, 'android'),
      ios: mobileReleaseFromEnv(env, 'ios')
    },
    writingFeedback: loadWritingFeedbackConfig(env, { requireProvider: adaptiveConversation.enabled }),
    adaptiveConversation,
    shadowing: { url: env.SHADOWING_SPEECH_URL?.trim() || "" },
    tts: {
      providerUrl: ttsProviderUrl,
      cacheDirectory: env.TTS_CACHE_DIRECTORY?.trim()
        ? path.resolve(env.TTS_CACHE_DIRECTORY.trim())
        : DEFAULT_TTS_CACHE_DIRECTORY,
      allowedVoices: ttsAllowedVoices,
      defaultVoice: ttsDefaultVoice,
      defaultSpeed: ttsDefaultSpeed,
      defaultFormat: ttsDefaultFormat,
      requestTimeoutMs: numberFromEnv(env.TTS_REQUEST_TIMEOUT_MS, 120_000, "TTS_REQUEST_TIMEOUT_MS"),
      maxTextLength: ttsMaxTextLength,
      model: env.KOKORO_TTS_MODEL?.trim() || "kokoro",
      modelVersion: env.TTS_MODEL_VERSION?.trim() || "kokoro-v1.0@kokoro-fastapi-v0.8.2"
    },
    database: {
      host: env.DB_HOST ?? "127.0.0.1",
      port: numberFromEnv(env.DB_PORT, 3306, "DB_PORT"),
      name: env.DB_NAME ?? "leitner",
      user: env.DB_USER ?? "leitner",
      password: env.DB_PASSWORD ?? "",
      connectionLimit: numberFromEnv(env.DB_CONNECTION_LIMIT, 10, "DB_CONNECTION_LIMIT")
    },
    auth: {
      jwtSecret,
      jwtExpiresIn: env.JWT_EXPIRES_IN ?? "7d",
      rateLimit: {
        windowMs: numberFromEnv(env.AUTH_RATE_LIMIT_WINDOW_MS, 900_000, "AUTH_RATE_LIMIT_WINDOW_MS"),
        max: numberFromEnv(env.AUTH_RATE_LIMIT_MAX, 10, "AUTH_RATE_LIMIT_MAX")
      },
      cookie: {
        name: env.AUTH_COOKIE_NAME ?? "leitner_session",
        options: {
          httpOnly: true,
          secure: cookieSecure,
          sameSite,
          maxAge: numberFromEnv(env.AUTH_COOKIE_MAX_AGE_MS, 604_800_000, "AUTH_COOKIE_MAX_AGE_MS"),
          path: "/"
        }
      }
    },
    library: {
      adminEmails: emailListFromEnv(env.LIBRARY_ADMIN_EMAILS)
    },
    listening: {
      episodesDirectory: env.LISTENING_EPISODES_DIRECTORY?.trim()
        ? path.resolve(env.LISTENING_EPISODES_DIRECTORY.trim())
        : fileURLToPath(new URL("../../data/listening/episodes/", import.meta.url)),
      audioDirectory: env.LISTENING_AUDIO_DIRECTORY
        ? path.resolve(env.LISTENING_AUDIO_DIRECTORY)
        : DEFAULT_LISTENING_AUDIO_DIRECTORY
    }
  };
}
