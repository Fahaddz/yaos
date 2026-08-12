# Repository Layout

This document defines repository ownership boundaries and generated-output
policy. For runtime behavior boundaries, see [Runtime estates](runtime-estates.md).

## Owned source

```text
src/                Product source only
src/telemetry/      Passive Observer implementation
qa/                 Puppeteer harness, controllers, analyzers, scripts, and fixtures
server/             Cloudflare Worker package and server source
tests/              Node/regression/integration coverage
docs/               Durable tracked project documentation
notes/              Ignored local working notes
```

`qa/fixtures/` may contain Markdown fixture payloads. They are test data, not a
second documentation root.

## Generated output

```text
main.js             Generated Engine bundle
telemetry.js        Generated Observer bundle
dist/               Generated server-release output
qa/**/*.js          Generated QA harness output
qa-runs/            Generated QA traces, manifests, and reports
```

Generated output is never tracked. The release workflow builds artifacts from
source and publishes them. `npm run guard:no-tracked-generated-artifacts`
fails if Git tracks a generated bundle, sourcemap, QA output, or QA run
artifact.

## Build products

```text
npm run build             main.js + telemetry.js
npm run build:qa-product  qa/obsidian-harness/product-main.js
npm run build:harness     qa/obsidian-harness/main.js
npm run build:server-release
                         dist/release-assets/yaos-server.zip + update manifest
```

The plugin release archive contains `main.js`, `telemetry.js`, `manifest.json`,
and `styles.css`. QA source, QA output, QA run artifacts, and scratch release
output are not plugin-package contents.

## Boundary rules

- `src/` must not import `qa/`; `npm run guard:qa-isolation` enforces this.
- Production `main.js` must not contain Observer implementations or Puppeteer
  control capabilities.
- Production `telemetry.js` is a passive Observer bundle and must not contain
  Puppeteer mutation machinery.
- `qa/` may exercise product source through its dedicated QA builds, but it is
  not a shipped runtime.
- Durable documentation belongs under `docs/`; time-bounded material belongs
  under `docs/archive/`; workstation-specific notes belong under ignored
  `notes/`.

## Documentation navigation

Start at the [documentation index](../README.md). The root `README.md` is the
public landing page and links here; it is not a second engineering-documents
tree.
