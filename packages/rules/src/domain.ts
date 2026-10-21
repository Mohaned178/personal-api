/**
 * Whether `domain` (a lowercase hostname) matches `pattern`: `*.example.com` is any subdomain,
 * never the apex; a bare domain matches exactly. The `domain_matches` rule op and the daily site
 * limits (M9-02) share this one definition.
 */
export function domainMatches(pattern: string, domain: string): boolean {
  return pattern.startsWith("*.") ? domain.endsWith(pattern.slice(1)) : domain === pattern;
}
