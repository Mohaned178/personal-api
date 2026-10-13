import {
  Inject,
  type MiddlewareConsumer,
  Module,
  type NestModule,
  type OnModuleInit,
  RequestMethod,
} from "@nestjs/common";
import { HttpAdapterHost } from "@nestjs/core";
import { toNodeHandler } from "better-auth/node";
import type { Express } from "express";
import type { AppConfig } from "../../config/config";
import { APP_CONFIG } from "../../config/config.module";
import type { Database } from "../../platform/db/db";
import { DB } from "../../platform/db/db.tokens";
import { type Auth, createAuth } from "./auth";
import { AUTH_ROUTE, createAuthRequestHandler, createBodyParser } from "./auth.http";
import { AUTH } from "./auth.tokens";
import { MeController } from "./me.controller";
import { SessionGuard } from "./session.guard";
import { SignupGate } from "./signup-gate";

/**
 * Dashboard auth: Better Auth (email + password, cookie sessions) mounted at /api/auth, the
 * signup gate, SessionGuard and GET /v1/me.
 *
 * The mount is hand-rolled rather than using @thallesp/nestjs-better-auth: the signup gate has to
 * wrap the sign-up request itself (to be atomic and to answer in problem+json), SessionGuard must
 * raise Nest exceptions for ProblemFilter and see only the Cookie header, and the library's
 * guard-everything-by-default would have to be switched off. The whole mount is the two hooks
 * below.
 */
@Module({
  controllers: [MeController],
  providers: [
    SignupGate,
    {
      provide: AUTH,
      inject: [APP_CONFIG, DB, SignupGate],
      useFactory: (config: AppConfig, db: Database, gate: SignupGate): Auth =>
        createAuth({ config, db, canCreateUser: () => gate.isOpen() }),
    },
    SessionGuard,
  ],
  exports: [AUTH, SessionGuard],
})
export class AuthModule implements NestModule, OnModuleInit {
  constructor(
    private readonly adapterHost: HttpAdapterHost,
    @Inject(AUTH) private readonly auth: Auth,
    private readonly gate: SignupGate,
  ) {}

  /** Runs before any route is registered, so every controller still gets parsed bodies. */
  configure(consumer: MiddlewareConsumer): void {
    consumer.apply(createBodyParser()).forRoutes({ path: "{*splat}", method: RequestMethod.ALL });
  }

  /** Better Auth needs the raw request stream, so it is mounted as a plain Express route. */
  onModuleInit(): void {
    const httpAdapter = this.adapterHost.httpAdapter;
    if (!httpAdapter) return; // standalone context (no HTTP server)
    const app = httpAdapter.getInstance<Express>();
    app.all(AUTH_ROUTE, createAuthRequestHandler(toNodeHandler(this.auth), this.gate));
  }
}
