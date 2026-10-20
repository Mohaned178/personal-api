# Building the browser extension from source

This page is for reviewers of the Firefox add-on (AMO) and for anyone who wants to rebuild the
extension from the source zip. The source zip contains the whole repository root (minus generated
output, dependencies and local data), because the extension imports the workspace packages
`@personal-api/contracts` and `@personal-api/rules`.

## Requirements

- Node.js 24 (`.nvmrc` pins the major; the release build was run with 24.21.0).
- pnpm 11.28.2, the version in the root `packageManager` field. `corepack enable` provides it.

## Steps

From the repository root:

```bash
pnpm install --frozen-lockfile
pnpm --filter @personal-api/contracts --filter @personal-api/rules build
pnpm --filter extension build:firefox
```

The unpacked add-on is written to `apps/extension/.output/firefox-mv3/`. The Firefox build is the
primary target; the Edge build is `pnpm --filter extension build:chrome`, written to
`apps/extension/.output/chrome-mv3/`.

To produce the store zips the same way the release is packaged:

```bash
pnpm --filter extension zip:firefox   # firefox-mv3 zip plus the sources zip
pnpm --filter extension zip:chrome    # chrome-mv3 zip (Edge Add-ons)
```

The extension is a Manifest V3 add-on. Its build does not run any server code and contains no
content scripts. It only talks to the server the user configures in the popup.
