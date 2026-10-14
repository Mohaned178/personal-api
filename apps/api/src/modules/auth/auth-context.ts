import { createParamDecorator, type ExecutionContext } from "@nestjs/common";
import type { Request } from "express";

/**
 * Who is calling, as established by a guard. Repositories take `userId` from here and never from
 * the request body, query or headers (invariant 4). `kind` says which guard set it.
 */
export interface SessionAuthContext {
  kind: "session";
  userId: string;
  sessionId: string;
  user: { id: string; email: string; name: string };
}

/** Set by IngestKeyGuard. The integration comes from the key, never from the request. */
export interface IngestAuthContext {
  kind: "ingest";
  userId: string;
  integrationId: string;
  keyId: string;
}

export type AuthContext = SessionAuthContext | IngestAuthContext;
export type AuthKind = AuthContext["kind"];

export type AuthenticatedRequest = Request & { auth?: AuthContext };

/** A route asked for an AuthContext its guard did not provide. A bug, so it is a 500. */
export class AuthContextMismatchError extends Error {
  constructor() {
    super("CurrentAuth found no AuthContext of the requested kind");
    this.name = "AuthContextMismatchError";
  }
}

const currentAuth = createParamDecorator((kind: unknown, ctx: ExecutionContext) => {
  const auth = ctx.switchToHttp().getRequest<AuthenticatedRequest>().auth;
  if (auth === undefined || auth.kind !== kind) throw new AuthContextMismatchError();
  return auth;
});

/**
 * Injects the AuthContext of the given kind. Fails closed (500, nothing leaked) when no guard ran
 * or the guard set the other kind, so a session route can never receive an ingest context or the
 * reverse.
 */
export function CurrentAuth(kind: AuthKind): ParameterDecorator {
  return currentAuth(kind);
}
