import { ValidationError } from "../errors.js";

const EMAIL_PATTERN = /^[^\s@]+@[^\s@]+\.[^\s@]+$/u;

export class User {
  constructor({ id, email, passwordHash, createdAt = null, updatedAt = null }) {
    this.id = id === null || id === undefined ? null : String(id);
    this.email = User.normalizeEmail(email);
    this.passwordHash = passwordHash;
    this.createdAt = createdAt;
    this.updatedAt = updatedAt;
  }

  static normalizeEmail(email) {
    if (typeof email !== "string") {
      throw new ValidationError("INVALID_EMAIL", "Enter a valid email address.");
    }

    const normalized = email.trim().toLowerCase();
    if (!normalized || normalized.length > 320 || !EMAIL_PATTERN.test(normalized)) {
      throw new ValidationError("INVALID_EMAIL", "Enter a valid email address.");
    }

    return normalized;
  }

  static validatePassword(password) {
    if (
      typeof password !== "string" ||
      password.length < 8 ||
      Buffer.byteLength(password, "utf8") > 72
    ) {
      throw new ValidationError(
        "INVALID_PASSWORD",
        "Password must contain at least 8 characters and no more than 72 UTF-8 bytes."
      );
    }
  }

  toPublic() {
    return { id: this.id, email: this.email };
  }
}
