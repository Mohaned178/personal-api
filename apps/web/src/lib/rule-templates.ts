import type { RuleDefinition } from "@personal-api/contracts";

/**
 * Starter rules for the Rules page. A template only fills the form: nothing is saved until the
 * user replaces the placeholder domain and presses save. Each one is a valid `RuleDefinition`
 * (the spec checks them against the contracts' schema).
 */
export interface RuleTemplate {
  id: string;
  title: string;
  description: string;
  rule: RuleDefinition;
}

const SITE = { field: "data.domain", op: "domain_matches", value: "example.com" } as const;
/** `*.example.com` does not match `example.com` itself, so a block needs both (rule-format.md). */
const SUBDOMAINS = { ...SITE, value: "*.example.com" } as const;

export const RULE_TEMPLATES: readonly RuleTemplate[] = [
  {
    id: "collect-site",
    title: "Collect one site",
    description: "Keep visits and time on one site. Replace example.com with the site you want.",
    rule: {
      name: "Collect example.com",
      enabled: true,
      priority: 100,
      stage: "collect",
      when: { source: ["browser-extension"], type: ["browser.*"], all: [SITE] },
      then: [{ action: "allow" }],
    },
  },
  {
    id: "collect-site-domain-only",
    title: "Collect a site, domain only",
    description: "Keep that you visited the site, but not which pages (the path is cut to “/”).",
    rule: {
      name: "Collect example.com, domain only",
      enabled: true,
      priority: 100,
      stage: "collect",
      when: { source: ["browser-extension"], type: ["browser.*"], all: [SITE] },
      then: [{ action: "allow" }, { action: "coarsen", segments: 0 }],
    },
  },
  {
    id: "collect-site-not-account",
    title: "Collect a site, but not account pages",
    description: "Keep the site except anything under /account or /settings.",
    rule: {
      name: "Collect example.com except account pages",
      enabled: true,
      priority: 100,
      stage: "collect",
      when: {
        source: ["browser-extension"],
        type: ["browser.*"],
        all: [SITE],
        none: [
          { field: "data.path", op: "starts_with", value: "/account" },
          { field: "data.path", op: "starts_with", value: "/settings" },
        ],
      },
      then: [{ action: "allow" }],
    },
  },
  {
    id: "never-site",
    title: "Never collect a site",
    description:
      "Drop everything from a site and its subdomains, even if another rule would allow it.",
    rule: {
      name: "Never collect example.com",
      enabled: true,
      priority: 0,
      stage: "collect",
      when: { any: [SITE, SUBDOMAINS] },
      then: [{ action: "drop" }],
    },
  },
];
