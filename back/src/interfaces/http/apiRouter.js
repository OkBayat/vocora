import { Router } from "express";
import { rateLimit } from "express-rate-limit";
import { createAuthMiddleware } from "./authMiddleware.js";

function cookieClearOptions(options) {
  const { maxAge: _maxAge, expires: _expires, ...clearOptions } = options;
  return clearOptions;
}

function createAuthRateLimiter(options) {
  return rateLimit({
    windowMs: options.windowMs,
    limit: options.max,
    standardHeaders: "draft-8",
    legacyHeaders: false,
    handler: (_req, res) => {
      res.status(429).json({
        error: {
          code: "AUTH_RATE_LIMITED",
          message: "Too many authentication attempts. Try again later."
        }
      });
    }
  });
}

export function createApiRouter({ useCases, tokenService, authCookie, authRateLimit }) {
  const router = Router();
  const authLimiter = createAuthRateLimiter(authRateLimit);
  const authenticate = createAuthMiddleware({
    tokenService,
    getCurrentUser: useCases.getCurrentUser,
    cookieName: authCookie.name
  });

  router.use((req, res, next) => {
    if (req.path !== "/health") res.set("Cache-Control", "no-store");
    next();
  });

  router.get("/health", (_req, res) => {
    res.status(200).json({ status: "ok" });
  });

  router.post("/auth/register", authLimiter, async (req, res) => {
    const { email, password } = req.body ?? {};
    const user = await useCases.registerUser.execute({ email, password });
    const token = tokenService.issue(user.id);
    res.cookie(authCookie.name, token, authCookie.options);
    res.status(201).json({ user });
  });

  router.post("/auth/login", authLimiter, async (req, res) => {
    const { email, password } = req.body ?? {};
    const user = await useCases.loginUser.execute({ email, password });
    const token = tokenService.issue(user.id);
    res.cookie(authCookie.name, token, authCookie.options);
    res.status(200).json({ user });
  });

  router.post("/auth/logout", (_req, res) => {
    res.clearCookie(authCookie.name, cookieClearOptions(authCookie.options));
    res.status(204).end();
  });

  router.get("/auth/me", authenticate, (req, res) => {
    res.status(200).json({ user: req.auth.user });
  });

  router.get("/state", authenticate, async (req, res) => {
    const result = await useCases.getLearningState.execute(req.auth.userId);
    res.status(200).json(result);
  });

  router.put("/state", authenticate, async (req, res) => {
    const result = await useCases.saveLearningState.execute(
      req.auth.userId,
      req.body?.state,
      req.body?.revision
    );
    res.status(200).json(result);
  });

  return router;
}
