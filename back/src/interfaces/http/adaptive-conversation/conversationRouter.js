import { Router, raw } from 'express';
import { pipeline } from 'node:stream/promises';
import { ValidationError } from '../../../domain/errors.js';
import { learningPathRouteId, lessonRouteId, exerciseRouteId } from '../../../application/collection-learning-path/learningPathSupport.js';

const TASK = '/:pathId/lessons/:lessonId/exercises/:exerciseId/slides/:slideId/conversation-sessions';
const noStore = (_req, res, next) => { res.set('Cache-Control', 'no-store'); next(); };
function empty(req) {
  if (req.body !== undefined && (!req.body || typeof req.body !== 'object' || Array.isArray(req.body) || Object.keys(req.body).length)) throw new ValidationError('CONVERSATION_INVALID_REQUEST', 'This action does not accept additional fields.');
}
const taskArguments = (req) => [req.auth.userId, learningPathRouteId(req.params.pathId), lessonRouteId(req.params.lessonId), exerciseRouteId(req.params.exerciseId), req.params.slideId];
export function createConversationTaskRouter({ sessions, authenticate }) {
  const router = Router();
  router.post(TASK, noStore, authenticate, async (req, res) => res.status(201).json(await sessions.start(...taskArguments(req), req.body)));
  router.get(TASK, noStore, authenticate, async (req, res) => res.json(await sessions.list(...taskArguments(req))));
  return router;
}
export function createConversationRouter({ sessions, recordings, audio, authenticate }) {
  const router = Router(); router.use(noStore, authenticate);
  router.get('/:sessionId', async (req, res) => res.json(await sessions.get(req.auth.userId, req.params.sessionId)));
  router.post('/:sessionId/recordings', async (req, res) => res.status(201).json(await recordings.start(req.auth.userId, req.params.sessionId, req.body)));
  router.post('/:sessionId/recordings/:recordingId/chunks', raw({ type: 'application/octet-stream', limit: 32000 }), async (req, res) => {
    if (Object.keys(req.query).some((key) => key !== 'sequence') || typeof req.query.sequence !== 'string' || !/^\d{1,4}$/u.test(req.query.sequence)) throw new ValidationError('CONVERSATION_INVALID_AUDIO', 'Audio sequence must be a nonnegative integer.');
    res.json(await recordings.chunk(req.auth.userId, req.params.sessionId, req.params.recordingId, Number(req.query.sequence), req.body));
  });
  router.post('/:sessionId/recordings/:recordingId/finish', async (req, res) => { empty(req); res.json(await recordings.finish(req.auth.userId, req.params.sessionId, req.params.recordingId)); });
  router.delete('/:sessionId/recordings/:recordingId', async (req, res) => { empty(req); await recordings.cancel(req.auth.userId, req.params.sessionId, req.params.recordingId); res.status(204).end(); });
  router.post('/:sessionId/turns/:turnId/retry', async (req, res) => { empty(req); res.json(await recordings.retry(req.auth.userId, req.params.sessionId, req.params.turnId)); });
  router.post('/:sessionId/turns/:turnId/question-audio', async (req, res) => {
    empty(req);
    const controller = new AbortController();
    const abort = () => { if (!res.writableFinished) controller.abort(); };
    req.once('aborted', abort); res.once('close', abort);
    try {
      const stream = await audio.generate(req.auth.userId, req.params.sessionId, req.params.turnId, { signal: controller.signal });
      res.type('audio/mpeg');
      await pipeline(stream, res, { signal: controller.signal });
    } finally { req.removeListener('aborted', abort); res.removeListener('close', abort); }
  });
  router.post('/:sessionId/finish', async (req, res) => res.json(await sessions.finish(req.auth.userId, req.params.sessionId, req.body)));
  router.post('/:sessionId/cancel', async (req, res) => { empty(req); res.json(await sessions.cancel(req.auth.userId, req.params.sessionId)); });
  router.delete('/:sessionId', async (req, res) => { empty(req); await sessions.delete(req.auth.userId, req.params.sessionId); res.status(204).end(); });
  return router;
}
