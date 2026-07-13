import { AuthenticationError } from "../../domain/errors.js";

export function createAuthMiddleware({ tokenService, getCurrentUser, cookieName }) {
  return async function authenticate(req, _res, next) {
    try {
      const token = req.cookies?.[cookieName];
      if (!token) throw new AuthenticationError();

      const { userId } = tokenService.verify(token);
      const user = await getCurrentUser.execute(userId);
      req.auth = { userId, user };
      next();
    } catch (error) {
      next(error);
    }
  };
}
