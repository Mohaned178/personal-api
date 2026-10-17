import { cleanup, screen } from "@testing-library/react";
import { afterEach, describe, expect, it, vi } from "vitest";
import { installFetch, makeBackend, mount } from "@/test/auth-harness";

afterEach(() => {
  cleanup();
  vi.unstubAllGlobals();
});

describe("index route", () => {
  it("renders the home page for a signed-in user", async () => {
    installFetch(makeBackend({ authed: true }));
    mount("/");

    expect(await screen.findByRole("heading", { name: "Personal API" })).toBeTruthy();
    expect(await screen.findByRole("button", { name: "Sign out" })).toBeTruthy();
  });
});
