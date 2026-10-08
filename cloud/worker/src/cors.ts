const TRUSTED_WEB_ORIGINS = new Set([
  'https://dev.rucola.njco.dev',
  'https://rucola.njco.dev',
]);

function isAllowedOrigin(origin: string): boolean {
  if (TRUSTED_WEB_ORIGINS.has(origin)) return true;
  try {
    const url = new URL(origin);
    return (url.protocol === 'http:' && (url.hostname === 'localhost' || url.hostname === '127.0.0.1'));
  } catch {
    return false;
  }
}

function addVaryOrigin(headers: Headers): void {
  const vary = headers.get('vary');
  if (!vary) {
    headers.set('vary', 'Origin');
    return;
  }
  const values = vary.split(',').map((value) => value.trim().toLowerCase());
  if (!values.includes('origin')) headers.set('vary', vary + ', Origin');
}

export function withCors(request: Request, response: Response): Response {
  const origin = request.headers.get('origin');
  if (!origin || !isAllowedOrigin(origin)) return response;

  const headers = new Headers(response.headers);
  headers.set('access-control-allow-origin', origin);
  headers.set('access-control-allow-methods', 'GET,POST,PUT,OPTIONS');
  headers.set('access-control-allow-headers', 'authorization, content-type');
  addVaryOrigin(headers);
  return new Response(response.body, { status: response.status, statusText: response.statusText, headers });
}

export function corsPreflight(request: Request): Response {
  return withCors(
    request,
    new Response(null, {
      status: 204,
      headers: { 'cache-control': 'no-store' },
    }),
  );
}
