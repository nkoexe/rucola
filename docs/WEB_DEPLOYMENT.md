# Web deployment

Rucola has two different web surfaces, and they must not be conflated.

- The **production website/pairing entrypoint** is the Cloudflare Worker site under `cloud/site`. It serves `https://rucola.njco.dev/`, pairing fallback routes, `/v1/*`, and Android App Links verification.
- The **Expo web app export** is a separate browser client/preview surface. It uses react-native-web 0.21.0, Expo SQLite's WebAssembly backend, and an explicit `single` web output with Metro.

The Expo web app is not the production landing page. Do not replace the Worker website routing with an Expo SPA.

## Expo web app hosting

When deploying the Expo web client to its own browser origin, the deployed document must send:

```
Cross-Origin-Opener-Policy: same-origin
Cross-Origin-Embedder-Policy: credentialless
```

These are required for the SQLite WASM/SharedArrayBuffer path. The Metro config applies the same headers during local development.

For a static host, `public/_headers` carries the response headers and `public/_redirects` rewrites browser deep links to the Expo SPA entrypoint. Expo copies files from `public/` into the exported `dist` directory.

The production Rucola website does **not** use these Pages files; its routing contract is defined by `docs/WEBSITE.md` and `cloud/site`.

## Runtime configuration

The app and browser preview use the single production Cloudflare origin:

```text
https://rucola.njco.dev
```

There is no separate remote development Worker and no runtime endpoint override. Browser previews remain local/test clients; their browser-only storage behavior must not be treated as native production secret storage.

## Browser storage

The web build currently stores cloud identity material in browser `localStorage` because the native SecureStore abstraction is not an equivalent browser security boundary. This is acceptable for the current development/web-preview path, but it is not equivalent to native SecureStore and must not be presented as production-grade secret storage.

## Media

Picked browser media is stored as Blob records in IndexedDB and referenced from SQLite with an app-owned `rucola-web-media:` URI. The browser UI resolves those references to temporary object URLs when rendering.

Cloud media uploads omit `Content-Length` in browsers because that request header is forbidden to script. The Worker enforces the reserved byte count against the streamed body itself and rejects both oversized and undersized streams.
