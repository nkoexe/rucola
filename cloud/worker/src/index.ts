import { authenticateDevice } from "./auth";
import { databaseHealthy, checkSchema } from "./db";
import { errorResponse, json } from "./http";
import { acceptInvitation, bootstrapPairing, createInvitation } from "./pairing";
import type { Env } from "./types";

const VERSION = "pairing-1";

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

async function handleCreateInvitation(env: Env, request: Request): Promise<Response> {
  const device = await authenticateDevice(env, request);
  if (!device) return errorResponse("UNAUTHENTICATED", "Valid device credentials are required", 401);
  return createInvitation(env, request, device);
}

async function allowPairingBootstrap(env: Env, request: Request): Promise<boolean> {
  const clientKey = request.headers.get("cf-connecting-ip") ?? "local-development";
  const result = await env.PAIRING_BOOTSTRAP_LIMITER.limit({ key: `pairing-bootstrap:${clientKey}` });
  return result.success;
}

function notImplemented(route: string): Response {
  return errorResponse(
    "NOT_IMPLEMENTED",
    `${route} is reserved for a later implementation and is intentionally not active yet`,
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

    if (url.pathname === "/health" && request.method === "GET") return handleHealth(env);
    if (url.pathname === "/health/schema" && request.method === "GET") return handleSchemaHealth(env);
    if (url.pathname === "/v1/auth/probe" && request.method === "GET") return handleAuthProbe(env, request);

    if (url.pathname === "/v1/pairing/bootstrap" && request.method === "POST") {
      if (!(await allowPairingBootstrap(env, request))) {
        return new Response(JSON.stringify({ error: { code: "PAIRING_RATE_LIMITED", message: "Too many pairing bootstrap attempts" } }), {
          status: 429,
          headers: {
            "content-type": "application/json; charset=utf-8",
            "cache-control": "no-store",
            "x-content-type-options": "nosniff",
            "referrer-policy": "no-referrer",
            "retry-after": "60",
          },
        });
      }
      return bootstrapPairing(env, request);
    }

    if (url.pathname === "/v1/pairing/create" && request.method === "POST") {
      return handleCreateInvitation(env, request);
    }

    if (url.pathname === "/v1/pairing/accept" && request.method === "POST") {
      return acceptInvitation(env, request);
    }

    if (url.pathname === "/v1/sync/push" && request.method === "POST") return notImplemented("/v1/sync/push");
    if (url.pathname === "/v1/sync/pull" && request.method === "GET") return notImplemented("/v1/sync/pull");
    if (url.pathname.startsWith("/v1/sync/ack/") && request.method === "POST") return notImplemented("/v1/sync/ack");

    return errorResponse("NOT_FOUND", "Route not found", 404);
  },
} satisfies ExportedHandler<Env>;
