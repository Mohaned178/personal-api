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
const submitOf = (input: HTMLElement) =>
  input.closest("form")?.querySelector("button[type=submit]") as HTMLButtonElement;

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

  it("says a change reaches events already stored and that shortening deletes them", async () => {
    mount("/retention");
    const copy = await screen.findByText(/kept for 90 days/i);
    expect(copy.textContent).toMatch(/applies to events you already have/i);
    expect(copy.textContent).toMatch(/shortening.*deletes older events at the next hourly purge/i);
    expect(copy.textContent).not.toMatch(/from now on/i);
  });

  it("saves a raised policy at once, with no confirmation", async () => {
    mount("/retention");
    const input = await screen.findByLabelText("browser.page_visited");
    fireEvent.change(input, { target: { value: "365" } });
    fireEvent.click(submitOf(input));
    await waitFor(() => expect(writes()).toHaveLength(1));
    expect(writes()[0]).toMatchObject({
      method: "PUT",
      path: "/v1/retention/type/browser.page_visited",
      body: { days: 365 },
    });
    expect(screen.queryByRole("button", { name: "Confirm" })).toBeNull();
    await waitFor(() => expect(backend.retention).toHaveLength(1));
  });

  it("asks before it shortens a type policy, then saves", async () => {
    mount("/retention");
    const input = await screen.findByLabelText("browser.page_visited");
    fireEvent.change(input, { target: { value: "30" } });
    fireEvent.click(submitOf(input));
    const alert = await screen.findByRole("alert");
    expect(alert.textContent).toMatch(/90 to 30 days/);
    expect(alert.textContent).toMatch(/permanently/i);
    expect(writes()).toHaveLength(0);

    fireEvent.click(screen.getByRole("button", { name: "Confirm" }));
    await waitFor(() => expect(writes()).toHaveLength(1));
    expect(writes()[0]).toMatchObject({
      method: "PUT",
      path: "/v1/retention/type/browser.page_visited",
      body: { days: 30 },
    });
    await waitFor(() => expect(backend.retention).toHaveLength(1));
    expect(screen.queryByRole("button", { name: "Confirm" })).toBeNull();
  });

  it("saves nothing when the shortening is cancelled", async () => {
    mount("/retention");
    const input = await screen.findByLabelText("browser.page_visited");
    fireEvent.change(input, { target: { value: "30" } });
    fireEvent.click(submitOf(input));
    await screen.findByRole("button", { name: "Confirm" });
    fireEvent.click(screen.getByRole("button", { name: "Cancel" }));
    expect(screen.queryByRole("button", { name: "Confirm" })).toBeNull();
    expect(writes()).toHaveLength(0);
  });

  it("asks before it shortens below an existing policy, not only below the default", async () => {
    backend.retention = [
      { scope: "source", target: SOURCE.id, days: 200, updatedAt: "2026-10-19T00:00:00.000Z" },
    ];
    mount("/retention");
    const input = (await screen.findByLabelText("My script")) as HTMLInputElement;
    await waitFor(() => expect(input.value).toBe("200"));
    fireEvent.change(input, { target: { value: "120" } });
    fireEvent.click(submitOf(input));
    expect((await screen.findByRole("alert")).textContent).toMatch(/200 to 120 days/);
    expect(writes()).toHaveLength(0);
  });

  it("saves a source policy under the integration id", async () => {
    mount("/retention");
    const input = await screen.findByLabelText("My script");
    fireEvent.change(input, { target: { value: "7" } });
    fireEvent.click(submitOf(input));
    fireEvent.click(await screen.findByRole("button", { name: "Confirm" }));
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
      expect(submitOf(input).disabled, value).toBe(true);
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

  it("asks before clearing a policy longer than the default, since the default is shorter", async () => {
    backend.retention = [
      { scope: "source", target: SOURCE.id, days: 200, updatedAt: "2026-10-19T00:00:00.000Z" },
    ];
    mount("/retention");
    const input = (await screen.findByLabelText("My script")) as HTMLInputElement;
    await waitFor(() => expect(input.value).toBe("200"));
    fireEvent.click(input.closest("form")?.querySelector("button[type=button]") as HTMLElement);
    expect((await screen.findByRole("alert")).textContent).toMatch(/200 to 90 days/);
    expect(writes()).toHaveLength(0);

    fireEvent.click(screen.getByRole("button", { name: "Confirm" }));
    await waitFor(() => expect(writes()).toHaveLength(1));
    expect(writes()[0]).toMatchObject({
      method: "DELETE",
      path: `/v1/retention/source/${SOURCE.id}`,
    });
  });

  it("lists a revoked source that still has a policy, labelled revoked, and removes it", async () => {
    backend.retention = [
      { scope: "source", target: REVOKED.id, days: 14, updatedAt: "2026-10-19T00:00:00.000Z" },
    ];
    mount("/retention");
    const input = (await screen.findByLabelText("Old script (revoked)")) as HTMLInputElement;
    await waitFor(() => expect(input.value).toBe("14"));
    fireEvent.click(input.closest("form")?.querySelector("button[type=button]") as HTMLElement);
    await waitFor(() => expect(writes()).toHaveLength(1));
    expect(writes()[0]).toMatchObject({
      method: "DELETE",
      path: `/v1/retention/source/${REVOKED.id}`,
    });
    await waitFor(() => expect(backend.retention).toHaveLength(0));
    await waitFor(() => expect(screen.queryByLabelText("Old script (revoked)")).toBeNull());
  });

  it("does not list a revoked source that has no policy", async () => {
    mount("/retention");
    await screen.findByLabelText("My script");
    expect(screen.queryByLabelText("Old script (revoked)")).toBeNull();
    expect(screen.queryByLabelText("Old script")).toBeNull();
  });
});
