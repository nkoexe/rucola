import { writeFile } from "node:fs/promises";

const databaseId = process.env.RUCOLA_D1_DATABASE_ID;
const androidLinkFingerprints = process.env.RUCOLA_ANDROID_APP_LINK_FINGERPRINTS?.trim();

if (!databaseId || !/^[0-9a-f]{8}-[0-9a-f]{4}-[1-5][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i.test(databaseId)) {
  throw new Error("RUCOLA_D1_DATABASE_ID must contain a valid Cloudflare D1 UUID");
}

const config = {
  "$schema": "./node_modules/wrangler/config-schema.json",
  name: "rucola-cloud",
  main: "src/index.ts",
  compatibility_date: "2026-09-12",
  routes: [
    {
      pattern: "rucola.njco.dev",
      custom_domain: true,
    },
  ],
  triggers: {
    crons: ["*/15 * * * *"],
  },
  d1_databases: [
    {
      binding: "DB",
      database_name: "rucola",
      database_id: databaseId,
    },
  ],
  r2_buckets: [
    {
      binding: "MEDIA_BUCKET",
      bucket_name: "rucola-media",
      jurisdiction: "eu",
    },
  ],
  assets: { directory: "../site" },
  ...(androidLinkFingerprints
    ? { vars: { RUCOLA_ANDROID_APP_LINK_FINGERPRINTS: androidLinkFingerprints } }
    : {}),
  ratelimits: [
    {
      name: "PAIRING_BOOTSTRAP_LIMITER",
      namespace_id: "910002",
      simple: {
        limit: 10,
        period: 60
      },
    },
  ],
};

await writeFile(
  new URL("../.wrangler.deploy.jsonc", import.meta.url),
  JSON.stringify(config, null, 2) + "\n",
  "utf8",
);
