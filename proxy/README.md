# Diskbunker Tunnel (Render Forward Proxy)

A zero-dependency Node.js forward proxy designed to be deployed on **Render** (Free Web Service). It proxies upstream requests to Diskbunker without Cloudflare Worker headers, bypassing Diskbunker's worker-blocking firewall rules.

## Deploy to Render in 2 Minutes

1. **Create a new Web Service** on [dashboard.render.com](https://dashboard.render.com).
2. Connect your Git repository (or push this `proxy/` folder to a separate GitHub repo).
   - If deploying from the monorepo root:
     - **Root Directory**: `proxy`
     - **Build Command**: `npm install` (or leave empty, 0 dependencies)
     - **Start Command**: `node server.js`
3. **Environment Variables**:
   - `PORT`: `3000` (Render sets this automatically)
   - `TUNNEL_SECRET`: **(required)** A long random token that restricts access to your Cloudflare Worker. The server refuses to start without it. Generate one with `node -e "console.log(require('crypto').randomBytes(32).toString('hex'))"`.

## Connecting to Your Cloudflare Worker

Once your Render service is live (e.g. `https://my-diskbunker-tunnel.onrender.com`), add the following secrets to your Cloudflare Worker:

```powershell
npx wrangler secret put FORWARD_PROXY_URL
# Enter: https://my-diskbunker-tunnel.onrender.com

npx wrangler secret put FORWARD_PROXY_SECRET
# Enter: the same value as TUNNEL_SECRET
```

The Worker will automatically route upstream watch lookups through your Render proxy!
