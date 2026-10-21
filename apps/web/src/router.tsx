import type { RouterHistory } from "@tanstack/react-router";
import { createRootRoute, createRoute, createRouter, redirect } from "@tanstack/react-router";
import { fetchIsAuthenticated, fetchSetupStatus } from "@/lib/auth";
import { safeRedirect } from "@/lib/safe-redirect";
import { isWelcomeDone, needsWelcome } from "@/lib/welcome";
import { RootLayout } from "@/routes/__root";
import { LoginPage, SetupPage, SignupPage } from "@/routes/auth-pages";
import { ConnectExtensionDonePage, ConnectExtensionPage } from "@/routes/connect-extension-page";
import { EventsPage } from "@/routes/events-page";
import { HealthPage } from "@/routes/health-page";
import { IndexPage } from "@/routes/index";
import { IntegrationsPage } from "@/routes/integrations-page";
import { LimitsPage } from "@/routes/limits-page";
import { PatternsPage } from "@/routes/patterns-page";
import { RetentionPage } from "@/routes/retention-page";
import { RulesPage } from "@/routes/rules-page";
import { SettingsPage } from "@/routes/settings-page";
import { SitePage } from "@/routes/site-page";
import { WelcomePage } from "@/routes/welcome-page";

/**
 * File-less, code-based routes on purpose: no codegen step, so `vite build` and `vitest` need no
 * plugin or generated `routeTree.gen.ts`. Later tasks add routes here or under src/routes/.
 *
 * Guards run on every navigation and fail closed: a failed session check means signed out, and an
 * unknown setup status means "no setup, signup closed". They are UX only; the API enforces auth.
 */
const rootRoute = createRootRoute({ component: RootLayout });

/**
 * The search of the auth pages: `redirect` survives only as an internal path (`safeRedirect`).
 * Always set, `undefined` when refused: the router merges the raw search of the root route into
 * the validated one, so leaving the key out would let the unchecked value through.
 */
type AuthSearch = { redirect?: string | undefined };
function validateAuthSearch(search: Record<string, unknown>): AuthSearch {
  return { redirect: safeRedirect(search.redirect) };
}

async function redirectIfAuthenticated(search: AuthSearch): Promise<void> {
  if (!(await fetchIsAuthenticated())) return;
  throw search.redirect === undefined ? redirect({ to: "/" }) : redirect({ href: search.redirect });
}

/** Signed out: to login (or first-run setup), remembering the page to come back to (M8-01). */
async function requireAuth({ location }: { location: { href: string } }): Promise<void> {
  if (await fetchIsAuthenticated()) return;
  const status = await fetchSetupStatus();
  const back = safeRedirect(location.href);
  const search = back === undefined || back === "/" ? {} : { redirect: back };
  throw redirect({ to: status?.needsSetup ? "/setup" : "/login", search });
}

/** Home sends a new user to the setup wizard once (M8-02): no active integration or no rule yet. */
const indexRoute = createRoute({
  getParentRoute: () => rootRoute,
  path: "/",
  beforeLoad: async (ctx) => {
    await requireAuth(ctx);
    if (!isWelcomeDone() && (await needsWelcome())) throw redirect({ to: "/welcome" });
  },
  component: IndexPage,
});

const welcomeRoute = createRoute({
  getParentRoute: () => rootRoute,
  path: "/welcome",
  beforeLoad: async (ctx) => {
    await requireAuth(ctx);
    if (isWelcomeDone()) throw redirect({ to: "/" });
  },
  component: WelcomePage,
});

const integrationsRoute = createRoute({
  getParentRoute: () => rootRoute,
  path: "/integrations",
  beforeLoad: requireAuth,
  component: IntegrationsPage,
});

const eventsRoute = createRoute({
  getParentRoute: () => rootRoute,
  path: "/events",
  beforeLoad: requireAuth,
  component: EventsPage,
});

const healthRoute = createRoute({
  getParentRoute: () => rootRoute,
  path: "/health",
  beforeLoad: requireAuth,
  component: HealthPage,
});

const limitsRoute = createRoute({
  getParentRoute: () => rootRoute,
  path: "/limits",
  beforeLoad: requireAuth,
  component: LimitsPage,
});

const patternsRoute = createRoute({
  getParentRoute: () => rootRoute,
  path: "/patterns",
  beforeLoad: requireAuth,
  component: PatternsPage,
});

const siteRoute = createRoute({
  getParentRoute: () => rootRoute,
  path: "/sites/$domain",
  beforeLoad: requireAuth,
  component: SitePage,
});

const retentionRoute = createRoute({
  getParentRoute: () => rootRoute,
  path: "/retention",
  beforeLoad: requireAuth,
  component: RetentionPage,
});

const rulesRoute = createRoute({
  getParentRoute: () => rootRoute,
  path: "/rules",
  beforeLoad: requireAuth,
  component: RulesPage,
});

const settingsRoute = createRoute({
  getParentRoute: () => rootRoute,
  path: "/settings",
  beforeLoad: requireAuth,
  component: SettingsPage,
});

const connectExtensionRoute = createRoute({
  getParentRoute: () => rootRoute,
  path: "/connect-extension",
  beforeLoad: requireAuth,
  component: ConnectExtensionPage,
});

/**
 * No guard: the page holds no account data, only the code in its own fragment, which a redirect to
 * login would lose. The extension's background reads the code from this tab's URL.
 */
const connectExtensionDoneRoute = createRoute({
  getParentRoute: () => rootRoute,
  path: "/connect-extension/done",
  component: ConnectExtensionDonePage,
});

const loginRoute = createRoute({
  getParentRoute: () => rootRoute,
  path: "/login",
  validateSearch: validateAuthSearch,
  beforeLoad: async ({ search }) => {
    await redirectIfAuthenticated(search);
    const status = await fetchSetupStatus();
    if (status?.needsSetup) throw redirect({ to: "/setup", search });
    return { signupOpen: status?.signupOpen === true };
  },
  component: function Login() {
    return (
      <LoginPage
        signupOpen={loginRoute.useRouteContext().signupOpen}
        redirect={loginRoute.useSearch().redirect}
      />
    );
  },
});

const signupRoute = createRoute({
  getParentRoute: () => rootRoute,
  path: "/signup",
  validateSearch: validateAuthSearch,
  beforeLoad: async ({ search }) => {
    await redirectIfAuthenticated(search);
    const status = await fetchSetupStatus();
    if (!status?.signupOpen) throw redirect({ to: "/login", search });
  },
  component: function Signup() {
    return <SignupPage redirect={signupRoute.useSearch().redirect} />;
  },
});

const setupRoute = createRoute({
  getParentRoute: () => rootRoute,
  path: "/setup",
  validateSearch: validateAuthSearch,
  beforeLoad: async ({ search }) => {
    await redirectIfAuthenticated(search);
    const status = await fetchSetupStatus();
    if (!status?.needsSetup) throw redirect({ to: "/login", search });
  },
  component: function Setup() {
    return <SetupPage redirect={setupRoute.useSearch().redirect} />;
  },
});

export const routeTree = rootRoute.addChildren([
  indexRoute,
  welcomeRoute,
  integrationsRoute,
  eventsRoute,
  healthRoute,
  retentionRoute,
  patternsRoute,
  siteRoute,
  limitsRoute,
  rulesRoute,
  settingsRoute,
  connectExtensionRoute,
  connectExtensionDoneRoute,
  loginRoute,
  signupRoute,
  setupRoute,
]);

/** `history` is only passed in tests (a memory history); the app uses the browser default. */
export function createAppRouter(history?: RouterHistory) {
  return history ? createRouter({ routeTree, history }) : createRouter({ routeTree });
}

export const appRouter = createAppRouter();

declare module "@tanstack/react-router" {
  interface Register {
    router: typeof appRouter;
  }
}
