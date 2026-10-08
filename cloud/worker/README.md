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

## Remote environments

| Environment | Worker | D1 | R2 | Rate-limit namespace |
| --- | --- | --- | --- | --- |
| dev | rucola-cloud-dev | rucola-dev | rucola-media-dev | 910001 |
| production | rucola-cloud | rucola-prod | rucola-media | 910002 |

Development and production use separate D1 and R2 resources. Rate-limit namespaces are also separate.

Create the resources with Wrangler as needed:

~~~bash
npx wrangler d1 create rucola-dev --location weur --jurisdiction eu
npx wrangler r2 bucket create rucola-media-dev --location weur --jurisdiction eu
~~~

Repeat for the production resources. Store the D1 UUID outside the repository.

## Deployment

Production deployment is manual through Wrangler. GitHub Actions runs validation only; it does not deploy the Worker.

Render a deployment configuration for the selected environment:

~~~bash
RUCOLA_DEPLOY_ENV=dev \
RUCOLA_D1_DATABASE_ID="<DEV_D1_UUID>" \
npm run render:deploy-config
~~~

Production adds the static landing page from ../site to the generated Worker configuration. Development intentionally remains Worker-only.

Review .wrangler.deploy.jsonc, then apply migrations and deploy:

~~~bash
npx wrangler d1 migrations apply rucola-dev --remote --config .wrangler.deploy.jsonc
npx wrangler deploy --config .wrangler.deploy.jsonc --strict
~~~

Production uses RUCOLA_DEPLOY_ENV=production and rucola-prod:

~~~bash
RUCOLA_DEPLOY_ENV=production \
RUCOLA_D1_DATABASE_ID="<PRODUCTION_D1_UUID>" \
RUCOLA_ANDROID_APP_LINK_FINGERPRINTS="<FINGERPRINTS>" \
npm run render:deploy-config

npx wrangler d1 migrations apply rucola-prod --remote --config .wrangler.deploy.jsonc
npx wrangler deploy --config .wrangler.deploy.jsonc --strict
~~~

Run npx wrangler login once on the deployment machine and keep credentials outside the repository.

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

After deployment:

~~~text
GET /health
GET /health/schema
~~~

For the production website also verify:

~~~text
GET /
GET /<five-emoji pairing path>
GET /.well-known/assetlinks.json
~~~

These routes share the production Worker; see docs/WEBSITE.md for the routing contract.

## Security

Never commit API tokens, credentials, or generated deployment configuration. The deployment config contains the real D1 database ID and must remain an ignored local artifact.
