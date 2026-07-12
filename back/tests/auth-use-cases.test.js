import assert from "node:assert/strict";
import { describe, it } from "node:test";
import { LoginUser } from "../src/application/auth/LoginUser.js";
import { RegisterUser } from "../src/application/auth/RegisterUser.js";
import { SaveLearningState } from "../src/application/learning/SaveLearningState.js";
import { loadConfig } from "../src/config/loadConfig.js";
import { LearningState, MAX_SERIALIZED_STATE_BYTES } from "../src/domain/learning/LearningState.js";
import { BcryptPasswordHasher } from "../src/infrastructure/security/BcryptPasswordHasher.js";
import {
  FakePasswordHasher,
  InMemoryLearningStateRepository,
  InMemoryUserRepository
} from "./helpers/fakes.js";

describe("RegisterUser", () => {
  it("normalizes an email and stores only its password hash", async () => {
    const repository = new InMemoryUserRepository();
    const register = new RegisterUser({
      userRepository: repository,
      passwordHasher: new FakePasswordHasher()
    });

    const result = await register.execute({ email: "  Learner@Example.COM ", password: "password123" });
    const stored = await repository.findByEmail("learner@example.com");

    assert.deepEqual(result, { id: "1", email: "learner@example.com" });
    assert.equal(stored.passwordHash, "hashed:password123");
    assert.equal("password" in result, false);
  });

  it("rejects a duplicate normalized email", async () => {
    const repository = new InMemoryUserRepository();
    const register = new RegisterUser({
      userRepository: repository,
      passwordHasher: new FakePasswordHasher()
    });

    await register.execute({ email: "learner@example.com", password: "password123" });

    await assert.rejects(
      register.execute({ email: "LEARNER@example.com", password: "another-password" }),
      { code: "EMAIL_ALREADY_REGISTERED", statusCode: 409 }
    );
  });

  it("rejects passwords shorter than eight characters", async () => {
    const register = new RegisterUser({
      userRepository: new InMemoryUserRepository(),
      passwordHasher: new FakePasswordHasher()
    });

    await assert.rejects(register.execute({ email: "a@example.com", password: "short" }), {
      code: "INVALID_PASSWORD",
      statusCode: 400
    });
  });

  it("rejects a password that exceeds bcrypt's 72 UTF-8 byte limit", async () => {
    const register = new RegisterUser({
      userRepository: new InMemoryUserRepository(),
      passwordHasher: new FakePasswordHasher()
    });

    await assert.rejects(
      register.execute({ email: "a@example.com", password: "é".repeat(40) }),
      { code: "INVALID_PASSWORD", statusCode: 400 }
    );
  });
});

describe("LoginUser", () => {
  it("rejects a suffix beyond bcrypt's 72-byte boundary instead of accepting a truncated match", async () => {
    const repository = new InMemoryUserRepository();
    const passwordHasher = new BcryptPasswordHasher(4);
    const password = "a".repeat(72);
    await repository.create({
      email: "learner@example.com",
      passwordHash: await passwordHasher.hash(password)
    });
    const login = new LoginUser({ userRepository: repository, passwordHasher });

    await assert.rejects(
      login.execute({ email: "learner@example.com", password: `${password}suffix` }),
      { code: "INVALID_CREDENTIALS", statusCode: 401 }
    );
  });
});

describe("LearningState", () => {
  it("accepts a serializable object and creates a defensive JSON copy", () => {
    const input = { settings: { dailyWords: 10 }, words: [{ id: "word-1" }] };
    const state = new LearningState(input);
    input.settings.dailyWords = 50;

    assert.equal(state.value.settings.dailyWords, 10);
  });

  it("rejects arrays and null", () => {
    assert.throws(() => new LearningState([]), { code: "INVALID_STATE" });
    assert.throws(() => new LearningState(null), { code: "INVALID_STATE" });
  });

  it("rejects a state larger than the application limit", () => {
    const oversized = { content: "x".repeat(MAX_SERIALIZED_STATE_BYTES + 1) };
    assert.throws(() => new LearningState(oversized), { code: "STATE_TOO_LARGE" });
  });
});

describe("SaveLearningState", () => {
  it("increments revisions and rejects a stale expected revision", async () => {
    const repository = new InMemoryLearningStateRepository();
    const save = new SaveLearningState({ learningStateRepository: repository });

    assert.deepEqual(await save.execute("1", { words: [] }, 0), {
      state: { words: [] },
      revision: 1
    });
    await assert.rejects(save.execute("1", { words: ["stale"] }, 0), {
      code: "STATE_CONFLICT",
      statusCode: 409
    });
    assert.deepEqual(await repository.findByUserId("1"), {
      state: { words: [] },
      revision: 1
    });
  });

  it("rejects negative, fractional, string, and unsafe revisions", async () => {
    const save = new SaveLearningState({
      learningStateRepository: new InMemoryLearningStateRepository()
    });

    for (const revision of [-1, 1.5, "0", Number.MAX_SAFE_INTEGER + 1]) {
      await assert.rejects(save.execute("1", {}, revision), {
        code: "INVALID_REVISION",
        statusCode: 400
      });
    }
  });
});

describe("application configuration", () => {
  it("rejects SameSite=None cookies without the Secure attribute", () => {
    assert.throws(
      () => loadConfig({ NODE_ENV: "test", COOKIE_SAME_SITE: "none", COOKIE_SECURE: "false" }),
      {
        code: "INVALID_CONFIGURATION",
        message: "COOKIE_SAME_SITE=None requires COOKIE_SECURE=true."
      }
    );
  });

  it("allows and normalizes SameSite=None when Secure is enabled", () => {
    const config = loadConfig({
      NODE_ENV: "test",
      COOKIE_SAME_SITE: "None",
      COOKIE_SECURE: "true"
    });

    assert.equal(config.auth.cookie.options.sameSite, "none");
    assert.equal(config.auth.cookie.options.secure, true);
  });
});
