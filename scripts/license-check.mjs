// Fails when a production dependency of the API has a license outside the allowlist.
// Reads `pnpm licenses list --json` for the API package, so run it after `pnpm install`.
// Package names are printed; nothing else about the install is.
import { execSync } from "node:child_process";

const ALLOWED = new Set([
  "0BSD",
  "Apache-2.0",
  "BSD-2-Clause",
  "BSD-3-Clause",
  "BlueOak-1.0.0",
  "CC0-1.0",
  "ISC",
  "MIT",
  // argparse, a transitive dependency of the API. Permissive, with no copyleft terms.
  "Python-2.0",
]);

const output = execSync("pnpm --filter @personal-api/api licenses list --prod --json", {
  encoding: "utf8",
  stdio: ["ignore", "pipe", "ignore"],
});
// pnpm may print a shell banner before the JSON; the document starts at the first brace.
const byLicense = JSON.parse(output.slice(output.indexOf("{")));

const violations = [];
let checked = 0;
for (const [license, packages] of Object.entries(byLicense)) {
  checked += packages.length;
  // Expressions such as "(MIT OR CC0-1.0)" pass only when every term is allowed.
  const terms = license.split(/\s+(?:OR|AND|WITH)\s+|[()]/).filter(Boolean);
  if (!terms.every((term) => ALLOWED.has(term))) {
    for (const pkg of packages) violations.push(`${pkg.name} (${license})`);
  }
}

if (violations.length > 0) {
  console.error(`License check failed for ${violations.length} production package(s):`);
  for (const line of violations) console.error(`  ${line}`);
  process.exit(1);
}
console.log(`License check passed: ${checked} production packages use allowed licenses.`);
