import jwt from "jsonwebtoken";
import { AuthenticationError } from "../../domain/errors.js";

export class JwtTokenService {
  constructor({ secret, expiresIn = "7d" }) {
    this.secret = secret;
    this.expiresIn = expiresIn;
  }

  issue(userId) {
    return jwt.sign(
      { type: "access" },
      this.secret,
      { subject: String(userId), expiresIn: this.expiresIn, algorithm: "HS256" }
    );
  }

  verify(token) {
    try {
      const payload = jwt.verify(token, this.secret, { algorithms: ["HS256"] });
      if (payload.type !== "access" || !payload.sub) throw new Error("Invalid token payload");
      return { userId: payload.sub };
    } catch {
      throw new AuthenticationError("INVALID_SESSION", "Your session is invalid or expired.");
    }
  }
}
