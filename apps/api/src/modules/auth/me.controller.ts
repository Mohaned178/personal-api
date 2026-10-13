import { Controller, Get, UseGuards } from "@nestjs/common";
import { type AuthContext, CurrentAuth } from "./auth-context";
import { SessionGuard } from "./session.guard";

export interface MeResponse {
  id: string;
  email: string;
  name: string;
}

@Controller("v1")
export class MeController {
  /** The signed-in user, taken from the session only; nothing in the request can change it. */
  @Get("me")
  @UseGuards(SessionGuard)
  me(@CurrentAuth() auth: AuthContext): MeResponse {
    return { id: auth.user.id, email: auth.user.email, name: auth.user.name };
  }
}
