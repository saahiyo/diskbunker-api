const API_ORIGIN = "https://api.diskbunker.com";
const WATCH_HOSTS = new Set(["diskbunker.com", "www.diskbunker.com"]);
const MEDIA_HOSTS = new Set([
  "api.diskbunker.com",
  "player.diskbunker.com",
  "diskbunker.com",
  "www.diskbunker.com",
]);

const DEFAULT_UPSTREAM_HEADERS = {
  "User-Agent": "okhttp/4.12.0",
  "Accept": "application/json",
  "Referer": "https://diskbunker.com/",
  "Origin": "https://diskbunker.com",
  "cf-worker": "",
};

function isAllowedMediaHost(hostname) {
  if (MEDIA_HOSTS.has(hostname)) return true;
  if (hostname.endsWith(".googleusercontent.com") || hostname === "googleusercontent.com") return true;
  if (hostname.endsWith(".gravatar.com") || hostname === "gravatar.com") return true;
  return false;
}

const MAX_JSON_BYTES = 1_000_000;
const MAX_PLAYLIST_BYTES = 2_000_000;
const MAX_STREAM_TOKEN_SECONDS = 24 * 60 * 60;

function corsHeaders() {
  return {
    "Access-Control-Allow-Origin": "*",
    "Access-Control-Allow-Methods": "GET, HEAD, OPTIONS",
    "Access-Control-Allow-Headers": "Range, If-Range, Content-Type, Authorization, X-API-Key",
    "Access-Control-Expose-Headers": "Accept-Ranges, Content-Length, Content-Range, Content-Type, ETag, RateLimit-Limit, RateLimit-Remaining, RateLimit-Reset, Retry-After",
    "X-Content-Type-Options": "nosniff",
  };
}

function json(data, status = 200, headers = {}) {
  return new Response(JSON.stringify(data), {
    status,
    headers: {
      ...corsHeaders(),
      "Content-Type": "application/json; charset=utf-8",
      "Cache-Control": "no-store",
      ...headers,
    },
  });
}

function fail(status, code, message, headers = {}) {
  return json({ success: false, error: { code, message } }, status, headers);
}

function isRecord(value) {
  return value !== null && typeof value === "object" && !Array.isArray(value);
}

function validateSlug(slug) {
  return /^[a-zA-Z0-9_-]{6,128}$/.test(slug);
}

function validateMediaUrl(value) {
  let url;
  try {
    url = new URL(value);
  } catch {
    throw new Error("invalid_media_url");
  }
  if (
    url.protocol !== "https:" ||
    !isAllowedMediaHost(url.hostname) ||
    url.username ||
    url.password ||
    (url.port && url.port !== "443")
  ) {
    throw new Error("blocked_media_url");
  }
  return url;
}

function getSlugFromWatchUrl(value) {
  let url;
  try {
    url = new URL(value);
  } catch {
    return null;
  }
  if (url.protocol !== "https:" || !WATCH_HOSTS.has(url.hostname) || url.username || url.password) {
    return null;
  }
  const match = url.pathname.match(/^\/watch\/([a-zA-Z0-9_-]{6,128})\/?$/);
  return match?.[1] ?? null;
}

async function readLimitedText(response, limit) {
  if (!response.body) return "";
  const reader = response.body.getReader();
  const chunks = [];
  let size = 0;
  try {
    while (true) {
      const { done, value } = await reader.read();
      if (done) break;
      size += value.byteLength;
      if (size > limit) {
        await reader.cancel();
        throw new Error("response_too_large");
      }
      chunks.push(value);
    }
  } finally {
    reader.releaseLock();
  }
  const bytes = new Uint8Array(size);
  let offset = 0;
  for (const chunk of chunks) {
    bytes.set(chunk, offset);
    offset += chunk.byteLength;
  }
  return new TextDecoder().decode(bytes);
}

function base64UrlEncode(bytes) {
  let binary = "";
  for (const byte of bytes) binary += String.fromCharCode(byte);
  return btoa(binary).replaceAll("+", "-").replaceAll("/", "_").replace(/=+$/, "");
}

function base64UrlDecode(value) {
  const base64 = value.replaceAll("-", "+").replaceAll("_", "/");
  const binary = atob(base64 + "=".repeat((4 - (base64.length % 4)) % 4));
  return Uint8Array.from(binary, (char) => char.charCodeAt(0));
}

async function getEncryptionKey(secret) {
  if (!secret || new TextEncoder().encode(secret).byteLength < 32) {
    throw new Error("stream_token_secret_missing");
  }
  const rawKey = await crypto.subtle.digest("SHA-256", new TextEncoder().encode(secret));
  return crypto.subtle.importKey("raw", rawKey, "AES-GCM", false, ["encrypt", "decrypt"]);
}

async function encryptStreamTarget(url, expiresAt, key) {
  const iv = crypto.getRandomValues(new Uint8Array(12));
  const payload = new TextEncoder().encode(JSON.stringify({ url: url.href, exp: expiresAt }));
  const ciphertext = await crypto.subtle.encrypt({ name: "AES-GCM", iv }, key, payload);
  const combined = new Uint8Array(iv.byteLength + ciphertext.byteLength);
  combined.set(iv);
  combined.set(new Uint8Array(ciphertext), iv.byteLength);
  return base64UrlEncode(combined);
}

async function decryptStreamTarget(token, key) {
  try {
    const combined = base64UrlDecode(token);
    if (combined.byteLength < 29 || combined.byteLength > 16_384) return null;
    const iv = combined.slice(0, 12);
    const ciphertext = combined.slice(12);
    const plaintext = await crypto.subtle.decrypt({ name: "AES-GCM", iv }, key, ciphertext);
    const payload = JSON.parse(new TextDecoder().decode(plaintext));
    if (!isRecord(payload) || typeof payload.url !== "string" || !Number.isInteger(payload.exp)) return null;
    if (payload.exp <= Math.floor(Date.now() / 1000)) return null;
    if (payload.exp > Math.floor(Date.now() / 1000) + MAX_STREAM_TOKEN_SECONDS) return null;
    return { url: validateMediaUrl(payload.url), expiresAt: payload.exp };
  } catch {
    return null;
  }
}

async function fetchUpstream(targetUrl, env, init = {}) {
  // If a Render forward proxy is configured, route via the proxy
  if (env.FORWARD_PROXY_URL && typeof env.FORWARD_PROXY_URL === "string" && env.FORWARD_PROXY_URL.trim()) {
    const proxyBase = env.FORWARD_PROXY_URL.trim().replace(/\/+$/, "");
    const proxyUrl = new URL(proxyBase);
    proxyUrl.searchParams.set("url", targetUrl.href);

    const headers = new Headers(init.headers || {});
    if (env.FORWARD_PROXY_SECRET) {
      headers.set("X-Tunnel-Secret", env.FORWARD_PROXY_SECRET);
    }
    return fetch(proxyUrl.href, {
      ...init,
      headers,
    });
  }

  // Fallback to direct fetch
  return fetch(targetUrl, init);
}

async function fetchAllowedUrl(initialUrl, init, env = {}) {
  let url = validateMediaUrl(initialUrl.href);
  for (let redirects = 0; redirects <= 3; redirects += 1) {
    const response = await fetchUpstream(url, env, { ...init, redirect: "manual" });
    if (response.status < 300 || response.status > 399) return response;
    const location = response.headers.get("Location");
    if (!location || redirects === 3) return new Response(null, { status: 502 });
    url = validateMediaUrl(new URL(location, url).href);
  }
  return new Response(null, { status: 502 });
}

function streamExpiry(url) {
  const now = Math.floor(Date.now() / 1000);
  const upstreamExpiry = Number(url.searchParams.get("expires"));
  if (Number.isSafeInteger(upstreamExpiry) && upstreamExpiry > now) {
    return Math.min(upstreamExpiry, now + MAX_STREAM_TOKEN_SECONDS);
  }
  return now + 60 * 60;
}

function proxiedUrl(origin, token, targetUrl, fallbackExtension = "bin") {
  const extension = targetUrl.pathname.match(/\.([a-zA-Z0-9]{1,8})$/)?.[1]?.toLowerCase() ?? fallbackExtension;
  const url = new URL(`/api/hls/${token}.${extension}`, origin);
  return url.href;
}

async function rewritePlaylist(text, baseUrl, expiresAt, key, origin) {
  if (!text.startsWith("#EXTM3U")) throw new Error("invalid_hls_playlist");
  const lines = text.split(/\r?\n/);
  const rewritten = [];
  const uriAttribute = /\bURI="([^"]+)"/g;

  for (const line of lines) {
    if (!line.trim() || line.trim().startsWith("#")) {
      let output = "";
      let cursor = 0;
      for (const match of line.matchAll(uriAttribute)) {
        const start = match.index;
        const uriStart = start + match[0].indexOf(match[1]);
        output += line.slice(cursor, uriStart);
        const resolved = validateMediaUrl(new URL(match[1], baseUrl).href);
        const token = await encryptStreamTarget(resolved, expiresAt, key);
        output += proxiedUrl(origin, token, resolved);
        cursor = uriStart + match[1].length;
      }
      rewritten.push(output + line.slice(cursor));
      continue;
    }

    const leadingWhitespace = line.match(/^\s*/)?.[0] ?? "";
    const trailingWhitespace = line.match(/\s*$/)?.[0] ?? "";
    const rawUri = line.trim();
    const resolved = validateMediaUrl(new URL(rawUri, baseUrl).href);
    const token = await encryptStreamTarget(resolved, expiresAt, key);
    rewritten.push(`${leadingWhitespace}${proxiedUrl(origin, token, resolved)}${trailingWhitespace}`);
  }
  return rewritten.join("\n");
}

// --- Authentication & Rate Limiting ---
const rateLimitStore = new Map();
const STORE_MAX_ENTRIES = 10_000;

function cleanupRateLimitStore(nowMs) {
  if (rateLimitStore.size < STORE_MAX_ENTRIES) return;
  for (const [k, record] of rateLimitStore.entries()) {
    if (record.resetAt <= nowMs) {
      rateLimitStore.delete(k);
    }
  }
}

function getClientApiKey(request, url) {
  const authHeader = request.headers.get("Authorization");
  if (authHeader) {
    const match = authHeader.match(/^Bearer\s+(.+)$/i);
    if (match?.[1]) return match[1].trim();
  }
  const xApiKey = request.headers.get("X-API-Key");
  if (xApiKey) return xApiKey.trim();
  const queryKey = url.searchParams.get("api_key") || url.searchParams.get("key");
  if (queryKey) return queryKey.trim();
  return null;
}

function parseAllowedApiKeys(env) {
  const keys = [];
  if (typeof env.API_KEY === "string" && env.API_KEY.trim()) {
    keys.push(env.API_KEY.trim());
  }
  if (typeof env.API_KEYS === "string" && env.API_KEYS.trim()) {
    for (const k of env.API_KEYS.split(",")) {
      const trimmed = k.trim();
      if (trimmed) keys.push(trimmed);
    }
  }
  return keys;
}

async function timingSafeEqualString(a, b) {
  const enc = new TextEncoder();
  const hashA = await crypto.subtle.digest("SHA-256", enc.encode(a));
  const hashB = await crypto.subtle.digest("SHA-256", enc.encode(b));
  const bufA = new Uint8Array(hashA);
  const bufB = new Uint8Array(hashB);
  let diff = 0;
  for (let i = 0; i < bufA.length; i++) {
    diff |= bufA[i] ^ bufB[i];
  }
  return diff === 0;
}

async function authenticateRequest(request, url, env) {
  const allowedKeys = parseAllowedApiKeys(env);
  if (allowedKeys.length === 0) {
    return {
      authenticated: false,
      errorResponse: fail(503, "configuration_error", "API authentication is not configured on this server."),
    };
  }

  const clientKey = getClientApiKey(request, url);
  if (!clientKey) {
    return {
      authenticated: false,
      errorResponse: fail(
        401,
        "unauthorized",
        "Authentication required. Provide an API key via Authorization header, X-API-Key header, or ?api_key query parameter."
      ),
    };
  }

  for (const validKey of allowedKeys) {
    if (await timingSafeEqualString(clientKey, validKey)) {
      return { authenticated: true, apiKey: clientKey };
    }
  }

  return {
    authenticated: false,
    errorResponse: fail(403, "forbidden", "Invalid API key."),
  };
}

async function getClientIdentifier(request, apiKey) {
  if (apiKey) {
    const hash = await crypto.subtle.digest("SHA-256", new TextEncoder().encode(apiKey));
    const hex = Array.from(new Uint8Array(hash).slice(0, 8), (b) => b.toString(16).padStart(2, "0")).join("");
    return `key:${hex}`;
  }
  const cfIp = request.headers.get("cf-connecting-ip");
  if (cfIp) return `ip:${cfIp.trim()}`;
  const xForwardedFor = request.headers.get("x-forwarded-for");
  if (xForwardedFor) return `ip:${xForwardedFor.split(",")[0].trim()}`;
  return "ip:127.0.0.1";
}

async function checkRateLimit(request, env, options = {}) {
  const maxRequests = Number(env.RATE_LIMIT_MAX ?? options.maxRequests ?? 60);
  const windowSeconds = Number(env.RATE_LIMIT_WINDOW_SECONDS ?? options.windowSeconds ?? 60);
  const identifier = options.identifier || (await getClientIdentifier(request, options.apiKey));

  // 1. If Cloudflare native RateLimiter binding is configured, use it
  if (env.RATE_LIMITER && typeof env.RATE_LIMITER.limit === "function") {
    try {
      const outcome = await env.RATE_LIMITER.limit({ key: identifier });
      if (!outcome.success) {
        return {
          allowed: false,
          headers: {
            "Retry-After": String(windowSeconds),
            "RateLimit-Limit": String(maxRequests),
            "RateLimit-Remaining": "0",
            "RateLimit-Reset": String(windowSeconds),
          },
        };
      }
      return {
        allowed: true,
        headers: {
          "RateLimit-Limit": String(maxRequests),
        },
      };
    } catch (err) {
      console.warn("RATE_LIMITER binding error, falling back to in-memory limiter:", err);
    }
  }

  // 2. Built-in sliding-window limiter in Worker memory
  const now = Date.now();
  cleanupRateLimitStore(now);

  const windowMs = windowSeconds * 1000;
  let record = rateLimitStore.get(identifier);

  if (!record || record.resetAt <= now) {
    record = { count: 1, resetAt: now + windowMs };
    rateLimitStore.set(identifier, record);
    const resetSeconds = Math.ceil(windowMs / 1000);
    return {
      allowed: true,
      headers: {
        "RateLimit-Limit": String(maxRequests),
        "RateLimit-Remaining": String(Math.max(0, maxRequests - 1)),
        "RateLimit-Reset": String(resetSeconds),
      },
    };
  }

  record.count += 1;
  const remaining = Math.max(0, maxRequests - record.count);
  const resetSeconds = Math.max(1, Math.ceil((record.resetAt - now) / 1000));

  const headers = {
    "RateLimit-Limit": String(maxRequests),
    "RateLimit-Remaining": String(remaining),
    "RateLimit-Reset": String(resetSeconds),
  };

  if (record.count > maxRequests) {
    headers["Retry-After"] = String(resetSeconds);
    return {
      allowed: false,
      headers,
    };
  }

  return {
    allowed: true,
    headers,
  };
}

async function handleApiGuards(request, url, env) {
  // 1. IP-level rate limiting check to protect against unauthenticated floods
  const ipRate = await checkRateLimit(request, env, {});
  if (!ipRate.allowed) {
    return {
      pass: false,
      response: fail(
        429,
        "rate_limit_exceeded",
        "Rate limit exceeded. Please try again later.",
        ipRate.headers
      ),
    };
  }

  // 2. Authenticate the request
  const auth = await authenticateRequest(request, url, env);
  if (!auth.authenticated) {
    return {
      pass: false,
      response: new Response(auth.errorResponse.body, {
        status: auth.errorResponse.status,
        headers: {
          ...Object.fromEntries(auth.errorResponse.headers.entries()),
          ...ipRate.headers,
        },
      }),
    };
  }

  // 3. API key rate limiting check
  const keyRate = await checkRateLimit(request, env, { apiKey: auth.apiKey });
  if (!keyRate.allowed) {
    return {
      pass: false,
      response: fail(
        429,
        "rate_limit_exceeded",
        "Rate limit exceeded for this API key. Please try again later.",
        keyRate.headers
      ),
    };
  }

  return { pass: true, headers: keyRate.headers };
}

async function resolveWatch(slug, request, env, extraHeaders = {}) {
  if (!validateSlug(slug)) return fail(400, "invalid_slug", "The watch link is not valid.", extraHeaders);

  let key;
  try {
    key = await getEncryptionKey(env.STREAM_TOKEN_SECRET);
  } catch {
    return fail(503, "configuration_error", "The stream service is not configured.", extraHeaders);
  }

  try {
    const upstreamUrl = new URL(`/api/watch/${encodeURIComponent(slug)}`, API_ORIGIN);
    const upstream = await fetchUpstream(upstreamUrl, env, {
      headers: {
        ...DEFAULT_UPSTREAM_HEADERS,
        "Referer": `https://diskbunker.com/watch/${slug}`,
      },
      redirect: "manual",
      signal: AbortSignal.timeout(15_000),
    });
    if (upstream.status === 404) return fail(404, "link_not_found", "No video was found for this watch link.", extraHeaders);
    if (!upstream.ok) {
      const errText = await upstream.text().catch(() => "");
      return fail(502, "upstream_error", `Upstream returned status ${upstream.status}: ${errText.slice(0, 150)}`, extraHeaders);
    }

    const text = await readLimitedText(upstream, MAX_JSON_BYTES);
    let result;
    try {
      result = JSON.parse(text);
    } catch {
      return fail(502, "invalid_upstream_response", "The watch service returned invalid data.", extraHeaders);
    }
    const data = result?.data;
    if (!result?.success || !isRecord(data) || !isRecord(data.video)) {
      return fail(502, "invalid_upstream_response", "The watch service returned incomplete video data.", extraHeaders);
    }

    if (typeof data.video.hlsUrl === "string" && data.video.hlsUrl) {
      let hlsUrl;
      try {
        hlsUrl = validateMediaUrl(data.video.hlsUrl);
      } catch {
        return fail(502, "invalid_stream_url", "The watch service returned an unsupported stream URL.", extraHeaders);
      }
      const expiresAt = streamExpiry(hlsUrl);
      if (expiresAt <= Math.floor(Date.now() / 1000)) {
        return fail(502, "expired_stream_url", "The watch service returned an expired stream URL.", extraHeaders);
      }
      const token = await encryptStreamTarget(hlsUrl, expiresAt, key);
      data.video.hlsUrl = proxiedUrl(new URL(request.url).origin, token, hlsUrl, "m3u8");
    } else {
      data.video.hlsUrl = null;
    }

    if (typeof data.video.thumbnail === "string" && data.video.thumbnail) {
      try {
        const thumbUrl = validateMediaUrl(data.video.thumbnail);
        const expiresAt = Math.floor(Date.now() / 1000) + MAX_STREAM_TOKEN_SECONDS;
        const token = await encryptStreamTarget(thumbUrl, expiresAt, key);
        data.video.thumbnail = proxiedUrl(new URL(request.url).origin, token, thumbUrl, "jpg");
      } catch (err) {
        console.warn("Could not proxy thumbnail:", err);
      }
    }

    if (isRecord(data.link) && typeof data.link.creatorAvatar === "string" && data.link.creatorAvatar) {
      try {
        const avatarUrl = validateMediaUrl(data.link.creatorAvatar);
        const expiresAt = Math.floor(Date.now() / 1000) + MAX_STREAM_TOKEN_SECONDS;
        const token = await encryptStreamTarget(avatarUrl, expiresAt, key);
        data.link.creatorAvatar = proxiedUrl(new URL(request.url).origin, token, avatarUrl, "jpg");
      } catch (err) {
        console.warn("Could not proxy creatorAvatar:", err);
      }
    }

    return json(result, 200, extraHeaders);
  } catch (error) {
    if (error?.name === "TimeoutError") return fail(504, "upstream_timeout", "The watch service took too long to respond.", extraHeaders);
    return fail(502, "upstream_error", `The watch service could not resolve this link (${error?.message || error}).`, extraHeaders);
  }
}

function streamResponseHeaders(upstream) {
  const headers = new Headers(corsHeaders());
  for (const name of ["Accept-Ranges", "Content-Length", "Content-Range", "Content-Type", "ETag", "Last-Modified"]) {
    const value = upstream.headers.get(name);
    if (value) headers.set(name, value);
  }
  const cacheControl = upstream.headers.get("Cache-Control");
  if (cacheControl) {
    headers.set("Cache-Control", cacheControl);
  } else {
    headers.set("Cache-Control", "public, max-age=86400");
  }
  return headers;
}

async function proxyHls(request, env) {
  const url = new URL(request.url);
  const match = url.pathname.match(/^\/api\/hls\/([a-zA-Z0-9_-]{32,8192})(?:\.([a-zA-Z0-9]{1,8}))?$/);
  const token = match?.[1] ?? url.searchParams.get("token");
  if (!token) return fail(400, "missing_token", "A stream token is required.");

  let key;
  try {
    key = await getEncryptionKey(env.STREAM_TOKEN_SECRET);
  } catch {
    return fail(503, "configuration_error", "The stream service is not configured.");
  }
  const target = await decryptStreamTarget(token, key);
  if (!target) return fail(403, "invalid_or_expired_token", "The stream URL is invalid or expired.");

  const range = request.headers.get("Range");
  const ifRange = request.headers.get("If-Range");
  const requestHeaders = new Headers(DEFAULT_UPSTREAM_HEADERS);
  if (range) requestHeaders.set("Range", range);
  if (ifRange) requestHeaders.set("If-Range", ifRange);

  try {
    const upstream = await fetchAllowedUrl(
      target.url,
      {
        method: request.method,
        headers: requestHeaders,
        signal: request.signal,
      },
      env
    );
    if (upstream.status >= 500) return fail(502, "stream_upstream_error", "The HLS stream could not be fetched.");
    if (upstream.status >= 300 && upstream.status < 400) return fail(502, "stream_redirect_error", "The HLS stream returned an unsupported redirect.");

    const contentType = upstream.headers.get("Content-Type") ?? "";
    const isPlaylist = /mpegurl/i.test(contentType) || /\.m3u8$/i.test(target.url.pathname);
    if (isPlaylist && request.method !== "HEAD" && upstream.ok) {
      let text;
      try {
        text = await readLimitedText(upstream, MAX_PLAYLIST_BYTES);
        text = await rewritePlaylist(text, upstream.url || target.url.href, target.expiresAt, key, new URL(request.url).origin);
      } catch {
        return fail(502, "invalid_hls_playlist", "The HLS playlist could not be processed safely.");
      }
      return new Response(text, {
        status: upstream.status,
        headers: (() => {
          const headers = streamResponseHeaders(upstream);
          headers.delete("Content-Length");
          headers.delete("Content-Range");
          headers.set("Content-Type", "application/vnd.apple.mpegurl; charset=utf-8");
          return headers;
        })(),
      });
    }

    return new Response(request.method === "HEAD" ? null : upstream.body, {
      status: upstream.status,
      headers: streamResponseHeaders(upstream),
    });
  } catch (error) {
    if (error?.name === "TimeoutError") return fail(504, "stream_timeout", "The HLS stream took too long to respond.");
    return fail(502, "stream_upstream_error", "The HLS stream could not be fetched.");
  }
}

export default {
  async fetch(request, env) {
    const url = new URL(request.url);
    if (request.method === "OPTIONS") {
      return new Response(null, { status: 204, headers: corsHeaders() });
    }
    if (url.pathname === "/" && request.method === "GET") {
      return json({
        success: true,
        service: "Diskbunker Link API",
        routes: {
          health: "GET /healthz",
          watch: "GET /api/watch/{slug} [Requires API key]",
          resolve: "GET /api/resolve?url={encoded Diskbunker watch URL} [Requires API key]",
          hls: "Use the .m3u8 hlsUrl returned by watch or resolve (self-authenticated via signed token).",
          player: "GET /play/{slug}?api_key={key} opens the browser HLS player.",
        },
        authentication: {
          description: "Provide an API key via header or query parameter.",
          headers: ["Authorization: Bearer <key>", "X-API-Key: <key>"],
          queryParam: "?api_key=<key> or ?key=<key>",
        },
        rateLimiting: {
          scope: "/api/watch and /api/resolve",
          defaultLimit: "60 requests / minute per client",
          headers: ["RateLimit-Limit", "RateLimit-Remaining", "RateLimit-Reset", "Retry-After"],
        },
        example: `/api/watch/69d5abd3e9b483a250dc8a49`,
      });
    }
    if (url.pathname === "/healthz" && request.method === "GET") {
      return json({ success: true, service: "db-api" });
    }
    if (request.method === "GET" && url.pathname === "/api/resolve") {
      const guards = await handleApiGuards(request, url, env);
      if (!guards.pass) return guards.response;

      const slug = getSlugFromWatchUrl(url.searchParams.get("url") ?? "");
      return slug
        ? resolveWatch(slug, request, env, guards.headers)
        : fail(400, "invalid_watch_url", "Use an HTTPS Diskbunker /watch/{slug} link.", guards.headers);
    }
    const watchMatch = url.pathname.match(/^\/api\/watch\/([a-zA-Z0-9_-]{6,128})\/?$/);
    if (request.method === "GET" && watchMatch) {
      const guards = await handleApiGuards(request, url, env);
      if (!guards.pass) return guards.response;

      return resolveWatch(watchMatch[1], request, env, guards.headers);
    }
    const playerMatch = url.pathname.match(/^\/play\/([a-zA-Z0-9_-]{6,128})\/?$/);
    if (request.method === "GET" && playerMatch) {
      return new Response(`<!doctype html>
<html lang="en">
<head>
  <meta charset="utf-8">
  <meta name="viewport" content="width=device-width, initial-scale=1">
  <meta name="color-scheme" content="dark">
  <title>Diskbunker Player</title>
  <link rel="stylesheet" href="/assets/player.css">
  <script src="/assets/hls.min.js" defer></script>
  <script src="/assets/player.js" defer></script>
</head>
<body>
  <main>
    <h1 id="title">Diskbunker Player</h1>
    <video id="video" controls playsinline preload="metadata" aria-label="Video player"></video>
    <p id="status" role="status" aria-live="polite">Loading stream…</p>
  </main>
</body>
</html>`, {
        headers: {
          ...corsHeaders(),
          "Content-Type": "text/html; charset=utf-8",
          "Cache-Control": "no-store",
          "Content-Security-Policy": "default-src 'none'; script-src 'self'; style-src 'self'; connect-src 'self'; media-src 'self' blob:; worker-src 'self' blob:; img-src 'self' data:; base-uri 'none'; frame-ancestors 'none'",
          "Referrer-Policy": "no-referrer",
        },
      });
    }
    if (
      (request.method === "GET" || request.method === "HEAD") &&
      (url.pathname === "/api/hls" || /^\/api\/hls\/[a-zA-Z0-9_-]{32,8192}(?:\.[a-zA-Z0-9]{1,8})?$/.test(url.pathname))
    ) {
      return proxyHls(request, env);
    }
    return fail(404, "not_found", "This API route does not exist.");
  },
};
