import { authenticateDevice } from "./auth";
import { databaseHealthy, checkSchema } from "./db";
import { errorResponse, json } from "./http";
import type { Env } from "./types";

const VERSION = "c3";

async function handleHealth(env: Env): Promise<Response> {
  try {
    const healthy = await databaseHealthy(env);
    return json({ ok: healthy, service: "rucola-cloud", version: VERSION, database: healthy });
  } catch {
    return json(
      { ok: false, service: "rucola-cloud", version: VERSION, database: false },
      503,
    );
  }
}

async function handleSchemaHealth(env: Env): Promise<Response> {
  try {
    const tables = await checkSchema(env);
    const ok = tables.every((table) => table.present);
    return json({ ok, tables }, ok ? 200 : 503);
  } catch {
    return errorResponse("DATABASE_UNAVAILABLE", "Database is unavailable", 503);
  }
}

async function handleAuthProbe(env: Env, request: Request): Promise<Response> {
  const device = await authenticateDevice(env, request);
  if (!device) return errorResponse("UNAUTHENTICATED", "Valid device credentials are required", 401);
  return json({ authenticated: true, participant: device.participant });
}

function notImplemented(route: string): Response {
  return errorResponse(
    "NOT_IMPLEMENTED",
    `${route} is reserved for the C3+ implementation and is intentionally not active yet`,
    501,
  );
}

export default {
  async fetch(request: Request, env: Env): Promise<Response> {
    const url = new URL(request.url);

    if (request.method === "OPTIONS") {
      return new Response(null, {
        status: 204,
        headers: {
          "cache-control": "no-store",
          allow: "GET,POST,OPTIONS",
        },
      });
    }

    if (url.pathname === "/health" && request.method === "GET") {
      return handleHealth(env);
    }

    if (url.pathname === "/health/schema" && request.method === "GET") {
      return handleSchemaHealth(env);
    }

    if (url.pathname === "/v1/auth/probe" && request.method === "GET") {
      return handleAuthProbe(env, request);
    }

    if (url.pathname === "/v1/pairing/create" && request.method === "POST") {
      return notImplemented("/v1/pairing/create");
    }

    if (url.pathname === "/v1/pairing/accept" && request.method === "POST") {
      return notImplemented("/v1/pairing/accept");
    }

    if (url.pathname === "/v1/sync/push" && request.method === "POST") {
      return notImplemented("/v1/sync/push");
    }

    if (url.pathname === "/v1/sync/pull" && request.method === "GET") {
      return notImplemented("/v1/sync/pull");
    }

    if (url.pathname.startsWith("/v1/sync/ack/") && request.method === "POST") {
      return notImplemented("/v1/sync/ack");
    }

    return errorResponse("NOT_FOUND", "Route not found", 404);
  },
} satisfies ExportedHandler<Env>;
