import { cleanup, fireEvent, screen, waitFor } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { type FakeBackend, installFetch, makeBackend, mount, pathname } from "@/test/auth-harness";

let backend: FakeBackend;

beforeEach(() => {
  backend = makeBackend({ authed: true, timeZone: "UTC" });
  installFetch(backend);
});
afterEach(cleanup);

const patched = () =>
  backend.calls.filter((c) => c.method === "PATCH" && c.path === "/v1/settings");

describe("settings page", () => {
  it("redirects a signed-out visitor to /login", async () => {
    backend.authed = false;
    const { router } = mount("/settings");
    await waitFor(() => expect(pathname(router)).toBe("/login"));
  });

  it("shows the saved time zone and saves a new one", async () => {
    mount("/settings");
    const input = (await screen.findByLabelText("Time zone")) as HTMLInputElement;
    expect(input.value).toBe("UTC");
    expect((screen.getByRole("button", { name: "Save" }) as HTMLButtonElement).disabled).toBe(true);
    fireEvent.change(input, { target: { value: "Europe/Berlin" } });
    fireEvent.click(screen.getByRole("button", { name: "Save" }));
    await waitFor(() => expect(patched()).toHaveLength(1));
    expect(patched()[0]?.body).toEqual({ timeZone: "Europe/Berlin" });
    await waitFor(() => expect(backend.timeZone).toBe("Europe/Berlin"));
  });

  it("suggests the zones the server accepts, not the ones the browser knows", async () => {
    backend.timeZones = ["Asia/Kolkata", "Europe/Berlin", "UTC"];
    const { container } = mount("/settings");
    await screen.findByLabelText("Time zone");
    await waitFor(() =>
      expect(
        Array.from(container.querySelectorAll("datalist#time-zones option")).map((o) =>
          o.getAttribute("value"),
        ),
      ).toEqual(["Asia/Kolkata", "Europe/Berlin", "UTC"]),
    );
  });

  it("does not send a value that is not an IANA zone", async () => {
    mount("/settings");
    const input = await screen.findByLabelText("Time zone");
    fireEvent.change(input, { target: { value: "+02:00" } });
    expect(screen.getByText(/enter an iana time zone/i)).toBeTruthy();
    expect((screen.getByRole("button", { name: "Save" }) as HTMLButtonElement).disabled).toBe(true);
    expect(patched()).toHaveLength(0);
  });

  it("shows an error when the server refuses the zone", async () => {
    backend.rejectSettings = 400;
    mount("/settings");
    const input = await screen.findByLabelText("Time zone");
    fireEvent.change(input, { target: { value: "Europe/Berlin" } });
    fireEvent.click(screen.getByRole("button", { name: "Save" }));
    expect(await screen.findByText(/could not save/i)).toBeTruthy();
  });
});
