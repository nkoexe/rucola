# Single production environment cleanup plan

## Goal

Rucola should have one deployed environment only:

```text
https://rucola.njco.dev
        |
        v
   rucola-cloud
        |
   +----+----+
   |         |
rucola   rucola-media
  D1          R2
```

There should be no separate deployed development Worker, development hostname, development D1/R2 resources, development rate-limit namespace, or GitHub Actions environment named dev.

Local development and isolated test resources remain allowed. The local Wrangler configuration is not a second deployed environment and should stay available for Worker unit/integration testing.

## Current inventory

The remaining separate-environment references are concentrated in:

- src/cloud/config.ts: defaults the app to https://dev.rucola.njco.dev, exposes CLOUD_ENVIRONMENT = 'dev', and supports EXPO_PUBLIC_RUCOLA_CLOUD_URL.
- cloud/worker/scripts/render-deploy-config.mjs: models dev and production resources, selects via RUCOLA_DEPLOY_ENV, and conditionally configures hostname/static assets.
- cloud/worker/README.md: documents two remote environments and separate bootstrap/deploy commands.
- .github/workflows/cloud-worker.yml: attaches the validation job to the GitHub Actions environment dev.
- docs/WEBSITE.md: documents both rucola.njco.dev and dev.rucola.njco.dev.
- docs/ONLINE_PROTOTYPE_PLAN.md: still describes validation against the dev backend / dev Worker and a dev-test build.
- docs/CLOUD_IMPLEMENTATION_STATUS.md: still describes physical validation against the dev Worker.
- docs/DEVELOPMENT_ROADMAP.md: contains dev-test wording for the online prototype.
- src/cloud/__tests__/CloudClient.test.mjs: contains a dev Worker service name in a mocked health response; this is fixture data, but should be renamed while cleaning terminology.

The local/test-only cloud/worker/wrangler.jsonc uses rucola-local / rucola-media-local. Keep it: it is local-only test configuration, not a remote environment.

## Target application contract

The mobile app should always use:

    https://rucola.njco.dev

Recommended change:

- remove DEV_CLOUD_BASE_URL;
- remove CLOUD_ENVIRONMENT;
- remove EXPO_PUBLIC_RUCOLA_CLOUD_URL as a runtime endpoint override;
- make getCloudBaseUrl() return the single production URL;
- keep CloudClient baseUrl injection for tests/mocks.

This prevents runtime configuration from silently selecting another deployed backend while preserving testability.

Before merging, search for consumers of CLOUD_ENVIRONMENT and EXPO_PUBLIC_RUCOLA_CLOUD_URL; current repository search shows no consumers outside src/cloud/config.ts.

## Target Worker/deployment contract

Simplify cloud/worker/scripts/render-deploy-config.mjs into a production-only deployment renderer.

It should:

- remove the dev resource object;
- remove RUCOLA_DEPLOY_ENV;
- always generate Worker rucola-cloud;
- always use route rucola.njco.dev;
- always use D1 rucola;
- always use R2 rucola-media;
- always use production rate-limit namespace 910002;
- always include static assets directory ../site;
- continue accepting RUCOLA_D1_DATABASE_ID;
- continue accepting optional RUCOLA_ANDROID_APP_LINK_FINGERPRINTS;
- continue writing ignored .wrangler.deploy.jsonc.

The deployment command becomes a single production sequence with no environment selector:

```bash
RUCOLA_D1_DATABASE_ID="<PRODUCTION_D1_UUID>" \
RUCOLA_ANDROID_APP_LINK_FINGERPRINTS="<FINGERPRINTS>" \
npm run render:deploy-config

npx wrangler d1 migrations apply rucola \
  --remote \
  --config .wrangler.deploy.jsonc

npx wrangler deploy \
  --config .wrangler.deploy.jsonc \
  --strict
```

## CI changes

.github/workflows/cloud-worker.yml is validation-only and must remain validation-only.

Remove:

    environment: dev

The workflow currently reads CLOUDFLARE_ACCOUNT_ID and CLOUDFLARE_API_TOKEN from GitHub Actions secrets.

Before removing the GitHub dev Environment, verify where those secrets are stored.

If they exist only as environment-scoped secrets, move them to repository-level Actions secrets (or another deliberately selected non-environment secret location) and verify the validation workflow still authenticates successfully.

Do not introduce deployment credentials or deployment steps into CI.

## Documentation changes

### cloud/worker/README.md

Replace the remote environment table with a single production resource table.
Remove all dev bootstrap/deploy commands and RUCOLA_DEPLOY_ENV.
Keep npm run dev because that is a local test server, not a deployed environment.

### docs/WEBSITE.md

Keep the production routing contract:

- / -> landing page
- /<five emojis> -> pairing fallback
- /v1/* -> API
- /.well-known/assetlinks.json -> App Links response
- /health and /health/schema -> Worker health

Remove the development hostname entirely.
The verification section should test only rucola.njco.dev.

### docs/ONLINE_PROTOTYPE_PLAN.md

Replace dev-backend/dev-Worker language with production backend language.
The online prototype is now tested against https://rucola.njco.dev.
Rename dev-test APK wording where it only means a debug/test build; use neutral wording unless a debug/release distinction is actually relevant.

### docs/CLOUD_IMPLEMENTATION_STATUS.md

Replace validation-against-dev-Worker language with production backend validation.
Keep local/runtime terminology where it refers to a local test process rather than a remote environment.

### docs/DEVELOPMENT_ROADMAP.md

Remove remote-dev terminology from the online prototype milestone.
The target should be two real devices using the production Rucola cloud endpoint.

### Tests

Update fixture-only service names such as rucola-cloud-dev to rucola-cloud where the fixture is intended to model the real service.
Do not change tests whose only purpose is to use arbitrary/mock URLs.

## Cloudflare resource retirement

This must happen only after the application and documentation changes are merged and the production endpoint is confirmed healthy.

Retire the old remote environment in this order:

1. Stop all client/default references to dev.rucola.njco.dev.
2. Confirm production app flows, pairing, API, website, migrations, health checks, and App Links are working.
3. Merge the single-environment implementation.
4. Confirm CI passes without the GitHub dev Environment dependency.
5. Remove the dev.rucola.njco.dev Custom Domain/DNS attachment from Cloudflare.
6. Delete the old rucola-cloud-dev Worker.
7. Delete the old rucola-dev D1 database after confirming it contains no data that must be retained.
8. Delete the old rucola-media-dev R2 bucket after confirming it contains no data that must be retained.
9. Retire rate-limit namespace 910001 if Cloudflare's supported management path allows deletion; otherwise leave it unused and remove every repository reference.
10. Remove the GitHub Actions dev Environment after confirming no workflow still references it and required secrets have been migrated.
11. Perform a repository-wide search for the old hostname/resource names and environment selector.

The old D1/R2 resources are disposable development resources; no production data should be migrated from them.

## Validation matrix

### Repository

Run searches that should return zero operational references outside this plan/history:

```bash
git grep -n 'dev\.rucola\.njco\.dev'
git grep -n 'rucola-cloud-dev'
git grep -n 'rucola-dev'
git grep -n 'rucola-media-dev'
git grep -n 'RUCOLA_DEPLOY_ENV'
git grep -n 'CLOUD_ENVIRONMENT'
git grep -n 'EXPO_PUBLIC_RUCOLA_CLOUD_URL'
git grep -n 'environment: dev'
```

Generic development terminology and local commands such as npm run dev are not failures by themselves.

### Mobile

Run:

```bash
npm run typecheck
npm run test:domain
npm run test:cloud-client
npm run test:crypto
npm run test:sync-engine
```

Verify a fresh app build resolves the cloud endpoint to https://rucola.njco.dev.

### Worker

Run:

```bash
cd cloud/worker
npm ci
npm run typecheck
npm test
```

Render the production config and inspect .wrangler.deploy.jsonc:

- Worker name = rucola-cloud
- route = rucola.njco.dev
- D1 = rucola
- R2 = rucola-media
- assets = ../site
- no dev resource/config branch exists

Then verify:

```text
GET https://rucola.njco.dev/
GET https://rucola.njco.dev/health
GET https://rucola.njco.dev/health/schema
GET https://rucola.njco.dev/.well-known/assetlinks.json
```

Verify a real five-emoji pairing path still reaches the pairing flow.

### Physical validation

Use two real Android devices against rucola.njco.dev:

- create pairing;
- join using five emojis;
- join using the HTTPS share link;
- exchange TEXT and EMOJI;
- restart both apps;
- verify retry/reconnect behavior;
- verify reset/unpair cleanup.

The production backend is now the only remote test target.

## Rollback

Before deleting the old remote resources, keep their Cloudflare identifiers and deletion timestamps in the PR/Cloudflare audit trail.

If implementation validation fails:

- do not delete the old dev resources yet;
- revert the single-environment code/documentation changes;
- restore the previous production deployment;
- investigate while the old environment remains available.

Once production validation passes, remote-dev resource deletion is permanent and should not be used as a rollback mechanism.

## Completion criteria

The cleanup is complete when:

- the mobile app has exactly one configured cloud endpoint;
- the repository has exactly one remote Worker deployment configuration;
- CI no longer targets a GitHub dev Environment;
- documentation describes only rucola.njco.dev as the remote backend;
- old dev Worker/D1/R2 resources are deleted or explicitly retired;
- the old hostname no longer resolves to a Rucola service;
- production website, pairing, API, health, and Android App Links remain functional;
- repository-wide search finds no operational references to the old environment.