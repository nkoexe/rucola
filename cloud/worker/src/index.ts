import { authenticateDevice } from "./auth";
import { databaseHealthy, checkSchema } from "./db";
import { runCleanup } from "./cleanup";
import { errorResponse, json, methodNotAllowed } from "./http";
import { acceptInvitation, bootstrapPairing, createInvitation } from "./pairing";
import { handlePairingSession } from "./pairingSession";
import { handlePairingWebRoute } from "./pairingWeb";
import { completeMedia, createMediaReservation, uploadMedia } from "./media";
import { pullMessages } from "./sync-pull";
import { acknowledgeMessages } from "./sync-ack";
import { pushMessageDurable } from "./sync-push";
import type { Env } from "./types";

const VERSION = "sync-hardening-1";

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
  const relationship = await env.DB.prepare("SELECT status FROM relationships WHERE id = ?1").bind(device.relationshipId).first<{ status: "PAIRING" | "ACTIVE" | "ENDED" }>();
  if (!relationship) return errorResponse("RELATIONSHIP_NOT_FOUND", "Relationship was not found", 404);
  return json({ authenticated: true, participant: device.participant, relationshipStatus: relationship.status });
}

async function handleCreateInvitation(env: Env, request: Request): Promise<Response> {
  const device = await authenticateDevice(env, request);
  if (!device) return errorResponse("UNAUTHENTICATED", "Valid device credentials are required", 401);
  return createInvitation(env, request, device);
}

function rateLimitedResponse(): Response {
  const response = json(
    { error: { code: "PAIRING_RATE_LIMITED", message: "Too many pairing bootstrap attempts" } },
    429,
  );
  response.headers.set("retry-after", "60");
  return response;
}

async function allowPairingBootstrap(env: Env, request: Request): Promise<boolean> {
  const clientKey = request.headers.get("cf-connecting-ip") ?? "local-development";
  const result = await env.PAIRING_BOOTSTRAP_LIMITER.limit({ key: `pairing-bootstrap:${clientKey}` });
  return result.success;
}

export default {
  async fetch(request: Request, env: Env): Promise<Response> {
    const url = new URL(request.url);

    if (request.method === "OPTIONS") {
      return new Response(null, {
        status: 204,
        headers: { "cache-control": "no-store", allow: "GET,POST,OPTIONS" },
      });
    }

    const pairingWebResponse = handlePairingWebRoute(
      request,
      env.RUCOLA_ANDROID_APP_LINK_FINGERPRINTS,
    );
    if (pairingWebResponse) return pairingWebResponse;

    if (url.pathname === "/health") {
      if (request.method !== "GET") return methodNotAllowed(["GET", "OPTIONS"]);
      return handleHealth(env);
    }
    if (url.pathname === "/health/schema") {
      if (request.method !== "GET") return methodNotAllowed(["GET", "OPTIONS"]);
      return handleSchemaHealth(env);
    }
    if (url.pathname === "/v1/auth/probe") {
      if (request.method !== "GET") return methodNotAllowed(["GET", "OPTIONS"]);
      return handleAuthProbe(env, request);
    }
    if (url.pathname === "/v1/pairing/bootstrap") {
      if (request.method !== "POST") return methodNotAllowed(["POST", "OPTIONS"]);
      if (!(await allowPairingBootstrap(env, request))) return rateLimitedResponse();
      return bootstrapPairing(env, request);
    }
    if (url.pathname === "/v1/pairing/create") {
      if (request.method !== "POST") return methodNotAllowed(["POST", "OPTIONS"]);
      return handleCreateInvitation(env, request);
    }
    if (url.pathname === "/v1/pairing/session") {
      if (request.method !== "POST") return methodNotAllowed(["POST", "OPTIONS"]);
      return handlePairingSession(env, request);
    }
    if (url.pathname === "/v1/pairing/accept") {
      if (request.method !== "POST") return methodNotAllowed(["POST", "OPTIONS"]);
      return acceptInvitation(env, request);
    }
    if (url.pathname === "/v1/media/create") {
      if (request.method !== "POST") return methodNotAllowed(["POST", "OPTIONS"]);
      return createMediaReservation(env, request);
    }
    const mediaCompleteMatch = url.pathname.match(/^\/v1\/media\/([^/]+)\/complete$/);
    if (mediaCompleteMatch) {
      if (request.method !== "POST") return methodNotAllowed(["POST", "OPTIONS"]);
      return completeMedia(env, request, mediaCompleteMatch[1]);
    }
    const mediaUploadMatch = url.pathname.match(/^\/v1\/media\/([^/]+)$/);
    if (mediaUploadMatch) {
      if (request.method !== "PUT") return methodNotAllowed(["PUT", "OPTIONS"]);
      return uploadMedia(env, request, mediaUploadMatch[1]);
    }
    if (url.pathname === "/v1/sync/push") {
      if (request.method !== "POST") return methodNotAllowed(["POST", "OPTIONS"]);
      return pushMessageDurable(env, request);
    }
    if (url.pathname === "/v1/sync/pull") {
      if (request.method !== "GET") return methodNotAllowed(["GET", "OPTIONS"]);
      return pullMessages(env, request);
    }
    if (url.pathname === "/v1/sync/ack") {
      if (request.method !== "POST") return methodNotAllowed(["POST", "OPTIONS"]);
      return acknowledgeMessages(env, request);
    }

    return errorResponse("NOT_FOUND", "Route not found", 404);
  },

  async scheduled(_controller: ScheduledController, env: Env, ctx: ExecutionContext): Promise<void> {
    ctx.waitUntil(
      runCleanup(env).then((result) => {
        console.log("rucola cleanup completed", result);
      }).catch((error: unknown) => {
        console.error("rucola cleanup failed", error);
      }),
    );
  },
} satisfies ExportedHandler<Env>;
