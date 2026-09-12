import assert from "node:assert/strict";
import { describe, it } from "node:test";
import { ResolveConversationTask } from "../src/application/adaptive-conversation/ResolveConversationTask.js";

const NOW = "2026-09-12T12:00:00.000Z";
function harness({ access = true, started = true, type = "adaptive-conversation", published = true, configured = true, completed = false, repeatable = true } = {}) {
  const data = { mode: "guided-dialogue", goal: "Discuss food.", openingPrompt: "What do you eat?", minimumTurns: 2, maximumTurns: 3, responseSeconds: 20, learnerLevel: "beginner", questionConstraints: { maximumWords: 14, oneQuestionOnly: true, avoidAnswerDisclosure: true } };
  if (!configured) delete data.goal;
  const path = { id: "path-1", collectionId: "collection-1", title: "Fixture", mode: "finite", status: published ? "published" : "draft", contentVersion: 7, lessons: [{ id: "lesson-1", position: 1, status: "published", exercises: [{ id: "exercise-1", position: 1, type: "slides.sequence", schemaVersion: 1, required: true, completionPolicy: "slide-sequence", status: "published", config: { repeatable, slides: [{ id: "conversation-1", type, data }, { id: "summary", type: "summary", terminal: true, data: {} }] } }] }] };
  return new ResolveConversationTask({
    definitionReader: { findByPublicId: async () => path },
    accessReader: { getForCollection: async () => ({ canRead: access, canProgress: access }) },
    progressReader: { findForPath: async () => ({ path: { status: "in_progress", revision: 1 }, lessons: [{ lessonId: "lesson-1", status: "in_progress" }], exercises: started ? [{ exerciseId: "exercise-1", status: completed ? "completed" : "in_progress", startedAt: NOW }] : [] }) },
    hashFactory: (value) => value,
  });
}
const resolve = (resolver) => resolver.execute("user-1", "path-1", "lesson-1", "exercise-1", "conversation-1");

describe("Authoritative Conversation task context", () => {
  it("resolves the exact started slide and excludes model answers from immutable provider context", async () => {
    const context = await resolve(harness());
    assert.equal(context.exerciseStartedAt, NOW);
    assert.equal(context.config.openingPrompt, "What do you eat?");
    assert.equal(context.config.modelAnswer, undefined);
    assert.equal(context.contentVersion.includes('"pathVersion":7'), true);
  });
  it("permits history recovery after a nonrepeatable exercise completes while rejecting new writes", async () => {
    const resolver = harness({ completed: true, repeatable: false });
    await assert.rejects(resolve(resolver), { code: "LEARNING_PATH_EXERCISE_NOT_STARTED" });
    const context = await resolver.execute("user-1", "path-1", "lesson-1", "exercise-1", "conversation-1", { forHistory: true });
    assert.equal(context.exerciseStartedAt, NOW);
  });
  it("rejects inaccessible, unstarted, retired and unsupported tasks", async () => {
    for (const options of [{ access: false }, { started: false }, { published: false }, { type: "teaching-card" }, { configured: false }]) await assert.rejects(resolve(harness(options)));
  });
});
