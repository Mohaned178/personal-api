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

/**
 * M1-03 (test-writer stub types). The builder turns `AuthContext` into the union
 * `SessionAuthContext | IngestAuthContext`, discriminated by `kind`, makes SessionGuard set
 * `kind: "session"`, and makes `CurrentAuth("session" | "ingest")` fail closed (500) when the
 * request's auth is missing or of a different kind.
 */
export type AuthKind = "session" | "ingest";

export interface SessionAuthContext extends AuthContext {
  kind: "session";
}

export interface IngestAuthContext {
  kind: "ingest";
  userId: string;
  integrationId: string;
  keyId: string;
}

export type AuthenticatedRequest = Request & { auth?: AuthContext };

/** Injects the AuthContext set by SessionGuard. Throws if no guard ran, so it fails closed. */
export const CurrentAuth = createParamDecorator((_data: unknown, ctx: ExecutionContext) => {
  const auth = ctx.switchToHttp().getRequest<AuthenticatedRequest>().auth;
  if (!auth) throw new Error("CurrentAuth used on a route without an auth guard");
  return auth;
});
