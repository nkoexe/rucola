import type { Env } from "./types";

export interface TableHealth {
  table: string;
  present: boolean;
}

const REQUIRED_TABLES = [
  "relationships",
  "devices",
  "invitations",
  "media_uploads",
  "mailbox_messages",
] as const;

export async function checkSchema(env: Env): Promise<TableHealth[]> {
  const result = await env.DB.prepare(
    `SELECT name FROM sqlite_master
     WHERE type = 'table' AND name IN (${REQUIRED_TABLES.map(() => "?").join(",")})`,
  )
    .bind(...REQUIRED_TABLES)
    .all<{ name: string }>();

  const present = new Set(result.results.map((row) => row.name));
  return REQUIRED_TABLES.map((table) => ({ table, present: present.has(table) }));
}

export async function databaseHealthy(env: Env): Promise<boolean> {
  const row = await env.DB.prepare("SELECT 1 AS ok").first<{ ok: number }>();
  return row?.ok === 1;
}

export function batch(env: Env, statements: D1PreparedStatement[]): Promise<D1Result<unknown>[]> {
  return env.DB.batch(statements);
}
