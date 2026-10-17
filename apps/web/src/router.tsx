import type { RouterHistory } from "@tanstack/react-router";
import { createRootRoute, createRoute, createRouter, redirect } from "@tanstack/react-router";
import { fetchIsAuthenticated, fetchSetupStatus } from "@/lib/auth";
import { RootLayout } from "@/routes/__root";
import { LoginPage, SetupPage, SignupPage } from "@/routes/auth-pages";
import { IndexPage } from "@/routes/index";
import { IntegrationsPage } from "@/routes/integrations-page";

/**
 * File-less, code-based routes on purpose: no codegen step, so `vite build` and `vitest` need no
 * plugin or generated `routeTree.gen.ts`. Later tasks add routes here or under src/routes/.
 *
 * Guards run on every navigation and fail closed: a failed session check means signed out, and an
 * unknown setup status means "no setup, signup closed". They are UX only; the API enforces auth.
 */
const rootRoute = createRootRoute({ component: RootLayout });

async function redirectIfAuthenticated(): Promise<void> {
  if (await fetchIsAuthenticated()) throw redirect({ to: "/" });
}

async function requireAuth(): Promise<void> {
  if (await fetchIsAuthenticated()) return;
  const status = await fetchSetupStatus();
  throw redirect({ to: status?.needsSetup ? "/setup" : "/login" });
}

const indexRoute = createRoute({
  getParentRoute: () => rootRoute,
  path: "/",
  beforeLoad: requireAuth,
  component: IndexPage,
});

const integrationsRoute = createRoute({
  getParentRoute: () => rootRoute,
  path: "/integrations",
  beforeLoad: requireAuth,
  component: IntegrationsPage,
});

const loginRoute = createRoute({
  getParentRoute: () => rootRoute,
  path: "/login",
  beforeLoad: async () => {
    await redirectIfAuthenticated();
    const status = await fetchSetupStatus();
    if (status?.needsSetup) throw redirect({ to: "/setup" });
    return { signupOpen: status?.signupOpen === true };
  },
  component: function Login() {
    return <LoginPage signupOpen={loginRoute.useRouteContext().signupOpen} />;
  },
});

const signupRoute = createRoute({
  getParentRoute: () => rootRoute,
  path: "/signup",
  beforeLoad: async () => {
    await redirectIfAuthenticated();
    const status = await fetchSetupStatus();
    if (!status?.signupOpen) throw redirect({ to: "/login" });
  },
  component: SignupPage,
});

const setupRoute = createRoute({
  getParentRoute: () => rootRoute,
  path: "/setup",
  beforeLoad: async () => {
    await redirectIfAuthenticated();
    const status = await fetchSetupStatus();
    if (!status?.needsSetup) throw redirect({ to: "/login" });
  },
  component: SetupPage,
});

export const routeTree = rootRoute.addChildren([
  indexRoute,
  integrationsRoute,
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
