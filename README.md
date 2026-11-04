# Diskbunker Link API

Cloudflare Worker (`db-api`) that resolves Diskbunker watch links and returns video metadata with a signed, Worker-hosted HLS URL. It proxies HLS playlists and media bytes while preserving byte-range requests used for seeking.

## Routes

- `GET /healthz` — Worker health (public).
- `GET /` — endpoint list, auth info, and rate limiting details (public).
- `GET /play/{slug}?api_key={key}` — browser test player using a locally served HLS.js build.
- `GET /api/watch/{slug}` — compatible with the Diskbunker APK's watch lookup shape (requires API key); preserves metadata and replaces upstream `hlsUrl` with a signed Worker URL.
- `GET /api/resolve?url=https://diskbunker.com/watch/{slug}` — resolve a full watch URL (requires API key).
- `GET|HEAD /api/hls/{token}.{ext}` — internal signed HLS playlist/segment proxy. Self-authenticated via time-limited AES-GCM token; exempt from resolver rate limits to guarantee smooth media streaming.

The resolver only accepts watch slugs and fixed Diskbunker upstream hosts. It does not accept arbitrary proxy URLs. Opaque stream tokens use AES-GCM and expire no later than the upstream stream URL.

## Authentication

Resolver endpoints (`/api/watch/:slug` and `/api/resolve`) require a valid API key configured in `API_KEY` (or comma-separated `API_KEYS`).

Clients can supply the API key using any of the following:
1. `Authorization: Bearer <API_KEY>` header
2. `X-API-Key: <API_KEY>` header
3. `?api_key=<API_KEY>` or `?key=<API_KEY>` query parameter

If an API key is missing, the endpoint responds with HTTP `401 Unauthorized`. If invalid, it responds with HTTP `403 Forbidden`. Comparisons are constant-time SHA-256 to prevent timing attacks.

## Rate Limiting

- **Scope**: Applied to resolver endpoints (`/api/watch/:slug` and `/api/resolve`). HLS video segments and playlists are exempt to ensure uninterrupted video playback.
- **Identifier**: Evaluated per client IP and per authenticated API key.
- **Limits**: Configurable via `RATE_LIMIT_MAX` (default: 60) and `RATE_LIMIT_WINDOW_SECONDS` (default: 60).
- **Headers returned**:
  - `RateLimit-Limit`: Maximum permitted requests in window.
  - `RateLimit-Remaining`: Remaining request quota.
  - `RateLimit-Reset`: Seconds until quota reset.
  - `Retry-After`: Seconds to wait before retrying (on HTTP `429 Too Many Requests`).
- **Cloudflare Binding**: Automatically utilizes Cloudflare's native `RATE_LIMITER` binding if configured in `wrangler.jsonc`, otherwise seamlessly falls back to Worker memory sliding-window tracking.

## Local development

Requires Node.js 20. Use local secrets in `.dev.vars`; do not commit them.

```powershell
npm install
node -e "const c=require('crypto');require('fs').writeFileSync('.dev.vars', 'STREAM_TOKEN_SECRET=' + c.randomBytes(32).toString('base64') + '\nAPI_KEY=dbk_' + c.randomBytes(24).toString('hex') + '\n')"
npm run dev
```

Then open `http://localhost:8787/` for endpoint help, or `http://localhost:8787/play/69d5abd3e9b483a250dc8a49?api_key=$apiKey` to play the sample link in a browser.

## Deploy

Authenticate Wrangler with `npx wrangler login`, set production secrets, and deploy:

```powershell
npx wrangler secret put STREAM_TOKEN_SECRET
npx wrangler secret put API_KEY
npm run deploy
```

Wrangler prompts for the secret value. Use a fresh random secret; never put it in `wrangler.jsonc`, source, or a command argument. Add a Cloudflare rate-limiting rule for `/api/watch/*` and `/api/resolve` before making a public deployment.

## Important scope

This Worker resolves and serves HLS renditions that Diskbunker has already generated. It does not transcode original video files. If the upstream returns `hlsUrl: null`, the API returns that video metadata with `hlsUrl: null`; generating HLS for those videos requires the Diskbunker upload/transcoding backend or a separate encoding pipeline.
