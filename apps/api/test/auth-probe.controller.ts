import { Body, Controller, Get, Post, UseGuards } from "@nestjs/common";
import {
  CurrentAuth,
  type IngestAuthContext,
  type SessionAuthContext,
} from "../src/modules/auth/auth-context";
import { SessionGuard } from "../src/modules/auth/session.guard";
import { IngestKeyGuard } from "../src/modules/keys/ingest-key.guard";

/**
 * Test-only routes that exercise the guards and `CurrentAuth` in isolation. M1-05 adds the real
 * ingest route; until then (and for the "wrong kind" misuse cases) these stand in for it.
 *
 *   GET  /probe/ingest             IngestKeyGuard + CurrentAuth("ingest"): echoes the auth context
 *   POST /probe/ingest             same, with a body (a smuggled userId must be ignored)
 *   GET  /probe/session            SessionGuard + CurrentAuth("session"): echoes kind and userId
 *   GET  /probe/ingest-as-session  IngestKeyGuard but CurrentAuth("session")  -> must be 500
 *   GET  /probe/session-as-ingest  SessionGuard but CurrentAuth("ingest")     -> must be 500
 *   GET  /probe/unguarded-ingest   no guard, CurrentAuth("ingest")            -> must be 500
 */
@Controller("probe")
export class AuthProbeController {
  @Get("ingest")
  @UseGuards(IngestKeyGuard)
  ingest(@CurrentAuth("ingest") auth: IngestAuthContext) {
    return auth;
  }

  @Post("ingest")
  @UseGuards(IngestKeyGuard)
  ingestPost(@CurrentAuth("ingest") auth: IngestAuthContext, @Body() _body: unknown) {
    return auth;
  }

  @Get("session")
  @UseGuards(SessionGuard)
  session(@CurrentAuth("session") auth: SessionAuthContext) {
    return { kind: auth.kind, userId: auth.userId };
  }

  @Get("ingest-as-session")
  @UseGuards(IngestKeyGuard)
  ingestAsSession(@CurrentAuth("session") auth: SessionAuthContext) {
    return auth;
  }

  @Get("session-as-ingest")
  @UseGuards(SessionGuard)
  sessionAsIngest(@CurrentAuth("ingest") auth: IngestAuthContext) {
    return auth;
  }

  @Get("unguarded-ingest")
  unguardedIngest(@CurrentAuth("ingest") auth: IngestAuthContext) {
    return auth;
  }
}
