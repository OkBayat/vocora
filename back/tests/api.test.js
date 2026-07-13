import assert from "node:assert/strict";
import { describe, it } from "node:test";
import request from "supertest";
import { createTestContext } from "./helpers/fakes.js";

describe("HTTP API", () => {
  it("reports service health without authentication", async () => {
    const { app } = createTestContext();
    const response = await request(app).get("/api/health").expect(200, { status: "ok" });
    assert.doesNotMatch(
      response.headers["content-security-policy"],
      /upgrade-insecure-requests/
    );
  });

  it("registers, authenticates, reports the user, and logs out", async () => {
    const { app } = createTestContext();
    const agent = request.agent(app);

    const registration = await agent
      .post("/api/auth/register")
      .send({ email: " Learner@Example.com ", password: "password123" })
      .expect(201);

    assert.deepEqual(registration.body, {
      user: { id: "1", email: "learner@example.com" }
    });
    assert.equal(registration.headers["cache-control"], "no-store");
    assert.match(registration.headers["set-cookie"][0], /HttpOnly/);
    assert.match(registration.headers["set-cookie"][0], /SameSite=Lax/);

    await agent.get("/api/auth/me").expect(200, registration.body);
    await agent.post("/api/auth/logout").expect(204);
    await agent.get("/api/auth/me").expect(401, {
      error: { code: "AUTHENTICATION_REQUIRED", message: "Authentication is required." }
    });

    const login = await agent
      .post("/api/auth/login")
      .send({ email: "learner@example.com", password: "password123" })
      .expect(200);
    assert.deepEqual(login.body, registration.body);
  });

  it("rejects duplicates and incorrect credentials with the canonical error shape", async () => {
    const { app } = createTestContext();
    const agent = request.agent(app);

    await agent
      .post("/api/auth/register")
      .send({ email: "learner@example.com", password: "password123" })
      .expect(201);

    await request(app)
      .post("/api/auth/register")
      .send({ email: "LEARNER@EXAMPLE.COM", password: "password123" })
      .expect(409, {
        error: {
          code: "EMAIL_ALREADY_REGISTERED",
          message: "This email is already registered."
        }
      });

    await request(app)
      .post("/api/auth/login")
      .send({ email: "learner@example.com", password: "wrong-password" })
      .expect(401, {
        error: { code: "INVALID_CREDENTIALS", message: "Email or password is incorrect." }
      });
  });

  it("keeps each authenticated learner state isolated", async () => {
    const { app } = createTestContext();
    const first = request.agent(app);
    const second = request.agent(app);

    await first
      .post("/api/auth/register")
      .send({ email: "first@example.com", password: "password123" })
      .expect(201);
    await second
      .post("/api/auth/register")
      .send({ email: "second@example.com", password: "password123" })
      .expect(201);

    await first.get("/api/state").expect(200, { state: null, revision: 0 });

    const state = {
      version: 4,
      cards: [{ word: "Monday", box: 2, mistakes: 0 }],
      history: [{ date: "2026-07-12", correct: true }]
    };
    await first
      .put("/api/state")
      .send({ state, revision: 0 })
      .expect(200, { state, revision: 1 });
    await first.get("/api/state").expect(200, { state, revision: 1 });
    await second.get("/api/state").expect(200, { state: null, revision: 0 });

    await first
      .put("/api/state")
      .send({ state: { overwritten: true }, revision: 0 })
      .expect(409, {
        error: {
          code: "STATE_CONFLICT",
          message: "Learning state was updated by another session. Reload and try again."
        }
      });
    await first.get("/api/state").expect(200, { state, revision: 1 });
  });

  it("requires authentication and validates the state envelope", async () => {
    const { app } = createTestContext();

    await request(app).get("/api/state").expect(401);

    const agent = request.agent(app);
    await agent
      .post("/api/auth/register")
      .send({ email: "learner@example.com", password: "password123" })
      .expect(201);
    await agent.put("/api/state").send({ state: [], revision: 0 }).expect(400, {
      error: { code: "INVALID_STATE", message: "State must be a JSON object." }
    });
    await agent.put("/api/state").send({ state: {} }).expect(400, {
      error: {
        code: "INVALID_REVISION",
        message: "Revision must be a non-negative safe integer."
      }
    });
  });

  it("rate limits repeated authentication attempts with the canonical error shape", async () => {
    const { app } = createTestContext({
      AUTH_RATE_LIMIT_MAX: "2",
      AUTH_RATE_LIMIT_WINDOW_MS: "60000"
    });

    const attempt = () =>
      request(app)
        .post("/api/auth/login")
        .send({ email: "missing@example.com", password: "password123" });

    await attempt().expect(401);
    await attempt().expect(401);
    await attempt().expect(429, {
      error: {
        code: "AUTH_RATE_LIMITED",
        message: "Too many authentication attempts. Try again later."
      }
    });
  });

  it("returns structured errors for malformed JSON and unknown API paths", async () => {
    const { app } = createTestContext();

    await request(app)
      .post("/api/auth/login")
      .set("Content-Type", "application/json")
      .send('{"email":')
      .expect(400, {
        error: { code: "INVALID_JSON", message: "Request body contains invalid JSON." }
      });

    await request(app).get("/api/does-not-exist").expect(404, {
      error: { code: "NOT_FOUND", message: "API endpoint not found." }
    });
  });
});
