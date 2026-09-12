import assert from "node:assert/strict";
import { describe, it } from "node:test";
import express from "express";
import request from "supertest";
import { createWritingFeedbackTaskRouter, createWritingFeedbackJobRouter } from "../src/interfaces/http/writing-feedback/writingFeedbackRouter.js";
import { createErrorHandler } from "../src/interfaces/http/errorHandler.js";
import { ForbiddenError } from "../src/domain/errors.js";

function harness({ authenticated = true, serviceOverride = {} } = {}) {
  const calls = [];
  const service = Object.fromEntries(["submit", "list", "get", "retry", "cancel", "delete"].map((method) => [method, async (...args) => { calls.push([method, ...args]); return { submission: { id: "submission-1", status: "unavailable", draftText: "I eat bread." } }; }]));
  Object.assign(service, serviceOverride);
  const authenticate = (req, res, next) => { if (!authenticated) return res.status(401).json({ error: { code: "AUTHENTICATION_REQUIRED" } }); req.auth = { userId: "owner-1" }; next(); };
  const app = express();
  app.use(express.json({ limit: "16kb" }));
  app.use("/api/learning-paths", createWritingFeedbackTaskRouter({ service, authenticate }));
  app.use("/api/writing-feedback", createWritingFeedbackJobRouter({ service, authenticate }));
  app.use(createErrorHandler());
  return { app, calls };
}
const taskPath = "/api/learning-paths/1/lessons/2/exercises/3/slides/writing-1/writing-feedback";
describe("Writing feedback HTTP contract", () => {
  it("uses the authenticated owner and exact route ids with a private response", async () => {
    const { app, calls } = harness();
    const payload = { draftText: "I eat bread.", idempotencyKey: "request-key-1" };
    const response = await request(app).post(taskPath).send(payload).expect(201);
    assert.equal(response.headers["cache-control"], "no-store");
    assert.deepEqual(calls[0], ["submit", "owner-1", "1", "2", "3", "writing-1", payload]);
    assert.equal(response.body.submission.status, "unavailable");
  });
  it("requires authentication on save, reload, poll, retry, cancel and delete", async () => {
    const { app, calls } = harness({ authenticated: false });
    await request(app).post(taskPath).send({}).expect(401);
    await request(app).get(taskPath).expect(401);
    for (const [method, route] of [["get", "/submission-1"], ["post", "/submission-1/retry"], ["post", "/submission-1/cancel"], ["delete", "/submission-1"]]) await request(app)[method](`/api/writing-feedback${route}`).expect(401);
    assert.equal(calls.length, 0);
  });
  it("rejects extra action fields and applies existing error envelopes", async () => {
    const { app } = harness({ serviceOverride: { get: async () => { throw new ForbiddenError(); } } });
    await request(app).post("/api/writing-feedback/submission-1/retry").send({ model: "injected" }).expect(400);
    const response = await request(app).get("/api/writing-feedback/submission-1").expect(403);
    assert.equal(response.body.error.code, "FORBIDDEN");
  });
  it("supports private poll/reload/cancel/delete without alternate scoring routes", async () => {
    const { app, calls } = harness();
    await request(app).get(taskPath).expect(200);
    await request(app).get("/api/writing-feedback/submission-1").expect(200);
    await request(app).post("/api/writing-feedback/submission-1/retry").send({}).expect(200);
    await request(app).post("/api/writing-feedback/submission-1/cancel").send({}).expect(200);
    await request(app).delete("/api/writing-feedback/submission-1").expect(204);
    assert.deepEqual(calls.map((call) => call[0]), ["list", "get", "retry", "cancel", "delete"]);
    assert.ok(calls.every((call) => call[1] === "owner-1"));
  });
  it("bounds the transport body before application calls", async () => {
    const { app, calls } = harness();
    await request(app).post(taskPath).send({ draftText: "x".repeat(17_000) }).expect(413);
    assert.equal(calls.length, 0);
  });
});
