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
  const reqUrl = new URL(req.url, `http://${req.headers.host || "localhost"}`);

  // 1. Health check (only when no proxy target is provided)
  const targetUrlStr = reqUrl.searchParams.get("url") || req.headers["x-target-url"];

  if ((reqUrl.pathname === "/" || reqUrl.pathname === "/healthz") && !targetUrlStr) {
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

  // 3. Diagnostics probe endpoint
  if (reqUrl.pathname === "/test-player") {
    const testUrl = reqUrl.searchParams.get("target") || "https://player.diskbunker.com/videos/6addf69c098a986422e68fdc/hls/stream_0/playlist.m3u8";
    const tests = [
      {
        name: "chrome_clean",
        headers: {
          "User-Agent": "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/124.0.0.0 Safari/537.36",
          "Referer": "https://diskbunker.com/",
          "Accept": "*/*",
        },
      },
      {
        name: "chrome_watch_referer",
        headers: {
          "User-Agent": "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/124.0.0.0 Safari/537.36",
          "Referer": "https://diskbunker.com/watch/69d5abd3e9b483a250dc8a49",
          "Accept": "*/*",
        },
      },
      {
        name: "okhttp_clean",
        headers: {
          "User-Agent": "okhttp/4.12.0",
          "Referer": "https://diskbunker.com/",
          "Accept": "*/*",
        },
      },
      {
        name: "curl_clean",
        headers: {
          "User-Agent": "curl/8.4.0",
          "Referer": "https://diskbunker.com/",
        },
      },
    ];

    const results = [];
    for (const t of tests) {
      try {
        const resp = await fetch(testUrl, {
          method: "GET",
          headers: t.headers,
          signal: AbortSignal.timeout(6000),
        });
        const text = await resp.text();
        results.push({
          name: t.name,
          status: resp.status,
          title: text.match(/<title>(.*?)<\/title>/i)?.[1] ?? null,
          preview: text.slice(0, 100),
        });
      } catch (err) {
        results.push({ name: t.name, error: err.message });
      }
    }

    res.writeHead(200, { "Content-Type": "application/json" });
    res.end(JSON.stringify({ success: true, results }));
    return;
  }

  // 4. Extract target URL from query parameter or header
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
      "User-Agent":
        req.headers["x-custom-ua"] ||
        (targetUrl.hostname === "api.diskbunker.com"
          ? "okhttp/4.12.0"
          : "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/124.0.0.0 Safari/537.36"),
      "Accept": req.headers["accept"] && req.headers["accept"] !== "application/json" ? req.headers["accept"] : "*/*",
      "Referer": req.headers["x-custom-referer"] || "https://diskbunker.com/",
    };

    if (req.headers["range"]) {
      forwardHeaders["Range"] = req.headers["range"];
    }

    if (req.headers["origin"]) {
      forwardHeaders["Origin"] = req.headers["origin"];
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
