# Rucola Cloud Worker

Cloudflare Worker for Rucola pairing, media transfer, and message synchronization.

## Development

From `cloud/worker`:

```bash
npm ci
npm run typecheck
npm test
npm run dev
```

`wrangler.jsonc` is the local/test configuration. Remote deployment configuration is generated into `.wrangler.deploy.jsonc` and is ignored by Git.

## Remote environments

| Environment | Worker | D1 | R2 | Rate-limit namespace |
| --- | --- | --- | --- | --- |
| dev | `rucola-cloud-dev` | `rucola-dev` | `rucola-media-dev` | `910001` |
| production | `rucola-cloud` | `rucola-prod` | `rucola-media` | `910002` |

Development and production use separate D1 and R2 resources. Rate-limit namespaces are also separate.

Create the resources with Wrangler as needed:

```bash
npx wrangler d1 create rucola-dev --location weur --jurisdiction eu
npx wrangler r2 bucket create rucola-media-dev --location weur --jurisdiction eu
```

Repeat for the production resources. Store the D1 UUID outside the repository; the deployment workflow receives it through `RUCOLA_D1_DATABASE_ID`.

## Deployment

Render a deployment configuration for the selected environment:

```bash
RUCOLA_DEPLOY_ENV=dev \
RUCOLA_D1_DATABASE_ID="<DEV_D1_UUID>" \
npm run render:deploy-config
```

Review `.wrangler.deploy.jsonc`, then apply migrations and deploy:

```bash
npx wrangler d1 migrations apply rucola-dev --remote --config .wrangler.deploy.jsonc
npx wrangler deploy --config .wrangler.deploy.jsonc --strict
```

Production uses `RUCOLA_DEPLOY_ENV=production` and `rucola-prod`.

The GitHub Actions `Cloud Worker` workflow runs tests for normal pushes and pull requests. A manual workflow dispatch can deploy `dev` or `production`. Configure `CLOUDFLARE_ACCOUNT_ID`, `CLOUDFLARE_API_TOKEN`, and `RUCOLA_D1_DATABASE_ID` in the corresponding GitHub Environment. Production should use environment protection with a required reviewer.

### Migration history

The migration directory is the source of truth for D1 schema changes. Before applying the remote migrations to an existing database, verify its migration history. This branch renumbers migrations that previously shared duplicate numeric prefixes; a database that has already applied the old filenames may require migration-history reconciliation before deployment.

D1 remote migration parsing has trigger-specific quirks that SQLite itself does not have. Migration trigger bodies therefore use uppercase `BEGIN`, LF line endings are enforced through `.gitattributes`, and conditional `CASE ... END` expressions inside triggers are parenthesized. Do not simplify those forms without verifying `d1 migrations apply --remote` against a real D1 database.

## Sync protocol

Mailbox messages are retained for 14 days. Delivery receipts are retained for 30 days for retry idempotency after mailbox rows are acknowledged or removed.

Pull is directional: a device never receives its own outbound mailbox rows. ACK is also directional: a device can acknowledge and delete only partner-originated messages delivered to that device. Repeated ACKs are idempotent.

Expired mailbox rows are intentionally skipped by pull and no longer block ACK cursor advancement, so `serverSeq` gaps are expected. Live undelivered partner messages still block the corresponding ACK.

`DRAWING` remains in the protocol and schema for compatibility, but new drawing pushes are rejected until drawing synchronization is implemented end-to-end.

The server stores ciphertext but does not decrypt message contents. Inbound decryption and any future quarantine policy are client responsibilities.

## Health checks

After deployment:

```text
GET /health
GET /health/schema
```

These endpoints report service/schema state only and do not expose message data.

## Security

Never commit API tokens, credentials, or generated deployment configuration. The deployment config contains the real D1 database ID and must remain an ignored CI/local artifact.
