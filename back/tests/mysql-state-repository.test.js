import assert from "node:assert/strict";
import { describe, it } from "node:test";
import { MySqlLearningStateRepository } from "../src/infrastructure/persistence/mysql/MySqlLearningStateRepository.js";

class ScriptedPool {
  constructor(results) {
    this.results = [...results];
    this.calls = [];
  }

  async execute(sql, parameters) {
    this.calls.push({ sql, parameters });
    const result = this.results.shift();
    if (result instanceof Error) throw result;
    return result;
  }
}

describe("MySqlLearningStateRepository optimistic concurrency", () => {
  it("updates an existing row only when its revision matches", async () => {
    const pool = new ScriptedPool([[{ affectedRows: 1 }]]);
    const repository = new MySqlLearningStateRepository(pool);

    assert.equal(await repository.save("7", { words: [] }, 3), 4);
    assert.match(pool.calls[0].sql, /WHERE user_id = \? AND revision = \?/);
    assert.deepEqual(pool.calls[0].parameters, ['{"words":[]}', "7", 3]);
  });

  it("inserts revision one when no state exists and zero is expected", async () => {
    const pool = new ScriptedPool([[{ affectedRows: 0 }], [{ affectedRows: 1 }]]);
    const repository = new MySqlLearningStateRepository(pool);

    assert.equal(await repository.save("7", { words: [] }, 0), 1);
    assert.match(pool.calls[1].sql, /revision\) VALUES \(\?, \?, 1\)/);
  });

  it("returns a conflict for a stale revision", async () => {
    const pool = new ScriptedPool([[{ affectedRows: 0 }]]);
    const repository = new MySqlLearningStateRepository(pool);

    await assert.rejects(repository.save("7", { words: [] }, 2), {
      code: "STATE_CONFLICT",
      statusCode: 409
    });
    assert.equal(pool.calls.length, 1);
  });

  it("returns a conflict when a concurrent first insert wins", async () => {
    const duplicate = Object.assign(new Error("duplicate"), { code: "ER_DUP_ENTRY" });
    const pool = new ScriptedPool([[{ affectedRows: 0 }], duplicate]);
    const repository = new MySqlLearningStateRepository(pool);

    await assert.rejects(repository.save("7", { words: [] }, 0), {
      code: "STATE_CONFLICT",
      statusCode: 409
    });
  });
});
