import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { createMemoryHistory, RouterProvider } from "@tanstack/react-router";
import { cleanup, render, screen } from "@testing-library/react";
import { afterEach, describe, expect, it } from "vitest";
import { createAppRouter } from "@/router";

afterEach(() => {
  cleanup();
});

describe("index route", () => {
  it("renders the placeholder page with the shadcn button", async () => {
    const router = createAppRouter(createMemoryHistory({ initialEntries: ["/"] }));

    render(
      <QueryClientProvider client={new QueryClient()}>
        <RouterProvider router={router} />
      </QueryClientProvider>,
    );

    const heading = await screen.findByRole("heading", { name: "Personal API" });
    expect(heading).toBeTruthy();
    expect(await screen.findByRole("button", { name: "Sign in coming soon" })).toBeTruthy();
  });
});
