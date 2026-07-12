import { GetCurrentUser } from "./application/auth/GetCurrentUser.js";
import { LoginUser } from "./application/auth/LoginUser.js";
import { RegisterUser } from "./application/auth/RegisterUser.js";
import { GetLearningState } from "./application/learning/GetLearningState.js";
import { SaveLearningState } from "./application/learning/SaveLearningState.js";
import { MySqlLearningStateRepository } from "./infrastructure/persistence/mysql/MySqlLearningStateRepository.js";
import { MySqlUserRepository } from "./infrastructure/persistence/mysql/MySqlUserRepository.js";
import { BcryptPasswordHasher } from "./infrastructure/security/BcryptPasswordHasher.js";
import { JwtTokenService } from "./infrastructure/security/JwtTokenService.js";

export function createContainer({ pool, config, adapters = {} }) {
  const userRepository = adapters.userRepository ?? new MySqlUserRepository(pool);
  const learningStateRepository =
    adapters.learningStateRepository ?? new MySqlLearningStateRepository(pool);
  const passwordHasher = adapters.passwordHasher ?? new BcryptPasswordHasher();
  const tokenService =
    adapters.tokenService ??
    new JwtTokenService({ secret: config.auth.jwtSecret, expiresIn: config.auth.jwtExpiresIn });

  return {
    tokenService,
    authCookie: config.auth.cookie,
    authRateLimit: config.auth.rateLimit,
    useCases: {
      registerUser: new RegisterUser({ userRepository, passwordHasher }),
      loginUser: new LoginUser({ userRepository, passwordHasher }),
      getCurrentUser: new GetCurrentUser({ userRepository }),
      getLearningState: new GetLearningState({ learningStateRepository }),
      saveLearningState: new SaveLearningState({ learningStateRepository })
    }
  };
}
