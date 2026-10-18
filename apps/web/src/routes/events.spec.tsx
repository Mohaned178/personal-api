import { QueryClient } from "@tanstack/react-query";
import { cleanup, fireEvent, screen, waitFor, within } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import {
  type FakeBackend,
  type FakeEvent,
  type FakeIntegration,
  installFetch,
  makeBackend,
  mount,
  pathname,
} from "@/test/auth-harness";

const logSpies: ReturnType<typeof vi.spyOn>[] = [];
let backend: FakeBackend;

const LAPTOP: FakeIntegration = {
  id: "11111111-1111-4111-8111-111111111111",
  kind: "browser-extension",
  name: "Work laptop",
  defaultPolicy: "deny",
  status: "active",
  lastSeenAt: null,
  createdAt: "2026-10-17T00:00:00.000Z",
};

function event(n: number, over: Partial<FakeEvent> = {}): FakeEvent {
  return {
    id: crypto.randomUUID(),
    integrationId: LAPTOP.id,
    type: "browser.page_visited",
    typeVersion: 1,
    // Newest first, like the API: a higher n is older.
    occurredAt: new Date(Date.UTC(2026, 9, 17) - n * 60_000).toISOString(),
    receivedAt: "2026-10-17T00:00:00.000Z",
    origin: "collected",
    data: { domain: `site${n}.test`, path: "/p" },
    tags: [],
    trace: null,
    ...over,
  };
}

const many = (count: number) => Array.from({ length: count }, (_, n) => event(n));
const rowCount = () => screen.queryAllByRole("row").length;
const eventGets = () => backend.calls.filter((c) => c.method === "GET" && c.path === "/v1/events");
const ariaRows = () => screen.getByRole("table").getAttribute("aria-rowcount");

beforeEach(() => {
  backend = makeBackend({ authed: true, integrations: [LAPTOP], events: [] });
  installFetch(backend);
  for (const m of ["log", "info", "warn", "error", "debug"] as const) {
    logSpies.push(vi.spyOn(console, m).mockImplementation(() => undefined));
  }
});
afterEach(() => {
  cleanup();
  vi.unstubAllGlobals();
  for (const s of logSpies.splice(0)) s.mockRestore();
});

describe("events page", () => {
  it("redirects a signed-out visitor to /login", async () => {
    backend.authed = false;
    const { router } = mount("/events");
    await waitFor(() => expect(pathname(router)).toBe("/login"));
  });

  it("shows an empty state", async () => {
    mount("/events");
    expect(await screen.findByText(/no events match/i)).toBeTruthy();
  });

  it("shows an error when loading fails", async () => {
    delete backend.events;
    mount("/events", new QueryClient({ defaultOptions: { queries: { retry: false } } }));
    expect((await screen.findByText(/could not load events/i)).getAttribute("role")).toBe("alert");
  });

  it("renders only a window of a long list and loads the next page near the end", async () => {
    backend.events = many(120);
    mount("/events");
    await screen.findAllByRole("row");
    expect(ariaRows()).toBe("50");
    expect(rowCount()).toBeLessThan(30);

    const scroller = screen.getByTestId("events-scroller");
    scroller.scrollTop = 45 * 40;
    fireEvent.scroll(scroller);
    await waitFor(() => expect(ariaRows()).toBe("100"));
    expect(eventGets()[1]?.search).toBe("?cursor=50");
    expect(rowCount()).toBeLessThan(30);
  });

  it("sends the filters, with the time range converted to UTC", async () => {
    const other = event(1, { type: "browser.tab_opened", data: { domain: "other.test" } });
    backend.events = [event(0), other];
    mount("/events");
    await screen.findAllByRole("row");

    fireEvent.change(screen.getByLabelText(/^source/i), { target: { value: LAPTOP.id } });
    fireEvent.change(screen.getByLabelText(/^type/i), { target: { value: "browser.tab_opened" } });
    fireEvent.change(screen.getByLabelText(/^domain/i), { target: { value: " Other.Test " } });
    fireEvent.change(screen.getByLabelText(/^from/i), { target: { value: "2026-10-01T00:00" } });
    fireEvent.change(screen.getByLabelText(/^to/i), { target: { value: "2026-12-01T00:00" } });
    fireEvent.click(screen.getByRole("button", { name: /apply filters/i }));

    await waitFor(() => expect(eventGets()).toHaveLength(2));
    const params = new URLSearchParams(eventGets()[1]?.search);
    expect(params.get("source")).toBe(LAPTOP.id);
    expect(params.get("type")).toBe("browser.tab_opened");
    expect(params.get("domain")).toBe("other.test");
    expect(params.get("from")).toBe(new Date("2026-10-01T00:00").toISOString());
    expect(params.get("to")).toBe(new Date("2026-12-01T00:00").toISOString());
    await waitFor(() => expect(rowCount()).toBe(1));
    expect(within(screen.getAllByRole("row")[0] as HTMLElement).getByText("browser.tab_opened"));
  });

  it.each(["https://github.com", "github.com/", "git hub.com"])(
    "flags a domain like %s next to the field and sends no request",
    async (value) => {
      backend.events = [event(0)];
      mount("/events");
      await screen.findAllByRole("row");
      fireEvent.change(screen.getByLabelText(/^domain/i), { target: { value } });
      fireEvent.click(screen.getByRole("button", { name: /apply filters/i }));
      expect((await screen.findByRole("alert")).textContent).toMatch(/domain/i);
      expect(screen.getByLabelText(/^domain/i).getAttribute("aria-invalid")).toBe("true");
      expect(eventGets()).toHaveLength(1);
      // The rows from the last good filter stay on screen.
      expect(rowCount()).toBe(1);
    },
  );

  it("opens a detail drawer with the JSON, origin and integration name", async () => {
    backend.events = [event(0, { origin: "imported" })];
    mount("/events");
    fireEvent.click(await screen.findByRole("button", { name: /open event 1/i }));
    const drawer = await screen.findByRole("dialog", { name: /event details/i });
    expect(within(drawer).getByText("Work laptop")).toBeTruthy();
    expect(within(drawer).getByText("imported")).toBeTruthy();
    expect(JSON.parse(within(drawer).getByTestId("event-json").textContent ?? "")).toMatchObject({
      type: "browser.page_visited",
      data: { domain: "site0.test", path: "/p" },
    });
    fireEvent.click(within(drawer).getByRole("button", { name: /close/i }));
    expect(screen.queryByRole("dialog")).toBeNull();
  });

  describe("why is this here", () => {
    const RULE_ID = "11111111-1111-4111-8111-111111111111";
    const trace = (over: object = {}) => ({
      ruleSetVersion: 2,
      matched: [{ ruleId: RULE_ID, actions: ["allow", "coarsen"] }],
      decidedBy: RULE_ID,
      ...over,
    });
    const openFirst = async () => {
      fireEvent.click(await screen.findByRole("button", { name: /open event 1/i }));
      return screen.findByRole("dialog", { name: /event details/i });
    };

    it("names the deciding rule and what it did", async () => {
      backend.rules = {
        version: 2,
        rules: [
          {
            id: RULE_ID,
            name: "Track GitHub",
            enabled: true,
            priority: 1,
            stage: "collect",
            when: {},
            then: [{ action: "allow" }],
          },
        ],
      };
      backend.events = [event(0, { trace: trace() })];
      mount("/events");
      const drawer = await openFirst();
      const why = await within(drawer).findByRole("region", { name: /why is this here/i });
      expect(await within(why).findByText(/kept because of the rule “Track GitHub”/i)).toBeTruthy();
      expect(within(why).getByText(/allow, coarsen/)).toBeTruthy();
      expect(within(why).queryByText(/rules have changed/i)).toBeNull();
    });

    it("says so when the rules changed since, or the rule is gone", async () => {
      backend.rules = { version: 5, rules: [] };
      backend.events = [event(0, { trace: trace() })];
      mount("/events");
      const why = await within(await openFirst()).findByRole("region", {
        name: /why is this here/i,
      });
      expect(
        await within(why).findByText(/kept because of the rule “a rule that no longer exists”/i),
      ).toBeTruthy();
      expect(within(why).getByText(/rules have changed since/i)).toBeTruthy();
    });

    it("explains the default policy, and an event without a trace", async () => {
      backend.rules = { version: 2, rules: [] };
      backend.events = [
        event(0, { trace: trace({ matched: [], decidedBy: "default_policy" }) }),
        event(1, { trace: null }),
      ];
      mount("/events");
      const first = await openFirst();
      expect(await within(first).findByText(/default policy/i)).toBeTruthy();
      fireEvent.click(screen.getByRole("button", { name: /open event 2/i }));
      expect(await screen.findByText(/before rules existed/i)).toBeTruthy();
    });

    it("still explains when the rules cannot be loaded", async () => {
      backend.events = [event(0, { trace: trace() })];
      mount("/events", new QueryClient({ defaultOptions: { queries: { retry: false } } }));
      const why = await within(await openFirst()).findByRole("region", {
        name: /why is this here/i,
      });
      expect(within(why).getByText(/kept because of the rule “A rule”/i)).toBeTruthy();
    });
  });

  it("asks for confirmation before deleting, and cancel deletes nothing", async () => {
    backend.events = many(3);
    mount("/events");
    fireEvent.click(await screen.findByRole("checkbox", { name: /select event 1$/i }));
    fireEvent.click(screen.getByRole("button", { name: /delete selected/i }));
    expect(await screen.findByRole("alertdialog")).toBeTruthy();
    fireEvent.click(screen.getByRole("button", { name: /cancel/i }));
    expect(screen.queryByRole("alertdialog")).toBeNull();
    expect(backend.calls.some((c) => c.method === "DELETE")).toBe(false);
  });

  it("deletes the selected events by id after confirmation", async () => {
    backend.events = many(3);
    const [a, , c] = backend.events as [FakeEvent, FakeEvent, FakeEvent];
    mount("/events");
    fireEvent.click(await screen.findByRole("checkbox", { name: /select event 1$/i }));
    fireEvent.click(screen.getByRole("checkbox", { name: /select event 3$/i }));
    expect(screen.getByRole("status").textContent).toMatch(/2 selected/);
    fireEvent.click(screen.getByRole("button", { name: /delete selected/i }));
    fireEvent.click(await screen.findByRole("button", { name: /confirm delete/i }));

    await waitFor(() => expect(rowCount()).toBe(1));
    const del = backend.calls.find((x) => x.method === "DELETE");
    expect(del?.path).toBe("/v1/events");
    expect(del?.body).toEqual({ ids: [a.id, c.id] });
    expect(screen.queryByRole("status")).toBeNull();
  });

  it("never logs", async () => {
    backend.events = many(2);
    mount("/events");
    fireEvent.click(await screen.findByRole("button", { name: /open event 1/i }));
    await screen.findByRole("dialog");
    for (const spy of logSpies) expect(spy).not.toHaveBeenCalled();
  });
});
