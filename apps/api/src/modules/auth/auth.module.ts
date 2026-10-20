import { Inject, Module, type OnModuleInit } from "@nestjs/common";
import { APP_GUARD, HttpAdapterHost } from "@nestjs/core";
import { toNodeHandler } from "better-auth/node";
import type { Express } from "express";
import type { AppConfig } from "../../config/config";
import { APP_CONFIG } from "../../config/config.module";
import type { Database } from "../../platform/db/db";
import { DB } from "../../platform/db/db.tokens";
import { type Auth, createAuth } from "./auth";
import { AUTH_ROUTE, createAuthRequestHandler } from "./auth.http";
import { AUTH } from "./auth.tokens";
import { CsrfGuard } from "./csrf.guard";
import { MeController } from "./me.controller";
import { SessionGuard } from "./session.guard";
import { SetupController } from "./setup.controller";
import { SignupGate } from "./signup-gate";

/**
 * Dashboard auth: Better Auth (email + password, cookie sessions) mounted at /api/auth, the
 * signup gate, SessionGuard and GET /v1/me.
 *
 * The mount is hand-rolled rather than using @thallesp/nestjs-better-auth: the signup gate has to
 * wrap the sign-up request itself (to be atomic and to answer in problem+json), SessionGuard must
 * raise Nest exceptions for ProblemFilter and see only the Cookie header, and the library's
 * guard-everything-by-default would have to be switched off. The whole mount is the hook
 * below.
 */
@Module({
  controllers: [MeController, SetupController],
  providers: [
    SignupGate,
    {
      provide: AUTH,
      inject: [APP_CONFIG, DB, SignupGate],
      useFactory: (config: AppConfig, db: Database, gate: SignupGate): Auth =>
        createAuth({ config, db, canCreateUser: () => gate.isOpen() }),
    },
    SessionGuard,
    // Every route: a state-changing request with a cookie must come from our own origin.
    { provide: APP_GUARD, useClass: CsrfGuard },
  ],
  exports: [AUTH, SessionGuard],
})
export class AuthModule implements OnModuleInit {
  constructor(
    private readonly adapterHost: HttpAdapterHost,
    @Inject(AUTH) private readonly auth: Auth,
    private readonly gate: SignupGate,
  ) {}

  /**
   * Better Auth needs the raw request stream, so it is mounted as a plain Express route.
   * BodyParserModule (platform/http) leaves /api/auth/* unparsed for it.
   */
  onModuleInit(): void {
    const httpAdapter = this.adapterHost.httpAdapter;
    if (!httpAdapter) return; // standalone context (no HTTP server)
    const app = httpAdapter.getInstance<Express>();
    app.all(AUTH_ROUTE, createAuthRequestHandler(toNodeHandler(this.auth), this.gate));
  }
}
