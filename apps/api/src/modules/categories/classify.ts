import { type Category, type CategoryRule, PRESET_CATEGORY_DOMAINS } from "@personal-api/contracts";
import { domainMatches } from "@personal-api/rules";

/** A domain is covered by a preset entry when it is that site or one of its subdomains. */
const covers = (entry: string, domain: string): boolean =>
  domain === entry || domain.endsWith(`.${entry}`);

/** An exact pattern is the most specific; among wildcards, the longer one. */
const specificity = (pattern: string): number =>
  pattern.startsWith("*.") ? pattern.length : Number.MAX_SAFE_INTEGER;

/**
 * The category of a domain: the user's most specific override first (an exact pattern beats a
 * wildcard, a longer wildcard beats a shorter one), then the built-in list, else neutral.
 */
export function classify(domain: string, overrides: readonly CategoryRule[]): Category {
  let best: CategoryRule | null = null;
  for (const rule of overrides) {
    if (!domainMatches(rule.pattern, domain)) continue;
    if (best === null || specificity(rule.pattern) > specificity(best.pattern)) best = rule;
  }
  if (best !== null) return best.category;
  if (PRESET_CATEGORY_DOMAINS.productive.some((entry) => covers(entry, domain)))
    return "productive";
  if (PRESET_CATEGORY_DOMAINS.distracting.some((entry) => covers(entry, domain))) {
    return "distracting";
  }
  return "neutral";
}
