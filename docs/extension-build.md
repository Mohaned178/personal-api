# Building the browser extension from source

This page is for reviewers of the Firefox add-on (AMO) and for anyone who wants to rebuild the
extension from the source zip. The source zip contains the whole repository root (minus generated
output, dependencies, local data and `.env` files at any depth), because the extension imports the
workspace packages `@personal-api/contracts` and `@personal-api/rules`.

## Requirements

- Node.js 24.21.0, the exact version the release was built with. The sources zip does not contain
  `.nvmrc`, so use this number, not the file.
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

To produce the store zips the same way the release is packaged, build them from a clean checkout
of the release tag, never from a working copy that has been used for development (local data or
`.env` files in it could end up in the sources zip). A `git archive` of the tag is such a checkout:

```bash
mkdir release && git archive --format=tar --prefix=personal-api/ v1.0.0 | tar -x -C release
cd release/personal-api
pnpm install --frozen-lockfile
pnpm --filter @personal-api/contracts --filter @personal-api/rules build
```

Then, in that folder:

```bash
pnpm --filter extension zip:firefox   # firefox-mv3 zip plus the sources zip
pnpm --filter extension zip:chrome    # chrome-mv3 zip (Edge Add-ons)
```

The extension is a Manifest V3 add-on. Its build does not run any server code and contains no
content scripts. It only talks to the server the user configures in the popup.
