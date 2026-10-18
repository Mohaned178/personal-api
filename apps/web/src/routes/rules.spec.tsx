import { cleanup, fireEvent, screen, waitFor, within } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import {
  type FakeBackend,
  type FakeRule,
  installFetch,
  makeBackend,
  mount,
  pathname,
} from "@/test/auth-harness";

const logSpies: ReturnType<typeof vi.spyOn>[] = [];
let backend: FakeBackend;

const GITHUB_ID = "11111111-1111-4111-8111-111111111111";
const ADS_ID = "22222222-2222-4222-8222-222222222222";

const GITHUB: FakeRule = {
  id: GITHUB_ID,
  name: "Track GitHub",
  enabled: true,
  priority: 20,
  stage: "collect",
  when: { all: [{ field: "data.domain", op: "eq", value: "github.com" }] },
  then: [{ action: "allow" }],
};
const ADS: FakeRule = {
  id: ADS_ID,
  name: "Block ads",
  enabled: false,
  priority: 5,
  stage: "collect",
  when: { all: [{ field: "data.domain", op: "domain_matches", value: "*.ads.test" }] },
  then: [{ action: "drop" }],
};

const DIAGNOSTICS = {
  integrations: [],
  ingestion: [],
  drops: { byRule: { [ADS_ID]: 7 }, defaultPolicy: 3 },
};

const rulePosts = () =>
  backend.calls.filter((c) => c.path.startsWith("/v1/rules") && c.method !== "GET");

beforeEach(() => {
  backend = makeBackend({
    authed: true,
    rules: { version: 2, rules: [GITHUB, ADS] },
    diagnostics: DIAGNOSTICS,
  });
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

const changeTo = (label: RegExp | string, value: string) =>
  fireEvent.change(screen.getByLabelText(label), { target: { value } });
const click = (name: RegExp | string) => fireEvent.click(screen.getByRole("button", { name }));

describe("rules page", () => {
  it("redirects a signed-out visitor to /login", async () => {
    backend.authed = false;
    const { router } = mount("/rules");
    await waitFor(() => expect(pathname(router)).toBe("/login"));
  });

  it("explains that nothing is collected when there are no rules", async () => {
    backend.rules = { version: 0, rules: [] };
    mount("/rules");
    expect(await screen.findByText(/no rules yet, so nothing is collected/i)).toBeTruthy();
  });

  describe("starter templates", () => {
    it("offers the templates when there are no rules", async () => {
      backend.rules = { version: 0, rules: [] };
      mount("/rules");
      const region = await screen.findByRole("region", { name: /start from a template/i });
      expect(within(region).getAllByRole("button")).toHaveLength(4);
    });

    it("does not offer them once there are rules", async () => {
      backend.rules = { version: 1, rules: [GITHUB] };
      mount("/rules");
      await screen.findByText("Track GitHub");
      expect(screen.queryByRole("region", { name: /start from a template/i })).toBeNull();
    });

    it("fills the form from a template and saves nothing until asked", async () => {
      backend.rules = { version: 0, rules: [] };
      mount("/rules");
      const region = await screen.findByRole("region", { name: /start from a template/i });
      fireEvent.click(within(region).getByRole("button", { name: /never collect a site/i }));

      expect((screen.getByLabelText(/^name$/i) as HTMLInputElement).value).toBe(
        "Never collect example.com",
      );
      expect(rulePosts()).toHaveLength(0);
      changeTo(/^name$/i, "Never collect ads.test");
      click("Save rule");

      await waitFor(() => expect(rulePosts()).toHaveLength(1));
      expect(rulePosts()[0]).toMatchObject({
        method: "POST",
        path: "/v1/rules",
        body: { name: "Never collect ads.test", priority: 0, then: [{ action: "drop" }] },
      });
    });
  });

  it("lists rules in priority order with their drop counts over seven days", async () => {
    mount("/rules");
    await screen.findByText("Track GitHub");
    const rows = screen.getAllByRole("row").slice(1);
    expect(rows).toHaveLength(2);
    const first = within(rows[0] as HTMLElement);
    expect(first.getByText("Block ads")).toBeTruthy();
    expect(first.getByText("(disabled)")).toBeTruthy();
    expect(first.getByText("7")).toBeTruthy();
    expect(within(rows[1] as HTMLElement).getByText("0")).toBeTruthy();
    expect(screen.getByText(/default policy/i).textContent).toMatch(/3/);
    await waitFor(() => expect(backend.calls.some((c) => c.search === "?hours=168")).toBe(true));
  });

  it("creates a rule from the form", async () => {
    backend.rules = { version: 0, rules: [] };
    mount("/rules");
    fireEvent.click(await screen.findByRole("button", { name: "New rule" }));
    changeTo(/^name$/i, "Track docs");
    changeTo(/^priority/i, "30");
    click(/add “all” condition/i);
    changeTo(/all condition 1 operator/i, "eq");
    changeTo(/all condition 1 value/i, "docs.example.com");
    click("Save rule");

    await waitFor(() => expect(rulePosts()).toHaveLength(1));
    expect(rulePosts()[0]).toMatchObject({
      method: "POST",
      path: "/v1/rules",
      body: {
        name: "Track docs",
        enabled: true,
        priority: 30,
        stage: "collect",
        when: { all: [{ field: "data.domain", op: "eq", value: "docs.example.com" }] },
        then: [{ action: "allow" }],
      },
    });
    expect(await screen.findByText("Track docs")).toBeTruthy();
    expect(screen.queryByRole("region", { name: /new rule/i })).toBeNull();
  });

  it("shows the problems of an invalid rule and sends nothing", async () => {
    mount("/rules");
    fireEvent.click(await screen.findByRole("button", { name: "New rule" }));
    click("Save rule");
    const alert = await screen.findByRole("alert", { name: /problems with this rule/i });
    expect(alert.textContent).toMatch(/name/);
    expect(rulePosts()).toHaveLength(0);
  });

  it("switches to JSON, shows inline errors, and loads valid JSON back into the form", async () => {
    mount("/rules");
    fireEvent.click(await screen.findByRole("button", { name: "New rule" }));
    click("JSON");
    const box = screen.getByLabelText("Rule JSON") as HTMLTextAreaElement;
    expect(JSON.parse(box.value)).toMatchObject({ stage: "collect", enabled: true });

    fireEvent.change(box, { target: { value: "{ nope" } });
    click("Save rule");
    expect((await screen.findByRole("alert", { name: /problems/i })).textContent).toMatch(
      /not valid json/i,
    );
    expect(rulePosts()).toHaveLength(0);

    fireEvent.change(box, {
      target: { value: JSON.stringify({ ...GITHUB, id: undefined, extra: 1 }) },
    });
    click("Form");
    expect((await screen.findByRole("alert", { name: /problems/i })).textContent).toMatch(
      /unrecognized key/i,
    );
    expect(screen.getByLabelText("Rule JSON")).toBeTruthy();

    const { id: _id, ...definition } = GITHUB;
    fireEvent.change(box, { target: { value: JSON.stringify(definition) } });
    click("Form");
    expect(((await screen.findByLabelText(/^name$/i)) as HTMLInputElement).value).toBe(
      "Track GitHub",
    );
    expect((screen.getByLabelText(/all condition 1 value/i) as HTMLInputElement).value).toBe(
      "github.com",
    );
  });

  it("shows the issues the server rejects a rule with", async () => {
    backend.rules = {
      version: 0,
      rules: [],
      rejectWith: [
        { path: ["when", "all", 0, "op"], message: "Operator is not allowed for this field" },
      ],
    };
    mount("/rules");
    fireEvent.click(await screen.findByRole("button", { name: "New rule" }));
    changeTo(/^name$/i, "Server says no");
    click("Save rule");
    const alert = await screen.findByRole("alert", { name: /problems/i });
    expect(alert.textContent).toContain("when.all.0.op");
    expect(alert.textContent).toContain("Operator is not allowed");
  });

  it("tests the draft against a sample event, replacing the rule being edited", async () => {
    (backend.rules as NonNullable<FakeBackend["rules"]>).testResult = {
      decision: "drop",
      trace: { ruleSetVersion: 2, matched: [], decidedBy: ADS_ID },
    };
    mount("/rules");
    fireEvent.click(await screen.findByRole("button", { name: "Edit Track GitHub" }));
    click("Test rule");
    expect((await screen.findByRole("status")).textContent).toMatch(/dropped, decided by rule/i);
    const call = backend.calls.find((c) => c.path === "/v1/rules/test");
    expect(call?.body).toMatchObject({
      source: "browser-extension",
      defaultPolicy: "deny",
      replaceRuleId: GITHUB_ID,
      rule: { name: "Track GitHub", priority: 20 },
      event: { type: "browser.page_visited" },
    });
    expect((call?.body as { onlyRule?: boolean } | undefined)?.onlyRule).toBeUndefined();
  });

  it("refuses to test a sample event that is not JSON", async () => {
    mount("/rules");
    fireEvent.click(await screen.findByRole("button", { name: "Edit Track GitHub" }));
    changeTo("Sample event", "{ nope");
    click("Test rule");
    expect((await screen.findByText(/not valid json/i)).closest("[role=alert]")).toBeTruthy();
    expect(backend.calls.some((c) => c.path === "/v1/rules/test")).toBe(false);
  });

  it("saves an edit with PUT", async () => {
    mount("/rules");
    fireEvent.click(await screen.findByRole("button", { name: "Edit Track GitHub" }));
    changeTo(/^priority/i, "1");
    click("Save rule");
    await waitFor(() => expect(rulePosts()).toHaveLength(1));
    expect(rulePosts()[0]).toMatchObject({
      method: "PUT",
      path: `/v1/rules/${GITHUB_ID}`,
      body: { name: "Track GitHub", priority: 1 },
    });
    expect((rulePosts()[0]?.body as { id?: string } | undefined)?.id).toBeUndefined();
  });

  it("enables and disables a rule from the list", async () => {
    mount("/rules");
    fireEvent.click(await screen.findByRole("button", { name: "Disable Track GitHub" }));
    await waitFor(() => expect(rulePosts()).toHaveLength(1));
    expect(rulePosts()[0]).toMatchObject({ method: "PUT", body: { enabled: false } });
    expect(await screen.findByRole("button", { name: "Enable Track GitHub" })).toBeTruthy();
  });

  it("asks for confirmation before deleting a rule", async () => {
    mount("/rules");
    fireEvent.click(await screen.findByRole("button", { name: "Delete Block ads" }));
    expect(rulePosts()).toHaveLength(0);
    click("Confirm delete Block ads");
    await waitFor(() => expect(screen.queryByText("Block ads")).toBeNull());
    expect(rulePosts()[0]).toMatchObject({ method: "DELETE", path: `/v1/rules/${ADS_ID}` });
  });

  it("logs nothing", async () => {
    mount("/rules");
    await screen.findByText("Track GitHub");
    for (const spy of logSpies) expect(spy).not.toHaveBeenCalled();
  });
});
