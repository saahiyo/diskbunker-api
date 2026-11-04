# Diskbunker API — Quick Guide

**Base URL**: `https://db-api.shakir-ansarii075.workers.dev`  
**API Key**: Pass `X-API-Key: <YOUR_KEY>` header or `?api_key=<YOUR_KEY>` query param.

---

## Quick Start

```bash
curl -H "X-API-Key: YOUR_API_KEY" \
  https://db-api.shakir-ansarii075.workers.dev/api/watch/69d5abd3e9b483a250dc8a49
```

**Response**:
```json
{
  "success": true,
  "data": {
    "video": {
      "title": "recorded",
      "thumbnail": "https://db-api.shakir-ansarii075.workers.dev/api/hls/...jpg",
      "hlsUrl": "https://db-api.shakir-ansarii075.workers.dev/api/hls/...m3u8"
    },
    "link": {
      "creator": "Saahiyo Lin",
      "creatorAvatar": "https://db-api.shakir-ansarii075.workers.dev/api/hls/...jpg"
    }
  }
}
```

> **Note**: `hlsUrl`, `thumbnail`, and `creatorAvatar` are proxied directly through the Worker for privacy and streaming speed.

---

## Endpoints

| Endpoint | Auth? | What it does |
| :--- | :---: | :--- |
| `GET /api/watch/{slug}` | **Yes** | Resolve video info, stream (`.m3u8`), and thumbnail by slug |
| `GET /api/resolve?url={full_url}` | **Yes** | Same as above, but accepts full `https://diskbunker.com/watch/{slug}` |
| `GET /play/{slug}?api_key={key}` | URL | Open video in browser test player |
| `GET /healthz` | No | Check if server is running (`{"success": true}`) |

---

## How to Authenticate

Pick any **one** of these:
1. **Header (Best)**: `X-API-Key: YOUR_API_KEY`
2. **Bearer**: `Authorization: Bearer YOUR_API_KEY`
3. **URL Param**: `?api_key=YOUR_API_KEY`

---

## Code Examples

### JavaScript (Fetch)
```javascript
const res = await fetch("https://db-api.shakir-ansarii075.workers.dev/api/watch/69d5abd3e9b483a250dc8a49", {
  headers: { "X-API-Key": "YOUR_API_KEY" }
});
const { data } = await res.json();
console.log("Video Stream:", data.video.hlsUrl);
```

### Python
```python
import requests

res = requests.get(
  "https://db-api.shakir-ansarii075.workers.dev/api/watch/69d5abd3e9b483a250dc8a49",
  headers={"X-API-Key": "YOUR_API_KEY"}
)
print("Video Stream:", res.json()["data"]["video"]["hlsUrl"])
```
