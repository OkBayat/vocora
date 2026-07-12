import { ConflictError } from "../../domain/errors.js";
import { User } from "../../domain/user/User.js";

export class RegisterUser {
  constructor({ userRepository, passwordHasher }) {
    this.userRepository = userRepository;
    this.passwordHasher = passwordHasher;
  }

  async execute({ email, password }) {
    const normalizedEmail = User.normalizeEmail(email);
    User.validatePassword(password);

    if (await this.userRepository.findByEmail(normalizedEmail)) {
      throw new ConflictError("EMAIL_ALREADY_REGISTERED", "This email is already registered.");
    }

    const passwordHash = await this.passwordHasher.hash(password);
    const user = await this.userRepository.create({
      email: normalizedEmail,
      passwordHash
    });

    return user.toPublic();
  }
}
