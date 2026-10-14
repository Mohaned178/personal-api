// The package is "type": "module", so Node would read the CommonJS build in dist/cjs as ESM.
// This marker makes dist/cjs/*.js (and its .d.ts files) CommonJS for Node and TypeScript.
import { writeFileSync } from "node:fs";

writeFileSync(
  new URL("../dist/cjs/package.json", import.meta.url),
  `${JSON.stringify({ type: "commonjs" }, null, 2)}\n`,
);
