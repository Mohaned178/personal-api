import { type CanActivate, type ExecutionContext, Inject, Injectable } from "@nestjs/common";
import { AppException } from "../../platform/errors/problem";
import { AUTH } from "./auth.tokens";
import type { AuthenticatedRequest } from "./auth-context";

/** The slice of Better Auth the guard needs, so tests can stand in for it. */
export interface SessionLookup {
  api: {
    getSession(input: { headers: Headers }): Promise<{
      session: { id: string };
      user: { id: string; email: string; name: string };
    } | null>;
  };
}

/**
 * Requires a valid dashboard session cookie. Only the Cookie header is handed to Better Auth, so
 * a bearer token (an API key or a session token) can never stand in for a dashboard session.
 * Failure is a 401 problem+json through ProblemFilter.
 */
@Injectable()
export class SessionGuard implements CanActivate {
  constructor(@Inject(AUTH) private readonly auth: SessionLookup) {}

  async canActivate(context: ExecutionContext): Promise<boolean> {
    const req = context.switchToHttp().getRequest<AuthenticatedRequest>();
    const headers = new Headers();
    const cookie = req.headers.cookie;
    if (typeof cookie === "string" && cookie !== "") headers.set("cookie", cookie);

    const found = headers.has("cookie") ? await this.auth.api.getSession({ headers }) : null;
    if (!found) {
      throw new AppException(401, "auth.unauthenticated", "Authentication required");
    }
    req.auth = {
      kind: "session",
      userId: found.user.id,
      sessionId: found.session.id,
      user: { id: found.user.id, email: found.user.email, name: found.user.name },
    };
    return true;
  }
}
