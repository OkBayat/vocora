import bcrypt from "bcryptjs";

export class BcryptPasswordHasher {
  constructor(rounds = 12) {
    this.rounds = rounds;
  }

  hash(password) {
    return bcrypt.hash(password, this.rounds);
  }

  compare(password, passwordHash) {
    return bcrypt.compare(password, passwordHash);
  }
}
