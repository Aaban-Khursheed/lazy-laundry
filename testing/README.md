Status: INSTALLED. Files below are present; runtime acceptance is recorded per run, not claimed from this document.

## 5. Project Layout and Run Contract

Proposed additions:

```text
testing/
  README.md
  profile.json
  wrangler.test.jsonc
  vitest.config.mjs
  playwright.config.mjs
  runtime/
    harness.mjs
    outbound.mjs
    serve.mjs
  health/
    worker.test.js
    browser.spec.js
    health.k6.js
test-results/infra/<run-id>/
  manifest.json
  runtime.json
  proxy.json
  versions.txt
  source.txt
  migrations.txt
  server.log
  toxiproxy.log
  k6-a.ndjson
  k6-b.ndjson
  readiness.json
```

The artifact directory is already covered by the repository's `test-results/`
ignore rule. Never store tracking credentials, request bodies, or private
customer records in these artifacts.

Each invocation owns a unique run ID, disposable storage, process list, proxy
name, and result directory. An unrecorded process/resource is not owned and
must not be killed, reset, or deleted.

Suggested command mappings (additive package.json scripts after approval):

```json
{
  "test:infra": "vitest run --config testing/vitest.config.mjs",
  "pretest:e2e:infra": "npm run build:ui",
  "test:e2e:infra": "playwright test --config testing/playwright.config.mjs"
}
```

No Jest, PyTest, Workers adapter, or MSW installation is required initially.
Do not run `npm ci` merely to add this infrastructure when installed dependencies
already satisfy the lockfile. A clean checkout may use `npm ci` after permission
to install dependencies; inspect the resulting environment before verification.
