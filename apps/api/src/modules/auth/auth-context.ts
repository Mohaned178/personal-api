import { createParamDecorator, type ExecutionContext } from "@nestjs/common";
import type { Request } from "express";

/**
 * Who is calling, as established by a guard. Repositories take `userId` from here and never from
 * the request body, query or headers (invariant 4).
 */
export interface AuthContext {
  userId: string;
  sessionId: string;
  user: { id: string; email: string; name: string };
}

export type AuthenticatedRequest = Request & { auth?: AuthContext };

/** Injects the AuthContext set by SessionGuard. Throws if no guard ran, so it fails closed. */
export const CurrentAuth = createParamDecorator((_data: unknown, ctx: ExecutionContext) => {
  const auth = ctx.switchToHttp().getRequest<AuthenticatedRequest>().auth;
  if (!auth) throw new Error("CurrentAuth used on a route without an auth guard");
  return auth;
});
