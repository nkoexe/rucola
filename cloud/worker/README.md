# Rucola Cloud Worker

Cloudflare Worker for Rucola pairing, media transfer, and message synchronization.

## Development

From cloud/worker:

~~~bash
npm ci
npm run typecheck
npm test
npm run dev
~~~

wrangler.jsonc is the local/test configuration. Remote deployment configuration is generated into .wrangler.deploy.jsonc and is ignored by Git.

## Remote production

| Worker | D1 | R2 | Rate-limit namespace |
| --- | --- | --- | --- |
| rucola-cloud | rucola | rucola-media | 910002 |

The repository has one remote Cloudflare environment. Local Worker development and tests continue to use the local-only `wrangler.jsonc` configuration.

## Deployment

Production deployment is automatic after the `Cloud Worker` validation workflow passes for a push to `main`. The deployment workflow:

1. checks out the exact commit that passed validation;
2. renders the production-only Wrangler configuration;
3. applies pending D1 migrations to `rucola`;
4. deploys Worker and website to `rucola.njco.dev`;
5. smoke-tests the production health endpoint and landing page.

The deployment workflow uses these repository Actions secrets:

- `CLOUDFLARE_ACCOUNT_ID`
- `CLOUDFLARE_API_TOKEN`
- `RUCOLA_D1_DATABASE_ID`
- `RUCOLA_ANDROID_APP_LINK_FINGERPRINTS` (optional; intentionally unset until the production Android signing fingerprint is available)

At present the App Links fingerprint secret is intentionally not configured. Until it is set, `/.well-known/assetlinks.json` remains 404; this does not block the Worker or website deployment.

For a manual recovery deployment from a trusted machine:

~~~bash
RUCOLA_D1_DATABASE_ID="<PRODUCTION_D1_UUID>" \
RUCOLA_ANDROID_APP_LINK_FINGERPRINTS="<FINGERPRINTS>" \
npm run render:deploy-config

npx wrangler d1 migrations apply rucola --remote --config .wrangler.deploy.jsonc
npx wrangler deploy --config .wrangler.deploy.jsonc --strict
~~~

Run `npx wrangler login` once on the deployment machine and keep credentials outside the repository.

The public website is documented separately in docs/WEBSITE.md.

### Migration history

The migration directory is the source of truth for D1 schema changes. Before applying the remote migrations to an existing database, verify its migration history. This branch renumbers migrations that previously shared duplicate numeric prefixes; a database that has already applied the old filenames may require migration-history reconciliation before deployment.

D1 remote migration parsing has trigger-specific quirks that SQLite itself does not have. Migration trigger bodies therefore use uppercase BEGIN, LF line endings are enforced through .gitattributes, and conditional CASE ... END expressions inside triggers are parenthesized. Do not simplify those forms without verifying d1 migrations apply --remote against a real D1 database.

## Sync protocol

Mailbox messages are retained for 14 days. Delivery receipts are retained for 30 days for retry idempotency after mailbox rows are acknowledged or removed.

Pull is directional: a device never receives its own outbound mailbox rows. ACK is also directional: a device can acknowledge and delete only partner-originated messages delivered to that device. Repeated ACKs are idempotent.

Expired mailbox rows are intentionally skipped by pull and no longer block ACK cursor advancement, so serverSeq gaps are expected. Live undelivered partner messages still block the corresponding ACK.

DRAWING remains in the protocol and schema for compatibility, but new drawing pushes are rejected until drawing synchronization is implemented end-to-end.

The server stores ciphertext and envelope metadata; it does not decrypt message contents. Inbound decryption and any future quarantine policy are client responsibilities.

## Health checks

The automatic deployment smoke-tests:

~~~text
GET /health
GET /
~~~

For manual production verification also check:

~~~text
GET /health/schema
GET /<five-emoji pairing path>
GET /.well-known/assetlinks.json
~~~

These routes share the production Worker; see docs/WEBSITE.md for the routing contract.

## Security

Never commit API tokens, credentials, or generated deployment configuration. The deployment config contains the real D1 database ID and must remain an ignored local artifact.
