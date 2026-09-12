import assert from "node:assert/strict";
import { describe, it } from "node:test";
import request from "supertest";
import { createApp } from "../src/createApp.js";
import { createWritingFeedbackModule } from "../src/modules/writing-feedback/createWritingFeedbackModule.js";
import { createTestContext } from "./helpers/fakes.js";

const NOW = "2026-09-12T12:00:00.000Z";
const taskPath = "/api/learning-paths/1/lessons/2/exercises/3/slides/writing-1/writing-feedback";
function harness(enabled) {
  const records = new Map();
  const profile = { model: "pinned-model", modelDigest: "sha256:" + "a".repeat(64) };
  let evaluations = 0;
  const repository = {
    async enqueue(record) { records.set(record.id, structuredClone(record)); return record; },
    async findOwned(userId, id) { const record = records.get(id); return record?.userId === userId ? record : null; },
    async listOwned(userId) { return [...records.values()].filter((r) => r.userId === userId); },
    async purgeExpired() {},
    async claim({ leaseToken }) { const record = [...records.values()].find((r) => r.status === "queued"); if (!record) return null; record.status = "running"; record.leaseToken = leaseToken; return structuredClone(record); },
    async finish({ id, leaseToken, ...outcome }) { const record = records.get(id); if (record?.leaseToken !== leaseToken) return false; Object.assign(record, outcome, { updatedAt: NOW }); return true; },
  };
  const { container } = createTestContext();
  const module = createWritingFeedbackModule({
    pool: { getConnection: () => { throw new Error("A fixture must not access MySQL."); } },
    config: { enabled, timeoutMs: 1000, retentionDays: 30 },
    adapters: {
      writingFeedbackRepository: repository,
      writingFeedbackClock: () => new Date(NOW),
      writingFeedbackTaskResolver: { execute: async () => ({ pathId: "p", lessonId: "l", exerciseId: "e", slideId: "writing-1", exerciseStartedAt: NOW, contentVersion: "version-1", pathContentVersion: 7, taskContext: { prompt: "Describe breakfast.", mode: "paragraph" } }) },
      writingFeedbackProvider: {
        getIdentity: () => { if (!enabled) throw new Error("Disabled feedback must not inspect a provider."); return profile; },
        evaluate: async ({ draftText, taskContext }) => { evaluations++; assert.equal(draftText, "I eat bread."); assert.equal(taskContext.prompt, "Describe breakfast."); return { result: { schema_version: 1, assessment_status: "feedback_available", issues: [], ielts_band: null }, identity: profile, metrics: {} }; },
      },
    },
  });
  const app = createApp({ container: { ...container, writingFeedback: module }, staticDirectory: null });
  return { app, module, records, evaluations: () => evaluations };
}
async function authenticatedAgent(app, email = "writer@example.com") {
  const agent = request.agent(app);
  await agent.post("/api/auth/register").send({ email, password: "password123" }).expect(201);
  return agent;
}

describe("Writing feedback production composition", () => {
  it("saves and reloads an owned draft with feedback disabled and no provider assets", async () => {
    const { app, module, records, evaluations } = harness(false);
    const agent = await authenticatedAgent(app);
    const saved = await agent.post(taskPath).send({ draftText: "I eat bread.", notes: "meal", idempotencyKey: "save-request-1", expectedPathContentVersion: 7 }).expect(201);
    assert.equal(saved.body.submission.status, "unavailable");
    assert.equal(saved.body.submission.notes, "meal");
    assert.match(records.get(saved.body.submission.id).requestHash, /^[a-f0-9]{64}$/u);
    await module.worker.runOnce();
    assert.equal(evaluations(), 0);
    const reloaded = await agent.get(taskPath).expect(200);
    assert.equal(reloaded.body.availability.enabled, false);
    assert.equal(reloaded.body.submissions[0].id, saved.body.submission.id);
    const other = await authenticatedAgent(app, "other@example.com");
    await other.get(`/api/writing-feedback/${saved.body.submission.id}`).expect(404);
  });
  it("persists first, evaluates through one worker, and exposes feedback without a learner grade", async () => {
    const { app, module, evaluations } = harness(true);
    const agent = await authenticatedAgent(app);
    const saved = await agent.post(taskPath).send({ draftText: "I eat bread.", idempotencyKey: "save-request-1", expectedPathContentVersion: 7 }).expect(201);
    assert.equal(saved.body.submission.status, "queued");
    assert.equal(evaluations(), 0);
    await module.worker.runOnce();
    const polled = await agent.get(`/api/writing-feedback/${saved.body.submission.id}`).expect(200);
    assert.equal(polled.body.submission.status, "completed");
    assert.equal(polled.body.submission.feedback.ielts_band, null);
    assert.equal(polled.body.submission.passed, undefined);
    assert.equal(polled.body.submission.score, undefined);
    assert.equal(polled.body.submission.draftText, "I eat bread.");
    assert.equal(evaluations(), 1);
  });
  it("applies the narrow body limit in the composed application before the general JSON parser", async () => {
    const { app, records } = harness(false);
    const agent = await authenticatedAgent(app);
    await agent.post(taskPath).send({ draftText: "x".repeat(17000), idempotencyKey: "save-request-1", expectedPathContentVersion: 7 }).expect(413);
    await agent.post(taskPath.toUpperCase()).send({ draftText: "x".repeat(17000), idempotencyKey: "save-request-2", expectedPathContentVersion: 7 }).expect(413);
    assert.equal(records.size, 0);
    await request(app).get("/api/health").expect(200, { status: "ok" });
  });
});
