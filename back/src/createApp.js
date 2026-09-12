import { existsSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import cookieParser from "cookie-parser";
import express from "express";
import helmet from "helmet";
import { createApiRouter } from "./interfaces/http/apiRouter.js";
import { createAuthMiddleware } from "./interfaces/http/authMiddleware.js";
import { createShadowingRouter } from "./interfaces/http/shadowingRouter.js";
import { createErrorHandler } from "./interfaces/http/errorHandler.js";
import { createCredentialedCors } from "./interfaces/http/corsMiddleware.js";

const currentDirectory = path.dirname(fileURLToPath(import.meta.url));
export const DEFAULT_STATIC_DIRECTORY = path.resolve(currentDirectory, "../../ui");

function setNoStoreHeaders(res) {
  res.setHeader("Cache-Control", "no-store, no-cache, must-revalidate, proxy-revalidate");
  res.setHeader("CDN-Cache-Control", "no-store");
  res.setHeader("Surrogate-Control", "no-store");
  res.setHeader("Pragma", "no-cache");
  res.setHeader("Expires", "0");
}

function setStaticCacheHeaders(res, filePath) {
  const extension = path.extname(filePath).toLowerCase();
  const filename = path.basename(filePath).toLowerCase();
  if (extension === ".html" || extension === ".css" || extension === ".js" || extension === ".webmanifest") {
    // A mixed frontend release is more damaging than the bandwidth saved by
    // caching executable assets. Keep browser/CDN behavior deterministic.
    setNoStoreHeaders(res);
  }
  if (filename === "service-worker.js") {
    res.setHeader("Service-Worker-Allowed", "/");
  }
  if (extension === ".webmanifest") {
    res.setHeader("Content-Type", "application/manifest+json; charset=utf-8");
  }
}

function isHtmlNavigationRequest(req) {
  if (req.method !== "GET") return false;
  const extension = path.extname(req.path).toLowerCase();
  if (extension && extension !== ".html") return false;
  return Boolean(req.accepts("html"));
}

function resolveSpaIndex(staticDirectory) {
  const candidates = [
    path.join(staticDirectory, "index.html"),
    // Angular source trees keep the HTML shell under src/. Production Docker
    // copies dist/browser into staticDirectory, so the first candidate wins in
    // production while tests/dev tooling can still exercise SPA fallback.
    path.join(staticDirectory, "src", "index.html")
  ];
  return candidates.find((candidate) => existsSync(candidate)) || null;
}

function installOriginTiming(req, res, next) {
  const startedAt = performance.now();
  const originalJson = res.json.bind(res);

  res.json = (payload) => {
    if (!res.headersSent) {
      const durationMs = Math.max(0, performance.now() - startedAt);
      const formattedDuration = durationMs.toFixed(1);
      const existingTiming = res.getHeader("Server-Timing");
      const vocoraTiming = `vocora;dur=${formattedDuration}`;
      res.setHeader(
        "Server-Timing",
        existingTiming ? `${existingTiming}, ${vocoraTiming}` : vocoraTiming
      );
      res.setHeader("X-Vocora-Origin-Ms", formattedDuration);
      res.setHeader("X-Vocora-Request-Bytes", req.get("content-length") || "0");
    }
    return originalJson(payload);
  };

  next();
}

export function createApp({
  container,
  staticDirectory = DEFAULT_STATIC_DIRECTORY,
  logger = console,
  nodeEnv = "development",
  trustProxy = false,
  corsAllowedOrigins = [],
  mobileReleases = {}
}) {
  const app = express();

  if (trustProxy) app.set("trust proxy", 1);
  app.disable("x-powered-by");
  app.use(createCredentialedCors({ allowedOrigins: corsAllowedOrigins }));
  app.use(installOriginTiming);
  app.use(
    helmet({
      contentSecurityPolicy: {
        directives: {
          "media-src": ["'self'", "blob:"],
          // The documented Docker deployment is HTTP on localhost. Browsers
          // (notably Safari) may otherwise rewrite it to unavailable HTTPS.
          "upgrade-insecure-requests": null
        }
      }
    })
  );
  const privateTextJson = express.json({ limit: "16kb", strict: true });
  const privateTextRoute = /^\/api\/(?:learning-paths\/[^/]+\/lessons\/[^/]+\/exercises\/[^/]+\/slides\/[^/]+\/(?:writing-feedback|conversation-sessions)(?:\/|$)|(?:writing-feedback|conversations)(?:\/|$))/iu;
  app.use((req, res, next) => privateTextRoute.test(req.path) ? privateTextJson(req, res, next) : next());
  app.use(express.json({ limit: "10mb", strict: true }));
  app.use(cookieParser());
  app.get('/api/mobile/releases/:platform', (req, res) => {
    const policy = mobileReleases[req.params.platform];
    if (!policy) {
      return res.status(404).json({ error: { code: 'PLATFORM_NOT_FOUND', message: 'Mobile platform was not found.' } });
    }
    return res.status(200).json(policy);
  });
  app.use("/api/shadowing", createShadowingRouter(container));

  if (container.writingFeedback) {
    const authenticate = createAuthMiddleware({
      tokenService: container.tokenService,
      getCurrentUser: container.useCases.getCurrentUser,
      cookieName: container.authCookie.name,
    });
    app.use("/api/learning-paths", container.writingFeedback.createTaskRouter({ authenticate }));
    app.use("/api/writing-feedback", container.writingFeedback.createJobRouter({ authenticate }));
  }

  if (container.adaptiveConversation) {
    const authenticate = createAuthMiddleware({ tokenService: container.tokenService, getCurrentUser: container.useCases.getCurrentUser, cookieName: container.authCookie.name });
    app.use("/api/learning-paths", container.adaptiveConversation.createTaskRouter({ authenticate }));
    app.use("/api/conversations", container.adaptiveConversation.createRouter({ authenticate }));
  }

  // Production containers always expose the Learning Path module through
  // createContainer(). Some focused HTTP unit tests intentionally supply a
  // smaller hand-built container; keep those adapters composable without
  // weakening production wiring.
  if (container.collectionLearningPath) {
    const authenticate = createAuthMiddleware({
      tokenService: container.tokenService,
      getCurrentUser: container.useCases.getCurrentUser,
      cookieName: container.authCookie.name
    });
    app.use(
      "/api/learning-paths",
      container.collectionLearningPath.createHttpRouter({
        authenticate,
        audioDirectory: container.listeningAudioDirectory,
      })
    );
  }

  app.use(
    "/api",
    createApiRouter({
      useCases: container.useCases,
      tokenService: container.tokenService,
      authCookie: container.authCookie,
      authRateLimit: container.authRateLimit,
      listeningAudioDirectory: container.listeningAudioDirectory,
      listeningEpisodesDirectory: container.listeningEpisodesDirectory
    })
  );

  app.use("/api", (_req, res) => {
    res.status(404).json({ error: { code: "NOT_FOUND", message: "API endpoint not found." } });
  });

  if (staticDirectory && existsSync(staticDirectory)) {
    const spaIndex = resolveSpaIndex(staticDirectory);
    app.use(express.static(staticDirectory, { index: "index.html", setHeaders: setStaticCacheHeaders }));
    if (spaIndex) {
      app.use((req, res, next) => {
        if (!isHtmlNavigationRequest(req)) return next();
        setNoStoreHeaders(res);
        res.sendFile(path.basename(spaIndex), { root: path.dirname(spaIndex) }, (error) => {
          if (error) next(error);
        });
      });
    }
  }

  app.use((_req, res) => {
    res.status(404).json({ error: { code: "NOT_FOUND", message: "Resource not found." } });
  });

  app.use(createErrorHandler({ logger, nodeEnv }));
  return app;
}
