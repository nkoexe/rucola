import { authenticateDevice } from "./auth";
import { errorResponse, json } from "./http";
import type { AuthenticatedDevice, Env } from "./types";

const MAX_JSON_BODY_BYTES = 16 * 1024;
const MAX_PHOTO_BYTES = 20 * 1024 * 1024;
const MAX_VIDEO_BYTES = 100 * 1024 * 1024;
const MIN_MEDIA_BYTES = 1;
const PENDING_RETENTION_MS = 24 * 60 * 60 * 1000;
const READY_RETENTION_MS = 14 * 24 * 60 * 60 * 1000;
const MAX_MIME_BYTES = 128;

const PHOTO_MIME_TYPES = new Set(["image/jpeg", "image/png", "image/webp", "image/heic", "image/heif"]);
const VIDEO_MIME_TYPES = new Set(["video/mp4", "video/quicktime", "video/webm"]);

type ReservationType = "PHOTO" | "VIDEO";
type MediaStatus = "PENDING" | "READY" | "ATTACHED" | "ABANDONED";
interface CreateMediaRequest { type?: unknown; mime?: unknown; size?: unknown; checksum?: unknown; }
interface MediaUploadRow { id: string; relationship_id: string; created_by_device_id: string; object_key: string; media_type: ReservationType; declared_mime: string; size_bytes: number; checksum: string | null; status: MediaStatus; expires_at: number; }
function utf8ByteLength(value: string): number { return new TextEncoder().encode(value).byteLength; }
async function readJson(request: Request): Promise<CreateMediaRequest | null> {
  const contentType = request.headers.get("content-type");
  if (contentType?.split(";", 1)[0]?.trim().toLowerCase() !== "application/json") return null;
  const contentLength = request.headers.get("content-length");
  if (contentLength !== null) { const parsedLength = Number(contentLength); if (!Number.isSafeInteger(parsedLength) || parsedLength < 0 || parsedLength > MAX_JSON_BODY_BYTES) return null; }
  if (!request.body) return null;
  try { const bytes = new Uint8Array(await request.arrayBuffer()); if (bytes.byteLength > MAX_JSON_BODY_BYTES) return null; const value: unknown = JSON.parse(new TextDecoder().decode(bytes)); if (value === null || typeof value !== "object" || Array.isArray(value)) return null; return value as CreateMediaRequest; } catch { return null; }
}
function parseType(value: unknown): ReservationType | null { return value === "PHOTO" || value === "VIDEO" ? value : null; }
function parseMime(value: unknown): string | null { if (typeof value !== "string" || value.length === 0 || utf8ByteLength(value) > MAX_MIME_BYTES) return null; return value.trim().toLowerCase() || null; }
function parseSize(value: unknown): number | null { if (!Number.isSafeInteger(value)) return null; const size = value as number; return size >= MIN_MEDIA_BYTES ? size : null; }
function parseChecksum(value: unknown): string | null | undefined { if (value === undefined || value === null) return null; if (typeof value !== "string" || !/^[0-9a-fA-F]{64}$/.test(value)) return undefined; return value.toLowerCase(); }
function mimeAllowed(type: ReservationType, mime: string): boolean { return type === "PHOTO" ? PHOTO_MIME_TYPES.has(mime) : VIDEO_MIME_TYPES.has(mime); }
function maxBytes(type: ReservationType): number { return type === "PHOTO" ? MAX_PHOTO_BYTES : MAX_VIDEO_BYTES; }
function checksumBytes(hex: string): ArrayBuffer { const bytes = new Uint8Array(hex.length / 2); for (let index = 0; index < bytes.length; index += 1) bytes[index] = Number.parseInt(hex.slice(index * 2, index * 2 + 2), 16); return bytes.buffer; }
function checksumHex(value: ArrayBuffer | ArrayBufferView): string { const bytes = value instanceof ArrayBuffer ? new Uint8Array(value) : new Uint8Array(value.buffer, value.byteOffset, value.byteLength); return Array.from(bytes, (byte) => byte.toString(16).padStart(2, "0")).join(""); }
function sameSha256(object: R2Object, expected: string): boolean { const actual = object.checksums?.sha256; return actual ? checksumHex(actual).toLowerCase() === expected : false; }
async function getOwnedUpload(env: Env, device: AuthenticatedDevice, uploadId: string): Promise<MediaUploadRow | null> {
  return env.DB.prepare(`SELECT media_uploads.id, media_uploads.relationship_id, media_uploads.created_by_device_id, media_uploads.object_key, media_uploads.media_type, media_uploads.declared_mime, media_uploads.size_bytes, media_uploads.checksum, media_uploads.status, media_uploads.expires_at FROM media_uploads JOIN relationships ON relationships.id = media_uploads.relationship_id WHERE media_uploads.id = ?1 AND media_uploads.relationship_id = ?2 AND media_uploads.created_by_device_id = ?3 AND relationships.status = 'ACTIVE'`).bind(uploadId, device.relationshipId, device.id).first<MediaUploadRow>();
}
function removeObjectBestEffort(env: Env, objectKey: string): Promise<void> { return env.MEDIA_BUCKET.delete(objectKey).catch(() => undefined); }
export async function createMediaReservation(env: Env, request: Request): Promise<Response> {
  const device = await authenticateDevice(env, request); if (!device) return errorResponse("UNAUTHENTICATED", "Valid device credentials are required", 401);
  const body = await readJson(request); if (!body) return errorResponse("INVALID_REQUEST", "JSON request body required", 400);
  const type = parseType(body.type); if (!type) return errorResponse("INVALID_MEDIA_TYPE", "Media type must be PHOTO or VIDEO", 400);
  const mime = parseMime(body.mime); if (!mime || !mimeAllowed(type, mime)) return errorResponse("UNSUPPORTED_MEDIA_TYPE", "MIME type is not supported for this media type", 400);
  const size = parseSize(body.size); if (size === null) return errorResponse("INVALID_MEDIA_SIZE", "Media size must be a positive safe integer", 400);
  if (size > maxBytes(type)) return errorResponse("MEDIA_TOO_LARGE", type === "PHOTO" ? "Photo exceeds the 20 MiB limit" : "Video exceeds the 100 MiB limit", 413);
  const checksum = parseChecksum(body.checksum); if (checksum === undefined) return errorResponse("INVALID_CHECKSUM", "Checksum must be a SHA-256 hexadecimal string", 400);
  const now = Date.now(); const uploadId = crypto.randomUUID(); const objectKey = `media/${crypto.randomUUID()}`; const expiresAt = now + PENDING_RETENTION_MS;
  try { const result = await env.DB.prepare(`INSERT INTO media_uploads (id, relationship_id, created_by_device_id, object_key, media_type, declared_mime, size_bytes, checksum, status, created_at, expires_at, completed_at, attached_at) SELECT ?1, ?2, ?3, ?4, ?5, ?6, ?7, ?8, 'PENDING', ?9, ?10, NULL, NULL FROM relationships WHERE id = ?2 AND status = 'ACTIVE'`).bind(uploadId, device.relationshipId, device.id, objectKey, type, mime, size, checksum, now, expiresAt).run(); if (result.meta.changes !== 1) return errorResponse("RELATIONSHIP_INACTIVE", "Relationship is not active", 409); } catch { return errorResponse("DATABASE_UNAVAILABLE", "Media reservation could not be created", 503); }
  return json({ uploadId, mediaType: type, mime, size, checksum, status: "PENDING", expiresAt }, 201);
}
export async function uploadMedia(env: Env, request: Request, uploadId: string): Promise<Response> {
  const device = await authenticateDevice(env, request); if (!device) return errorResponse("UNAUTHENTICATED", "Valid device credentials are required", 401);
  if (!/^[0-9a-f-]{36}$/i.test(uploadId)) return errorResponse("INVALID_UPLOAD_ID", "Invalid media upload ID", 400);
  const contentType = request.headers.get("content-type")?.split(";", 1)[0]?.trim().toLowerCase(); if (!contentType) return errorResponse("INVALID_CONTENT_TYPE", "Content-Type is required", 400);
  const upload = await getOwnedUpload(env, device, uploadId); if (!upload) return errorResponse("MEDIA_NOT_FOUND", "Media upload was not found", 404);
  const now = Date.now(); if (upload.status !== "PENDING") return errorResponse("MEDIA_NOT_PENDING", "Media upload is no longer pending", 409); if (now >= upload.expires_at) return errorResponse("MEDIA_EXPIRED", "Media upload has expired", 409); if (contentType !== upload.declared_mime) return errorResponse("CONTENT_TYPE_MISMATCH", "Content-Type does not match the reservation", 400);
  const contentLengthHeader = request.headers.get("content-length"); if (contentLengthHeader === null) return errorResponse("CONTENT_LENGTH_REQUIRED", "Content-Length is required", 411);
  const contentLength = Number(contentLengthHeader); if (!Number.isSafeInteger(contentLength) || contentLength !== upload.size_bytes) return errorResponse("MEDIA_SIZE_MISMATCH", "Content-Length does not match the reservation", 400);
  if (!request.body) return errorResponse("INVALID_REQUEST", "Media request body required", 400);
  let stored: R2Object | null = null;
  try { stored = await env.MEDIA_BUCKET.put(upload.object_key, request.body, { httpMetadata: { contentType: upload.declared_mime }, customMetadata: { uploadId: upload.id }, ...(upload.checksum === null ? {} : { sha256: checksumBytes(upload.checksum) }) }); } catch { return errorResponse("MEDIA_UPLOAD_FAILED", "Media upload could not be stored", 502); }
  if (!stored || stored.size !== upload.size_bytes || stored.httpMetadata?.contentType !== upload.declared_mime) { await removeObjectBestEffort(env, upload.object_key); return errorResponse("MEDIA_STORAGE_MISMATCH", "Stored media does not match the reservation", 502); }
  if (upload.checksum !== null && !sameSha256(stored, upload.checksum)) { await removeObjectBestEffort(env, upload.object_key); return errorResponse("MEDIA_CHECKSUM_MISMATCH", "Stored media checksum does not match the reservation", 400); }
  return json({ uploadId: upload.id, status: "UPLOADED" });
}
export async function completeMedia(env: Env, request: Request, uploadId: string): Promise<Response> {
  const device = await authenticateDevice(env, request); if (!device) return errorResponse("UNAUTHENTICATED", "Valid device credentials are required", 401);
  if (!/^[0-9a-f-]{36}$/i.test(uploadId)) return errorResponse("INVALID_UPLOAD_ID", "Invalid media upload ID", 400);
  const upload = await getOwnedUpload(env, device, uploadId); if (!upload) return errorResponse("MEDIA_NOT_FOUND", "Media upload was not found", 404);
  const now = Date.now();
  if (upload.status === "READY") { if (now >= upload.expires_at) return errorResponse("MEDIA_EXPIRED", "Media upload has expired", 409); return json({ uploadId: upload.id, status: "READY" }); }
  if (now >= upload.expires_at) return errorResponse("MEDIA_EXPIRED", "Media upload has expired", 409); if (upload.status !== "PENDING") return errorResponse("MEDIA_NOT_PENDING", "Media upload is no longer pending", 409);
  let object: R2Object | null; try { object = await env.MEDIA_BUCKET.head(upload.object_key); } catch { return errorResponse("MEDIA_STORAGE_UNAVAILABLE", "Media storage could not be checked", 502); }
  if (!object) return errorResponse("MEDIA_NOT_UPLOADED", "Media object has not been uploaded", 409);
  if (object.size !== upload.size_bytes || object.httpMetadata?.contentType !== upload.declared_mime || object.customMetadata?.uploadId !== upload.id || (upload.checksum !== null && !sameSha256(object, upload.checksum))) { await removeObjectBestEffort(env, upload.object_key); return errorResponse("MEDIA_STORAGE_MISMATCH", "Stored media does not match the reservation", 409); }
  const readyExpiresAt = now + READY_RETENTION_MS;
  try { const result = await env.DB.prepare(`UPDATE media_uploads SET status = 'READY', completed_at = ?1, expires_at = ?2 WHERE id = ?3 AND relationship_id = ?4 AND created_by_device_id = ?5 AND status = 'PENDING' AND expires_at > ?1`).bind(now, readyExpiresAt, upload.id, device.relationshipId, device.id).run(); if (result.meta.changes !== 1) { const current = await getOwnedUpload(env, device, upload.id); if (current?.status === "READY") return json({ uploadId: current.id, status: "READY" }); if (!current) return errorResponse("MEDIA_NOT_FOUND", "Media upload was not found", 404); if (Date.now() >= current.expires_at) return errorResponse("MEDIA_EXPIRED", "Media upload has expired", 409); return errorResponse("MEDIA_NOT_PENDING", "Media upload is no longer pending", 409); } } catch { return errorResponse("DATABASE_UNAVAILABLE", "Media completion could not be recorded", 503); }
  return json({ uploadId: upload.id, status: "READY" });
}
