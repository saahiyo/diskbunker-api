import http from "node:http";

const PORT = process.env.PORT || 3000;
const TUNNEL_SECRET = process.env.TUNNEL_SECRET || "";

// Allowed upstream hosts to prevent open proxy abuse
const ALLOWED_HOSTS = new Set([
  "api.diskbunker.com",
  "diskbunker.com",
  "www.diskbunker.com",
  "player.diskbunker.com",
]);

const server = http.createServer(async (req, res) => {
  // 1. Health check
  if (req.url === "/" || req.url === "/healthz") {
    res.writeHead(200, { "Content-Type": "application/json" });
    res.end(JSON.stringify({ success: true, service: "diskbunker-tunnel" }));
    return;
  }

  // 2. Secret authentication (if TUNNEL_SECRET is configured)
  if (TUNNEL_SECRET) {
    const authHeader = req.headers["x-tunnel-secret"] || req.headers["authorization"];
    const token = authHeader?.replace(/^Bearer\s+/i, "");
    if (token !== TUNNEL_SECRET) {
      res.writeHead(401, { "Content-Type": "application/json" });
      res.end(JSON.stringify({ success: false, error: "unauthorized" }));
      return;
    }
  }

  // 3. Extract target URL from query parameter or header
  const reqUrl = new URL(req.url, `http://${req.headers.host}`);
  const targetUrlStr = reqUrl.searchParams.get("url") || req.headers["x-target-url"];

  if (!targetUrlStr) {
    res.writeHead(400, { "Content-Type": "application/json" });
    res.end(JSON.stringify({ success: false, error: "missing_target_url" }));
    return;
  }

  let targetUrl;
  try {
    targetUrl = new URL(targetUrlStr);
  } catch {
    res.writeHead(400, { "Content-Type": "application/json" });
    res.end(JSON.stringify({ success: false, error: "invalid_target_url" }));
    return;
  }

  if (targetUrl.protocol !== "https:" || !ALLOWED_HOSTS.has(targetUrl.hostname)) {
    res.writeHead(403, { "Content-Type": "application/json" });
    res.end(JSON.stringify({ success: false, error: "host_not_allowed" }));
    return;
  }

  try {
    // Construct clean forward headers
    const forwardHeaders = {
      "User-Agent": "okhttp/4.12.0",
      "Accept": req.headers["accept"] || "application/json",
      "Referer": "https://diskbunker.com/",
      "Origin": "https://diskbunker.com",
    };

    if (req.headers["range"]) {
      forwardHeaders["Range"] = req.headers["range"];
    }

    const upstreamRes = await fetch(targetUrl.href, {
      method: req.method,
      headers: forwardHeaders,
      signal: AbortSignal.timeout(15_000),
    });

    const responseHeaders = {};
    for (const [key, value] of upstreamRes.headers.entries()) {
      if (!["content-encoding", "content-security-policy"].includes(key.toLowerCase())) {
        responseHeaders[key] = value;
      }
    }

    res.writeHead(upstreamRes.status, responseHeaders);

    if (upstreamRes.body) {
      const reader = upstreamRes.body.getReader();
      while (true) {
        const { done, value } = await reader.read();
        if (done) break;
        res.write(value);
      }
    }
    res.end();
  } catch (err) {
    console.error("Tunnel forward error:", err);
    if (!res.headersSent) {
      res.writeHead(502, { "Content-Type": "application/json" });
      res.end(JSON.stringify({ success: false, error: "upstream_connect_failed", message: err.message }));
    }
  }
});

server.listen(PORT, () => {
  console.log(`Diskbunker Tunnel running on port ${PORT}`);
});
