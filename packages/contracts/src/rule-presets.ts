import { domainSchema } from "./primitives.js";
import { RULE_LIMITS, type RuleCondition, type RuleDefinition } from "./rules.js";

/**
 * Starting rule sets for the dashboard's setup wizard (M8-02). A preset is plain data: the wizard
 * saves each rule through `POST /v1/rules`, so the server validates it like any other rule.
 *
 * `*.example.com` does not match `example.com` itself, so every domain becomes two conditions,
 * and one `any` group (at most `RULE_LIMITS.conditionsMax` conditions) holds at most
 * `PRESET_DOMAINS_PER_RULE` domains.
 */

export const PRESET_DOMAINS_PER_RULE = RULE_LIMITS.conditionsMax / 2;

/** Priority of the catch-all allow: last, so every other rule (the drops first) decides before it. */
export const ALLOW_ALL_PRIORITY = RULE_LIMITS.priorityMax;

/** Priority of the allow rules of the "work sites" and "choose sites" presets. */
export const PRESET_ALLOW_PRIORITY = 100;

/** Sites the "everything except sensitive sites" preset never collects, by category. */
export const SENSITIVE_DOMAINS = {
  banking: [
    "paypal.com",
    "chase.com",
    "bankofamerica.com",
    "wellsfargo.com",
    "citi.com",
    "capitalone.com",
    "hsbc.com",
    "barclays.co.uk",
    "revolut.com",
    "wise.com",
  ],
  health: [
    "webmd.com",
    "mayoclinic.org",
    "healthline.com",
    "nhs.uk",
    "zocdoc.com",
    "goodrx.com",
    "betterhelp.com",
    "talkspace.com",
    "cvs.com",
    "walgreens.com",
  ],
  email: [
    "mail.google.com",
    "outlook.live.com",
    "outlook.office.com",
    "mail.yahoo.com",
    "proton.me",
    "icloud.com",
    "fastmail.com",
    "mail.zoho.com",
    "gmx.com",
    "mail.aol.com",
  ],
  adult: [
    "pornhub.com",
    "xvideos.com",
    "xnxx.com",
    "xhamster.com",
    "onlyfans.com",
    "chaturbate.com",
    "redtube.com",
    "youporn.com",
    "stripchat.com",
    "spankbang.com",
  ],
} as const satisfies Record<string, readonly string[]>;

export type SensitiveCategory = keyof typeof SENSITIVE_DOMAINS;

const SENSITIVE_LABELS: Record<SensitiveCategory, string> = {
  banking: "banking and payments",
  health: "health",
  email: "email",
  adult: "adult",
};

/** The "only work sites" allow list. */
export const WORK_DOMAINS = [
  "github.com",
  "gitlab.com",
  "stackoverflow.com",
  "atlassian.net",
  "slack.com",
  "notion.so",
  "figma.com",
  "linear.app",
  "docs.google.com",
  "developer.mozilla.org",
] as const;

/** `domain_matches` on the domain and on its subdomains. */
function domainConditions(domains: readonly string[]): RuleCondition[] {
  return domains.flatMap((value) => [
    { field: "data.domain", op: "domain_matches", value },
    { field: "data.domain", op: "domain_matches", value: `*.${value}` },
  ]);
}

function domainRule(
  name: string,
  priority: number,
  action: "allow" | "drop",
  domains: readonly string[],
): RuleDefinition {
  return {
    name,
    enabled: true,
    priority,
    stage: "collect",
    when: { any: domainConditions(domains) },
    then: [{ action }],
  };
}

export const RULE_PRESET_IDS = ["all-but-sensitive", "work-sites", "choose-sites"] as const;
export type RulePresetId = (typeof RULE_PRESET_IDS)[number];

export interface RulePreset {
  id: RulePresetId;
  title: string;
  description: string;
}

export const RULE_PRESETS: readonly RulePreset[] = [
  {
    id: "all-but-sensitive",
    title: "Everything except sensitive sites",
    description:
      "Collect every site, but never banking, health, email or adult sites. You can add more blocks later.",
  },
  {
    id: "work-sites",
    title: "Only work sites",
    description: `Collect only common work tools: ${WORK_DOMAINS.join(", ")}.`,
  },
  {
    id: "choose-sites",
    title: "Choose sites",
    description: `Type the sites to collect (up to ${PRESET_DOMAINS_PER_RULE}). Nothing else is kept.`,
  },
];

/** "Everything except sensitive sites": a drop rule per category, then allow everything else. */
export function allButSensitiveRules(): RuleDefinition[] {
  const drops = (Object.keys(SENSITIVE_DOMAINS) as SensitiveCategory[]).map((category, index) =>
    domainRule(
      `Never collect ${SENSITIVE_LABELS[category]} sites`,
      10 + index,
      "drop",
      SENSITIVE_DOMAINS[category],
    ),
  );
  // An empty `when` matches every event, so this needs no new operator (PLAN M8-02).
  const allowAll: RuleDefinition = {
    name: "Collect everything else",
    enabled: true,
    priority: ALLOW_ALL_PRIORITY,
    stage: "collect",
    when: {},
    then: [{ action: "allow" }],
  };
  return [...drops, allowAll];
}

export function workSitesRules(): RuleDefinition[] {
  return [domainRule("Collect work sites", PRESET_ALLOW_PRIORITY, "allow", WORK_DOMAINS)];
}

/**
 * "Choose sites": one allow rule for the given domains. Returns `null` when the list is empty,
 * too long, or holds anything that is not a lowercase hostname, so nothing invalid is ever sent.
 */
export function chooseSitesRules(domains: readonly string[]): RuleDefinition[] | null {
  const unique = [...new Set(domains)];
  if (unique.length === 0 || unique.length > PRESET_DOMAINS_PER_RULE) return null;
  if (!unique.every((domain) => domainSchema.safeParse(domain).success)) return null;
  return [domainRule("Collect chosen sites", PRESET_ALLOW_PRIORITY, "allow", unique)];
}
