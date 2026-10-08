# Rucola website

## Purpose

The production hostname `rucola.njco.dev` serves two things from the same Cloudflare Worker:

- `/` — the public one-page Rucola landing page.
- `/<five-emojis>` — the existing pairing-link fallback.
- `/v1/*` — the existing cloud API.
- `/.well-known/assetlinks.json` — Android App Links verification.


## Repository layout

The static site lives in:

```text
cloud/site/index.html
```

It is intentionally dependency-free. There is no React/Vite build, JavaScript bundle, analytics, external font, or third-party asset.

The production Worker configuration points its static-assets directory at `../site`.

## Routing boundary

Cloudflare Workers Static Assets checks for a matching static asset before invoking the Worker script. Rucola intentionally has no SPA fallback.

```text
GET /                             -> cloud/site/index.html

GET /<valid five emojis>          -> Worker -> pairingWeb.ts
GET /<invalid or unknown path>    -> Worker -> 404

GET /v1/*                         -> Worker -> API
GET /.well-known/assetlinks.json  -> Worker -> App Links response
```

This distinction is important. Do not add:

- `not_found_handling = "single-page-application"`;
- a catch-all `index.html` fallback;
- client-side routing for the landing page.

A pairing URL must continue reaching `pairingWeb.ts` rather than being swallowed by website routing.

The site also does not attempt to consume or inspect pairing URLs. The landing page is a static root asset; pairing remains entirely owned by the existing Worker route.

## Cloudflare configuration

The generated remote deployment config always publishes the production static assets:

```json
"assets": {
  "directory": "../site"
}
```


Cloudflare Custom Domains send every path on a hostname to the Worker, which matches the desired production setup:

```text
rucola.njco.dev -> rucola-cloud
```

The exact Custom Domain attachment is Cloudflare account configuration. Verify that `rucola.njco.dev` is attached to the production Worker before the first website release.

## Deployment

Production deployment is deliberately manual through Wrangler. GitHub Actions does not deploy the Worker or site.

From a trusted machine:

```bash
cd cloud/worker
npm ci

npx wrangler login

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

The generated `.wrangler.deploy.jsonc` remains ignored and must never be committed.

After deployment verify:

```text
https://rucola.njco.dev/
https://rucola.njco.dev/<real five-emoji pairing link>
https://rucola.njco.dev/health
https://rucola.njco.dev/.well-known/assetlinks.json
```

The App Links endpoint should return 404 until the real production Android signing fingerprints are configured, as it does today.

## First-time production bootstrap

The production Worker does not need a separate dashboard project. The first authenticated `wrangler deploy` creates `rucola-cloud` and the configured Custom Domain.

Create the production data resources first:

```bash
cd cloud/worker
npx wrangler login

npx wrangler d1 create rucola \
  --jurisdiction eu

npx wrangler r2 bucket create rucola-media \
  --jurisdiction eu
```

Keep the D1 UUID returned by the first command outside Git. The R2 bucket only needs the configured name.

The rate-limit namespace does not require a separate resource-creation command; the configured numeric namespace ID is the account-scoped identifier used by the Worker.

The generated config declares:

```json
"routes": [
  {
    "pattern": "rucola.njco.dev",
    "custom_domain": true
  }
]
```

The `njco.dev` zone must be managed by the same Cloudflare account. Remove any conflicting DNS record for `rucola.njco.dev` before the first Custom Domain deployment. Cloudflare then provisions the Custom Domain and TLS for the Worker.

The production deployment command above is the complete deployment path.

This single deployment publishes both the Worker and the landing page.

## Security and privacy

The landing page intentionally has no analytics or third-party resources.

Pairing links remain subject to the existing security contract:

- GET/HEAD do not consume invitations.
- Pairing URLs use `Cache-Control: no-store`.
- Pairing URLs are marked `noindex`.
- The five emojis are the only user-visible pairing credential.
- Relationship keys, cloud credentials, invitation tokens, and serialized pairing packages never appear in landing-page content or share URLs.

Do not add analytics or URL-capturing tooling to the landing page without a separate privacy/security review.

## Future changes

A later visual pass can split the inline CSS and add image assets, but keep the routing model unchanged. Any future web framework must preserve the root-only website contract and must not introduce a catch-all route over `/<five-emojis>`.
