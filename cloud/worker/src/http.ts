export function json(data: unknown, status = 200, headers?: HeadersInit): Response {
  const merged = new Headers(headers);
  merged.set("content-type", "application/json; charset=utf-8");
  merged.set("cache-control", "no-store");
  merged.set("x-content-type-options", "nosniff");
  merged.set("referrer-policy", "no-referrer");
  return new Response(JSON.stringify(data), { status, headers: merged });
}

export function errorResponse(
  code: string,
  message: string,
  status: number,
): Response {
  return json({ error: { code, message } }, status);
}

export function methodNotAllowed(allowed: string[]): Response {
  const response = errorResponse("METHOD_NOT_ALLOWED", "Method not allowed", 405);
  response.headers.set("allow", allowed.join(", "));
  return response;
}
