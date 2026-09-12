import assert from "node:assert/strict";
import { describe, it } from "node:test";
import { ResolveWritingFeedbackTask } from "../src/application/writing-feedback/ResolveWritingFeedbackTask.js";

const NOW = "2026-09-12T12:00:00.000Z";
function harness({ access = true, started = true, type = "writing-response", published = true, configured = true, completed = false, repeatable = true } = {}) {
  const data = { mode: "paragraph", prompt: "Describe breakfast.", modelAnswer: "Private example, not an answer key.", writingFeedback: { schemaVersion: 1, learnerLevel: "A1", targetSkill: "Simple sentences", languageObjectives: ["Use I + verb"], taskExpectations: ["Describe your own breakfast"] } };
  if (!configured) delete data.writingFeedback;
  const path = { id: "path-1", collectionId: "collection-1", title: "Fixture", mode: "finite", status: published ? "published" : "draft", contentVersion: 7, lessons: [{ id: "lesson-1", position: 1, status: "published", exercises: [{ id: "exercise-1", position: 1, type: "slides.sequence", schemaVersion: 1, required: true, completionPolicy: "slide-sequence", status: "published", config: { repeatable, slides: [{ id: "writing-1", type, data }, { id: "summary", type: "summary", terminal: true, data: {} }] } }] }] };
  return new ResolveWritingFeedbackTask({
    definitionReader: { findByPublicId: async () => path },
    accessReader: { getForCollection: async () => ({ canRead: access, canProgress: access }) },
    progressReader: { findForPath: async () => ({ path: { status: "in_progress", revision: 1 }, lessons: [{ lessonId: "lesson-1", status: "in_progress" }], exercises: started ? [{ exerciseId: "exercise-1", status: completed ? "completed" : "in_progress", startedAt: NOW }] : [] }) },
    hashFactory: (value) => value,
  });
}
const resolve = (resolver) => resolver.execute("user-1", "path-1", "lesson-1", "exercise-1", "writing-1");

describe("Authoritative Writing task context", () => {
  it("resolves the exact started slide and excludes model answers from immutable provider context", async () => {
    const context = await resolve(harness());
    assert.equal(context.exerciseStartedAt, NOW);
    assert.equal(context.taskContext.prompt, "Describe breakfast.");
    assert.equal(context.taskContext.modelAnswer, undefined);
    assert.equal(context.contentVersion.includes('"pathVersion":7'), true);
  });
  it("permits history recovery after a nonrepeatable exercise completes while rejecting new writes", async () => {
    const resolver = harness({ completed: true, repeatable: false });
    await assert.rejects(resolve(resolver), { code: "LEARNING_PATH_EXERCISE_NOT_STARTED" });
    const context = await resolver.execute("user-1", "path-1", "lesson-1", "exercise-1", "writing-1", { forHistory: true });
    assert.equal(context.exerciseStartedAt, NOW);
  });
  it("rejects inaccessible, unstarted, retired and unsupported tasks", async () => {
    for (const options of [{ access: false }, { started: false }, { published: false }, { type: "teaching-card" }, { configured: false }]) await assert.rejects(resolve(harness(options)));
  });
});
