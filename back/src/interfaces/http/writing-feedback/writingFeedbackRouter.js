import { Router } from "express";
import { ValidationError } from "../../../domain/errors.js";
import { learningPathRouteId, lessonRouteId, exerciseRouteId } from "../../../application/collection-learning-path/learningPathSupport.js";

const TASK_ROUTE = "/:pathId/lessons/:lessonId/exercises/:exerciseId/slides/:slideId/writing-feedback";

function noStore(_req, res, next) { res.set("Cache-Control", "no-store"); next(); }

function privateRouter(authenticate) {
  const router = Router();
  router.use(noStore);
  router.use(authenticate);
  return router;
}

function taskArguments(req) {
  return [req.auth.userId, learningPathRouteId(req.params.pathId), lessonRouteId(req.params.lessonId), exerciseRouteId(req.params.exerciseId), req.params.slideId];
}

function requireEmptyActionBody(req) {
  if (req.body !== undefined && (!req.body || typeof req.body !== "object" || Array.isArray(req.body) || Object.keys(req.body).length !== 0)) {
    throw new ValidationError("INVALID_WRITING_FEEDBACK_REQUEST", "This action does not accept additional fields.");
  }
}

export function createWritingFeedbackTaskRouter({ service, authenticate }) {
  const router = Router();
  router.post(TASK_ROUTE, noStore, authenticate, async (req, res) => {
    res.status(201).json(await service.submit(...taskArguments(req), req.body));
  });
  router.get(TASK_ROUTE, noStore, authenticate, async (req, res) => {
    res.status(200).json(await service.list(...taskArguments(req)));
  });
  return router;
}

export function createWritingFeedbackJobRouter({ service, authenticate }) {
  const router = privateRouter(authenticate);
  router.get("/:submissionId", async (req, res) => {
    res.status(200).json(await service.get(req.auth.userId, req.params.submissionId));
  });
  router.post("/:submissionId/retry", async (req, res) => {
    requireEmptyActionBody(req);
    res.status(200).json(await service.retry(req.auth.userId, req.params.submissionId));
  });
  router.post("/:submissionId/cancel", async (req, res) => {
    requireEmptyActionBody(req);
    res.status(200).json(await service.cancel(req.auth.userId, req.params.submissionId));
  });
  router.delete("/:submissionId", async (req, res) => {
    requireEmptyActionBody(req);
    await service.delete(req.auth.userId, req.params.submissionId);
    res.status(204).end();
  });
  return router;
}
