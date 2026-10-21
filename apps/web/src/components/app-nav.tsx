import { Link } from "@tanstack/react-router";

/**
 * Grouped navigation (M8-03). Export has no dashboard screen yet (API-only, see docs/api.md), so the
 * Data group lists only Events and Retention until it gets one.
 */
const NAV = [
  { label: "Insights", to: "/" },
  { label: "Rules", to: "/rules" },
  { label: "Patterns", to: "/patterns" },
  { label: "Limits", to: "/limits" },
  {
    label: "Sources",
    links: [
      { label: "Integrations", to: "/integrations" },
      { label: "Health", to: "/health" },
    ],
  },
  {
    label: "Data",
    links: [
      { label: "Events", to: "/events" },
      { label: "Retention", to: "/retention" },
    ],
  },
  { label: "Settings", to: "/settings" },
] as const;

const linkClass = "text-sm hover:underline";

export function AppNav() {
  return (
    <nav aria-label="Main" className="flex flex-wrap gap-x-8 gap-y-3">
      {NAV.map((item) =>
        "links" in item ? (
          <section key={item.label} aria-label={item.label} className="flex flex-col gap-1">
            <h2 className="text-xs font-medium uppercase tracking-wide text-muted-foreground">
              {item.label}
            </h2>
            {item.links.map((link) => (
              <Link key={link.to} to={link.to} className={linkClass}>
                {link.label}
              </Link>
            ))}
          </section>
        ) : (
          <Link
            key={item.to}
            to={item.to}
            className={`${linkClass} font-medium`}
            activeOptions={{ exact: true }}
            activeProps={{ "aria-current": "page" }}
          >
            {item.label}
          </Link>
        ),
      )}
    </nav>
  );
}
