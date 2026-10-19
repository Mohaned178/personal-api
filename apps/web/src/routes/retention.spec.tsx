import { cleanup, fireEvent, screen, waitFor } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import {
  type FakeBackend,
  type FakeIntegration,
  installFetch,
  makeBackend,
  mount,
  pathname,
} from "@/test/auth-harness";

const SOURCE: FakeIntegration = {
  id: "0192f1c2-7c1e-7a3b-9f00-1c2d3e4f5a6b",
  kind: "http",
  name: "My script",
  defaultPolicy: "deny",
  status: "active",
  lastSeenAt: null,
  createdAt: "2026-10-17T00:00:00.000Z",
};
const REVOKED: FakeIntegration = {
  ...SOURCE,
  id: "0192f1c2-7c1e-7a3b-9f00-1c2d3e4f5a6c",
  name: "Old script",
  status: "revoked",
};

let backend: FakeBackend;

beforeEach(() => {
  backend = makeBackend({ authed: true, retention: [], integrations: [SOURCE, REVOKED] });
  installFetch(backend);
});
afterEach(cleanup);

const writes = () => backend.calls.filter((c) => c.method === "PUT" || c.method === "DELETE");

describe("retention page", () => {
  it("redirects a signed-out visitor to /login", async () => {
    backend.authed = false;
    const { router } = mount("/retention");
    await waitFor(() => expect(pathname(router)).toBe("/login"));
  });

  it("states the default and lists every event type and each active source", async () => {
    mount("/retention");
    expect(await screen.findByText(/kept for 90 days/i)).toBeTruthy();
    expect(screen.getByLabelText("browser.page_visited")).toBeTruthy();
    expect(screen.getByLabelText("My script")).toBeTruthy();
    expect(screen.queryByLabelText("Old script")).toBeNull();
  });

  it("saves a type policy", async () => {
    mount("/retention");
    const input = await screen.findByLabelText("browser.page_visited");
    fireEvent.change(input, { target: { value: "30" } });
    fireEvent.click(input.closest("form")?.querySelector("button[type=submit]") as HTMLElement);
    await waitFor(() => expect(writes()).toHaveLength(1));
    expect(writes()[0]).toMatchObject({
      method: "PUT",
      path: "/v1/retention/type/browser.page_visited",
      body: { days: 30 },
    });
    await waitFor(() => expect(backend.retention).toHaveLength(1));
  });

  it("saves a source policy under the integration id", async () => {
    mount("/retention");
    const input = await screen.findByLabelText("My script");
    fireEvent.change(input, { target: { value: "7" } });
    fireEvent.click(input.closest("form")?.querySelector("button[type=submit]") as HTMLElement);
    await waitFor(() => expect(writes()).toHaveLength(1));
    expect(writes()[0]).toMatchObject({
      path: `/v1/retention/source/${SOURCE.id}`,
      body: { days: 7 },
    });
  });

  it("does not send days outside 1 to 3650", async () => {
    mount("/retention");
    const input = await screen.findByLabelText("My script");
    for (const value of ["0", "3651", "1.5"]) {
      fireEvent.change(input, { target: { value } });
      const save = input.closest("form")?.querySelector("button[type=submit]") as HTMLButtonElement;
      expect(save.disabled, value).toBe(true);
    }
    expect(writes()).toHaveLength(0);
  });

  it("shows a saved policy and clears it", async () => {
    backend.retention = [
      { scope: "source", target: SOURCE.id, days: 14, updatedAt: "2026-10-19T00:00:00.000Z" },
    ];
    mount("/retention");
    const input = (await screen.findByLabelText("My script")) as HTMLInputElement;
    await waitFor(() => expect(input.value).toBe("14"));
    fireEvent.click(input.closest("form")?.querySelector("button[type=button]") as HTMLElement);
    await waitFor(() => expect(writes()).toHaveLength(1));
    expect(writes()[0]).toMatchObject({
      method: "DELETE",
      path: `/v1/retention/source/${SOURCE.id}`,
    });
    await waitFor(() => expect(backend.retention).toHaveLength(0));
  });
});
