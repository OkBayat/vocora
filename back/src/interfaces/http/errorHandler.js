import { AppError } from "../../domain/errors.js";

function sendError(res, statusCode, code, message) {
  res.status(statusCode).json({ error: { code, message } });
}

export function createErrorHandler({ logger = console, nodeEnv = "development" } = {}) {
  return function errorHandler(error, _req, res, next) {
    if (res.headersSent) return next(error);

    if (error?.type === "entity.too.large") {
      sendError(res, 413, "PAYLOAD_TOO_LARGE", "Request payload is too large.");
      return;
    }

    if (error instanceof SyntaxError && error?.status === 400 && "body" in error) {
      sendError(res, 400, "INVALID_JSON", "Request body contains invalid JSON.");
      return;
    }

    if (error instanceof AppError) {
      sendError(res, error.statusCode, error.code, error.message);
      return;
    }

    logger.error?.("Unhandled request error", error);
    sendError(
      res,
      500,
      "INTERNAL_SERVER_ERROR",
      nodeEnv === "production" ? "An unexpected error occurred." : error?.message ?? "Unexpected error."
    );
  };
}
