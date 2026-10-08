# Web deployment

Rucola's Expo web build uses react-native-web 0.21.0 and Expo SQLite's WebAssembly backend.

## Required response headers

The deployed app origin must send these headers on the web document:

Cross-Origin-Opener-Policy: same-origin
Cross-Origin-Embedder-Policy: credentialless

Without them, the SQLite WASM/SharedArrayBuffer path is not cross-origin isolated in production. The Metro config already applies the same headers during local development.

For Cloudflare Pages, public/_headers contains the equivalent static-hosting configuration.

## Runtime configuration

Production web builds should set:

- EXPO_PUBLIC_RUCOLA_CLOUD_URL to the production Rucola cloud API origin.
- EXPO_PUBLIC_RUCOLA_PAIRING_URL to the public HTTPS origin used by pairing links.

The application still defaults to https://dev.rucola.njco.dev for the cloud API, and pairing links default to https://rucola.njco.dev. Do not treat those defaults as a production deployment configuration.

## Browser storage

The web build currently stores cloud identity material in browser localStorage because Expo SecureStore has no secure browser equivalent. This is acceptable for the current development/web-preview path, but it is not equivalent to native SecureStore and must not be presented as production-grade secret storage.

## Media

Picked browser media is stored as Blob records in IndexedDB and referenced from SQLite with an app-owned rucola-web-media URI. The browser UI resolves those references to temporary object URLs when rendering.

Cloud media uploads omit Content-Length in browsers because that request header is forbidden to script. The Worker enforces the reserved byte count with the request stream itself.