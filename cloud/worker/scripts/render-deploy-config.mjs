import { writeFile } from "node:fs/promises";

const environment = process.env.RUCOLA_DEPLOY_ENV;
const databaseId = process.env.RUCOLA_D1_DATABASE_ID;

const environments = {
  dev: {
    workerName: "rucola-cloud-dev",
    databaseName: "rucola-dev",
    bucketName: "rucola-media-dev",
    rateLimitNamespaceId: "910001",
  },
  production: {
    workerName: "rucola-cloud",
    databaseName: "rucola-prod",
    bucketName: "rucola-media",
    rateLimitNamespaceId: "910002",
  },
};

if (!(environment in environments)) {
  throw new Error("RUCOLA_DEPLOY_ENV must be 'dev' or 'production'");
}

if (!databaseId || !/^[0-9a-f]{8}-[0-9a-f]{4}-[1-5][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i.test(databaseId)) {
  throw new Error("RUCOLA_D1_DATABASE_ID must contain a valid Cloudflare D1 UUID");
}

const target = environments[environment];
const config = {
  "$schema": "./node_modules/wrangler/config-schema.json",
  name: target.workerName,
  main: "src/index.ts",
  compatibility_date: "2026-09-12",
  triggers: {
    crons: ["*/15 * * * *"],
  },
  d1_databases: [
    {
      binding: "DB",
      database_name: target.databaseName,
      database_id: databaseId,
    },
  ],
  r2_buckets: [
    {
      binding: "MEDIA_BUCKET",
      bucket_name: target.bucketName,
      jurisdiction: "eu",
    },
  ],
  ratelimits: [
    {
      name: "PAIRING_BOOTSTRAP_LIMITER",
      namespace_id: target.rateLimitNamespaceId,
      simple: {
        limit: 10,
        period: 60,
      },
    },
  ],
};

await writeFile(
  new URL("../.wrangler.deploy.jsonc", import.meta.url),
  `${JSON.stringify(config, null, 2)}\n`,
  "utf8",
);
