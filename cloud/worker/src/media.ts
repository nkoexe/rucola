import { authenticateDevice } from "./auth";
import { errorResponse, json } from "./http";
import type { Env } from "./types";

const MAX_JSON_BODY_BYTES = 16 * 1024;
const MAX_PHOTO_BYTES = 20 * 1024 * 1024;
const MAX_VIDEO_BYTES = 100 * 1024 * 1024;
const MIN_MEDIA_BYTES = 1;
const PENDING_RETENTION_MS = 24 * 60 * 60 * 1000;
const MAX_MIME_BYTES = 128;

const PHOTO_MIME_TYPES = new Set([
  "image/jpeg",
  "image/png",
  "image/webp",
  "image/heic",
  "image/heif",
]);

const VIDEO_MIME_TYPES = new Set([
  "video/mp4",
  "video/quicktime",
  "video/webm",
]);

type ReservationType = "PHOTO" | "VIDEO";

interface CreateMediaRequest {
  type?: unknown;
  mime?: unknown;
  size?: unknown;
  checksum?: unknown;
}

function utf8ByteLength(value: string): number {
  return new TextEncoder().encode(value).byteLength;
}

async function readJson(request: Request): Promise<CreateMediaRequest | null> {
  const contentType = request.headers.get("content-type");
  if (contentType?.split(";", 1)[0]?.trim().toLowerCase() !== "application/json") return null;

  const contentLength = request.headers.get("content-length");
  if (contentLength !== null) {
    const parsedLength = Number(contentLength);
    if (!Number.isSafeInteger(parsedLength) || parsedLength < 0 || parsedLength > MAX_JSON_BODY_BYTES) {
      return null;
    }
  }

  if (!request.body) return null;
  try {
    const bytes = new Uint8Array(await request.arrayBuffer());
    if (bytes.byteLength > MAX_JSON_BODY_BYTES) return null;
    const value: unknown = JSON.parse(new TextDecoder().decode(bytes));
    if (value === null || typeof value !== "object" || Array.isArray(value)) return null;
    return value as CreateMediaRequest;
  } catch {
    return null;
  }
}

function parseType(value: unknown): ReservationType | null {
  return value === "PHOTO" || value === "VIDEO" ? value : null;
}

function parseMime(value: unknown): string | null {
  if (typeof value !== "string" || value.length === 0 || utf8ByteLength(value) > MAX_MIME_BYTES) {
    return null;
  }
  return value.trim().toLowerCase() || null;
}

function parseSize(value: unknown): number | null {
  if (!Number.isSafeInteger(value)) return null;
  const size = value as number;
  if (size < MIN_MEDIA_BYTES) return null;
  return size;
}

function parseChecksum(value: unknown): string | null | undefined {
  if (value === undefined) return null;
  if (value === null) return null;
  if (typeof value !== "string" || !/^[0-9a-fA-F]{64}$/.test(value)) return undefined;
  return value.toLowerCase();
}

function mimeAllowed(type: ReservationType, mime: string): boolean {
  return type === "PHOTO" ? PHOTO_MIME_TYPES.has(mime) : VIDEO_MIME_TYPES.has(mime);
}

function maxBytes(type: ReservationType): number {
  return type === "PHOTO" ? MAX_PHOTO_BYTES : MAX_VIDEO_BYTES;
}

export async function createMediaReservation(env: Env, request: Request): Promise<Response> {
  const device = await authenticateDevice(env, request);
  if (!device) return errorResponse("UNAUTHENTICATED", "Valid device credentials are required", 401);

  const body = await readJson(request);
  if (!body) return errorResponse("INVALID_REQUEST", "JSON request body required", 400);

  const type = parseType(body.type);
  if (!type) {
    return errorResponse("INVALID_MEDIA_TYPE", "Media type must be PHOTO or VIDEO", 400);
  }

  const mime = parseMime(body.mime);
  if (!mime || !mimeAllowed(type, mime)) {
    return errorResponse("UNSUPPORTED_MEDIA_TYPE", "MIME type is not supported for this media type", 400);
  }

  const size = parseSize(body.size);
  if (size === null) {
    return errorResponse("INVALID_MEDIA_SIZE", "Media size must be a positive safe integer", 400);
  }
  if (size > maxBytes(type)) {
    return errorResponse(
      "MEDIA_TOO_LARGE",
      type === "PHOTO" ? "Photo exceeds the 20 MiB limit" : "Video exceeds the 100 MiB limit",
      413,
    );
  }

  const checksum = parseChecksum(body.checksum);
  if (checksum === undefined) {
    return errorResponse("INVALID_CHECKSUM", "Checksum must be a SHA-256 hexadecimal string", 400);
  }

  const now = Date.now();
  const uploadId = crypto.randomUUID();
  const objectKey = `media/${crypto.randomUUID()}`;
  const expiresAt = now + PENDING_RETENTION_MS;

  try {
    const result = await env.DB.prepare(
      `INSERT INTO media_uploads (
         id, relationship_id, created_by_device_id, object_key,
         media_type, declared_mime, size_bytes, checksum, status,
         created_at, expires_at, completed_at, attached_at
       )
       SELECT ?1, ?2, ?3, ?4, ?5, ?6, ?7, ?8, 'PENDING', ?9, ?10, NULL, NULL
       FROM relationships
       WHERE id = ?2 AND status = 'ACTIVE'`,
    ).bind(
      uploadId,
      device.relationshipId,
      device.id,
      objectKey,
      type,
      mime,
      size,
      checksum,
      now,
      expiresAt,
    ).run();

    if (result.meta.changes !== 1) {
      return errorResponse("RELATIONSHIP_INACTIVE", "Relationship is not active", 409);
    }
  } catch {
    return errorResponse("DATABASE_UNAVAILABLE", "Media reservation could not be created", 503);
  }

  return json({
    uploadId,
    mediaType: type,
    mime,
    size,
    checksum,
    status: "PENDING",
    expiresAt,
  }, 201);
}
