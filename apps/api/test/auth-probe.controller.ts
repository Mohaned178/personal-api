import { Body, Controller, Get, Post, UseGuards } from "@nestjs/common";
import {
  CurrentAuth,
  type IngestAuthContext,
  type ReadAuthContext,
  type SessionAuthContext,
} from "../src/modules/auth/auth-context";
import { SessionGuard } from "../src/modules/auth/session.guard";
import { IngestKeyGuard } from "../src/modules/keys/ingest-key.guard";
import { ReadKeyGuard, RequireReadScope } from "../src/modules/keys/read-key.guard";

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
 *   GET  /probe/read               ReadKeyGuard + @RequireReadScope("events:read"): echoes the context
 *   POST /probe/read               same, with a body (a smuggled userId must be ignored)
 *   GET  /probe/read-activity      ReadKeyGuard + @RequireReadScope("activity:read")
 *   GET  /probe/read-no-scope      ReadKeyGuard with no declared scope             -> must be 500
 *   GET  /probe/read-as-session    ReadKeyGuard but CurrentAuth("session")         -> must be 500
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

  @Get("read")
  @UseGuards(ReadKeyGuard)
  @RequireReadScope("events:read")
  read(@CurrentAuth("read") auth: ReadAuthContext) {
    return auth;
  }

  @Post("read")
  @UseGuards(ReadKeyGuard)
  @RequireReadScope("events:read")
  readPost(@CurrentAuth("read") auth: ReadAuthContext, @Body() _body: unknown) {
    return auth;
  }

  @Get("read-activity")
  @UseGuards(ReadKeyGuard)
  @RequireReadScope("activity:read")
  readActivity(@CurrentAuth("read") auth: ReadAuthContext) {
    return auth;
  }

  @Get("read-no-scope")
  @UseGuards(ReadKeyGuard)
  readNoScope(@CurrentAuth("read") auth: ReadAuthContext) {
    return auth;
  }

  @Get("read-as-session")
  @UseGuards(ReadKeyGuard)
  @RequireReadScope("events:read")
  readAsSession(@CurrentAuth("session") auth: SessionAuthContext) {
    return auth;
  }
}
