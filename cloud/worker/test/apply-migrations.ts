import { env } from "cloudflare:workers";
import { applyD1Migrations } from "cloudflare:workers";

export default async function applyMigrations(): Promise<void> {
  await applyD1Migrations(env.DB, env.TEST_MIGRATIONS);
}
