import { ValidationError } from "../domain/errors.js";

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

  return {
    nodeEnv,
    port: numberFromEnv(env.PORT, 3000, "PORT"),
    trustProxy: booleanFromEnv(env.TRUST_PROXY),
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
    }
  };
}
