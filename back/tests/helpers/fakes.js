import { loadConfig } from "../../src/config/loadConfig.js";
import { createContainer } from "../../src/container.js";
import { createApp } from "../../src/createApp.js";
import { ConflictError } from "../../src/domain/errors.js";
import { User } from "../../src/domain/user/User.js";

export class InMemoryUserRepository {
  constructor() {
    this.users = new Map();
    this.nextId = 1;
  }

  async findByEmail(email) {
    return [...this.users.values()].find((user) => user.email === email) ?? null;
  }

  async findById(id) {
    return this.users.get(String(id)) ?? null;
  }

  async create({ email, passwordHash }) {
    const user = new User({ id: this.nextId++, email, passwordHash });
    this.users.set(user.id, user);
    return user;
  }
}

export class InMemoryLearningStateRepository {
  constructor() {
    this.states = new Map();
  }

  async findByUserId(userId) {
    const record = this.states.get(String(userId));
    return record === undefined
      ? { state: null, revision: 0 }
      : structuredClone(record);
  }

  async save(userId, state, expectedRevision) {
    const key = String(userId);
    const current = this.states.get(key);
    const currentRevision = current?.revision ?? 0;
    if (currentRevision !== expectedRevision) {
      throw new ConflictError(
        "STATE_CONFLICT",
        "Learning state was updated by another session. Reload and try again."
      );
    }

    const revision = expectedRevision + 1;
    this.states.set(key, { state: structuredClone(state), revision });
    return revision;
  }
}

export class FakePasswordHasher {
  async hash(password) {
    return `hashed:${password}`;
  }

  async compare(password, passwordHash) {
    return passwordHash === `hashed:${password}`;
  }
}

export function createTestContext(environmentOverrides = {}) {
  const config = loadConfig({
    NODE_ENV: "test",
    JWT_SECRET: "test-secret-at-least-thirty-two-characters",
    AUTH_COOKIE_NAME: "test_session",
    COOKIE_SECURE: "false",
    ...environmentOverrides
  });
  const userRepository = new InMemoryUserRepository();
  const learningStateRepository = new InMemoryLearningStateRepository();
  const container = createContainer({
    config,
    adapters: {
      userRepository,
      learningStateRepository,
      passwordHasher: new FakePasswordHasher()
    }
  });
  const app = createApp({
    container,
    staticDirectory: false,
    nodeEnv: "test",
    logger: { error() {} }
  });

  return { app, config, container, userRepository, learningStateRepository };
}
