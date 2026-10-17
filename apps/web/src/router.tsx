import type { RouterHistory } from "@tanstack/react-router";
import { createRootRoute, createRoute, createRouter } from "@tanstack/react-router";
import { RootLayout } from "@/routes/__root";
import { IndexPage } from "@/routes/index";

/**
 * File-less, code-based routes on purpose: no codegen step, so `vite build` and `vitest` need no
 * plugin or generated `routeTree.gen.ts`. M3-02 and later add routes here or under src/routes/.
 */
const rootRoute = createRootRoute({ component: RootLayout });

const indexRoute = createRoute({
  getParentRoute: () => rootRoute,
  path: "/",
  component: IndexPage,
});

export const routeTree = rootRoute.addChildren([indexRoute]);

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
