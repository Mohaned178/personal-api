import { type CanActivate, type ExecutionContext, Injectable } from "@nestjs/common";
import type { AuthenticatedRequest } from "../auth/auth-context";
import { SessionGuard } from "../auth/session.guard";
import { ReadKeyGuard } from "./read-key.guard";

/**
 * For routes a dashboard session and a read key may both call. The credential is chosen by the
 * request, never by trying one after the other: any `Authorization` header means the read-key
 * path (so a bad key is `auth.invalid_key` even when a cookie is also sent, and the cookie is not
 * a fallback), and no `Authorization` header means the session path. The route still needs
 * `@RequireReadScope`, which only applies to read keys.
 */
@Injectable()
export class SessionOrReadKeyGuard implements CanActivate {
  constructor(
    private readonly session: SessionGuard,
    private readonly readKey: ReadKeyGuard,
  ) {}

  canActivate(context: ExecutionContext): Promise<boolean> {
    const req = context.switchToHttp().getRequest<AuthenticatedRequest>();
    return req.headers.authorization === undefined
      ? this.session.canActivate(context)
      : this.readKey.canActivate(context);
  }
}
