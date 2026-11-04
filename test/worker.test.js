import worker from "../src/index.js";

async function runTests() {
  console.log("Running Diskbunker API tests...\n");

  const env = {
    STREAM_TOKEN_SECRET: "01234567890123456789012345678901",
    API_KEY: "test-secret-key-123",
    RATE_LIMIT_MAX: "100",
    RATE_LIMIT_WINDOW_SECONDS: "60",
  };

  const req = (url, headers = {}, ip = "192.0.2.1") => {
    return new Request(url, {
      headers: {
        "cf-connecting-ip": ip,
        ...headers,
      },
    });
  };

  // 1. Health check is public
  let res = await worker.fetch(req("http://localhost/healthz"), env);
  console.assert(res.status === 200, "1. /healthz must return 200");
  console.log("✔ 1. Public /healthz returns 200");

  // 2. Info / docs is public
  res = await worker.fetch(req("http://localhost/"), env);
  console.assert(res.status === 200, "2. / must return 200");
  const info = await res.json();
  console.assert(info.authentication && info.rateLimiting, "2. / docs describe auth and rate limiting");
  console.log("✔ 2. Public / docs return 200 with auth and rate limiting metadata");

  // 3. /api/watch missing auth -> 401
  res = await worker.fetch(req("http://localhost/api/watch/69d5abd3e9b483a250dc8a49", {}, "192.0.2.2"), env);
  console.assert(res.status === 401, "3. Missing auth must return 401");
  const err401 = await res.json();
  console.assert(err401.error?.code === "unauthorized", "3. Error code must be unauthorized");
  console.log("✔ 3. Missing authentication returns 401 Unauthorized");

  // 4. /api/watch invalid auth -> 403
  res = await worker.fetch(
    req("http://localhost/api/watch/69d5abd3e9b483a250dc8a49", { Authorization: "Bearer wrong-key" }, "192.0.2.3"),
    env
  );
  console.assert(res.status === 403, "4. Invalid key must return 403");
  const err403 = await res.json();
  console.assert(err403.error?.code === "forbidden", "4. Error code must be forbidden");
  console.log("✔ 4. Invalid authentication key returns 403 Forbidden");

  // 5. Valid auth via Bearer header
  res = await worker.fetch(
    req("http://localhost/api/watch/123456", { Authorization: "Bearer test-secret-key-123" }, "192.0.2.4"),
    env
  );
  console.assert(res.headers.has("ratelimit-remaining"), "5. Valid key allows request and attaches rate limit headers");
  console.log("✔ 5. Valid Authorization: Bearer header accepted");

  // 6. Valid auth via X-API-Key header
  res = await worker.fetch(
    req("http://localhost/api/watch/123456", { "X-API-Key": "test-secret-key-123" }, "192.0.2.5"),
    env
  );
  console.assert(res.headers.has("ratelimit-remaining"), "6. Valid key allows request and attaches rate limit headers");
  console.log("✔ 6. Valid X-API-Key header accepted");

  // 7. Valid auth via query parameter ?api_key=
  res = await worker.fetch(
    req("http://localhost/api/watch/123456?api_key=test-secret-key-123", {}, "192.0.2.6"),
    env
  );
  console.assert(res.headers.has("ratelimit-remaining"), "7. Valid query param allows request and attaches rate limit headers");
  console.log("✔ 7. Valid ?api_key query parameter accepted");

  // 8. Live resolve proxies hlsUrl, thumbnail, and creator avatar
  const watchRes = await worker.fetch(
    req("http://localhost/api/watch/69d5abd3e9b483a250dc8a49", { "X-API-Key": "test-secret-key-123" }, "192.0.2.7"),
    env
  );
  console.assert(watchRes.status === 200, "8. Live watch resolve must return 200");
  const watchData = await watchRes.json();
  const thumb = watchData.data?.video?.thumbnail;
  const avatar = watchData.data?.link?.creatorAvatar;
  console.assert(thumb && thumb.includes("/api/hls/"), "8. Video thumbnail must be proxied through worker");
  console.assert(avatar && avatar.includes("/api/hls/"), "8. Creator avatar must be proxied through worker");
  console.log("✔ 8. Video thumbnail and creator avatar are proxied through the Worker");

  // 9. Rate limiting countdown & 429 block
  const rateLimitEnv = {
    ...env,
    API_KEY: "rate-limit-test-key",
    RATE_LIMIT_MAX: "2",
    RATE_LIMIT_WINDOW_SECONDS: "10",
  };
  const testIp = "198.51.100.99";
  const r1 = await worker.fetch(
    req("http://localhost/api/watch/123456", { "X-API-Key": "rate-limit-test-key" }, testIp),
    rateLimitEnv
  );
  const r2 = await worker.fetch(
    req("http://localhost/api/watch/123456", { "X-API-Key": "rate-limit-test-key" }, testIp),
    rateLimitEnv
  );
  const r3 = await worker.fetch(
    req("http://localhost/api/watch/123456", { "X-API-Key": "rate-limit-test-key" }, testIp),
    rateLimitEnv
  );

  console.assert(r1.headers.get("ratelimit-remaining") === "1", "9. First request remaining must be 1");
  console.assert(r2.headers.get("ratelimit-remaining") === "0", "9. Second request remaining must be 0");
  console.assert(r3.status === 429, "9. Third request must return 429 Too Many Requests");
  console.assert(Boolean(r3.headers.get("retry-after")), "9. 429 must include Retry-After header");
  console.log("✔ 9. Rate limiting decrements remaining count and returns 429 + Retry-After when exceeded");

  // 10. CORS preflight OPTIONS includes auth & rate limit headers
  const preflight = await worker.fetch(
    new Request("http://localhost/api/watch/123", {
      method: "OPTIONS",
      headers: { Origin: "https://example.com" },
    }),
    env
  );
  console.assert(preflight.status === 204, "10. OPTIONS preflight must return 204");
  const allowHeaders = preflight.headers.get("access-control-allow-headers") || "";
  console.assert(allowHeaders.includes("Authorization") && allowHeaders.includes("X-API-Key"), "10. CORS preflight allows auth headers");
  console.log("✔ 10. CORS preflight allows Authorization & X-API-Key headers");

  console.log("\nAll tests passed successfully!");
}

runTests().catch((err) => {
  console.error("Test execution failed:", err);
  process.exit(1);
});
