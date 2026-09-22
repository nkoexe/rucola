const PAIRING_EMOJIS = [
  "😀", "😃", "😄", "😁", "😆", "😅", "😂", "🤣",
  "😊", "😇", "🙂", "🙃", "😉", "😌", "😍", "🥰",
  "😘", "😗", "😙", "😚", "😋", "😛", "😜", "🤪",
  "😎", "🤩", "🥳", "🤗", "🤔", "🥺", "😭", "😡",
  "😴",
] as const;

const ANDROID_PACKAGE = "com.rucola.app";
const FINGERPRINT_RE = /^(?:[0-9A-F]{2}:){31}[0-9A-F]{2}$/;

function isPairingCode(value: string): boolean {
  const emojis = Array.from(value);
  return emojis.length === 5 &&
    emojis.every((emoji) => (PAIRING_EMOJIS as readonly string[]).includes(emoji));
}

function decodePairingPath(pathname: string): string | null {
  if (pathname === "/" || pathname.startsWith("/.well-known/") || pathname.endsWith("/")) return null;
  const encoded = pathname.slice(1);
  if (!encoded || encoded.includes("/")) return null;

  try {
    const decoded = decodeURIComponent(encoded);
    return isPairingCode(decoded) ? decoded : null;
  } catch {
    return null;
  }
}

function securityHeaders(contentType: string): Headers {
  return new Headers({
    "content-type": contentType,
    "cache-control": "no-store",
    "referrer-policy": "no-referrer",
    "x-content-type-options": "nosniff",
    "x-robots-tag": "noindex, nofollow, noarchive",
  });
}

function escapeHtml(value: string): string {
  return value
    .replaceAll("&", "&amp;")
    .replaceAll("<", "&lt;")
    .replaceAll(">", "&gt;")
    .replaceAll('"', "&quot;")
    .replaceAll("'", "&#39;");
}

function pairingLanding(code: string, request: Request): Response {
  const appUrl = "rucola://pair/" + encodeURIComponent(code);
  const html = `<!doctype html>
<html lang="en">
<head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width,initial-scale=1">
<meta name="robots" content="noindex,nofollow,noarchive">
<title>Open Rucola</title>
</head>
<body>
<main>
<h1>Open Rucola</h1>
<p>Pairing code:</p>
<p aria-label="five emoji pairing code">${escapeHtml(code)}</p>
<p><a href="${escapeHtml(appUrl)}">open Rucola</a></p>
<p>Have Rucola installed? The link should open the app automatically.</p>
</main>
</body>
</html>
`;

  const headers = securityHeaders("text/html; charset=utf-8");
  headers.set(
    "content-security-policy",
    "default-src 'none'; style-src 'unsafe-inline'; base-uri 'none'; frame-ancestors 'none'; form-action 'none'",
  );
  headers.set("link", '<https://rucola.njco.dev>; rel="canonical"');
  return new Response(request.method === "HEAD" ? null : html, { status: 200, headers });
}

function assetLinksResponse(request: Request, fingerprints: string | undefined): Response {
  if (!fingerprints) return new Response(null, { status: 404 });

  const values = fingerprints
    .split(",")
    .map((value) => value.trim().toUpperCase())
    .filter((value) => FINGERPRINT_RE.test(value));

  if (values.length === 0) return new Response(null, { status: 404 });

  const body = JSON.stringify([{
    relation: ["delegate_permission/common.handle_all_urls"],
    target: {
      namespace: "android_app",
      package_name: ANDROID_PACKAGE,
      sha256_cert_fingerprints: values,
    },
  }]);

  const headers = securityHeaders("application/json; charset=utf-8");
  headers.set("content-security-policy", "default-src 'none'; base-uri 'none'; frame-ancestors 'none'");
  return new Response(request.method === "HEAD" ? null : body, { status: 200, headers });
}

export function handlePairingWebRoute(
  request: Request,
  fingerprints?: string,
): Response | null {
  const url = new URL(request.url);

  if (url.pathname === "/.well-known/assetlinks.json") {
    if (request.method !== "GET" && request.method !== "HEAD") return null;
    return assetLinksResponse(request, fingerprints);
  }

  if (request.method !== "GET" && request.method !== "HEAD") return null;

  const code = decodePairingPath(url.pathname);
  return code ? pairingLanding(code, request) : null;
}
