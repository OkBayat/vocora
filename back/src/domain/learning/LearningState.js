import { ValidationError } from "../errors.js";

const MAX_SERIALIZED_STATE_BYTES = 9_500_000;

export class LearningState {
  constructor(value) {
    if (value === null || typeof value !== "object" || Array.isArray(value)) {
      throw new ValidationError("INVALID_STATE", "State must be a JSON object.");
    }

    let serialized;
    try {
      serialized = JSON.stringify(value);
    } catch {
      throw new ValidationError("INVALID_STATE", "State must be valid JSON.");
    }

    if (serialized === undefined) {
      throw new ValidationError("INVALID_STATE", "State must be valid JSON.");
    }

    if (Buffer.byteLength(serialized, "utf8") > MAX_SERIALIZED_STATE_BYTES) {
      throw new ValidationError("STATE_TOO_LARGE", "State is too large to save.");
    }

    this.value = JSON.parse(serialized);
  }
}

export { MAX_SERIALIZED_STATE_BYTES };
