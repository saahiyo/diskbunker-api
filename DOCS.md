# Diskbunker API — Implementer & Integration Guide

A fast, authenticated Cloudflare Worker API that resolves Diskbunker watch links into structured video metadata and playable HLS stream URLs.

---

## 1. Overview & Base URL

- **Production Base URL**: `https://db-api.shakir-ansarii075.workers.dev`
- **Health Check**: `GET https://db-api.shakir-ansarii075.workers.dev/healthz` (`{"success": true}`)

---

## 2. Authentication

Every API call requires an API key. You can pass it using any **one** of these three methods:

| Method | Syntax | Recommended |
| :--- | :--- | :---: |
| **HTTP Header** | `X-API-Key: <YOUR_API_KEY>` | **Yes** |
| **Bearer Token** | `Authorization: Bearer <YOUR_API_KEY>` | Yes |
| **Query Param** | `?api_key=<YOUR_API_KEY>` | For quick testing |

---

## 3. Endpoints

### A. Resolve Video by Slug
```http
GET /api/watch/{slug}
```
**Example**:
```bash
curl -H "X-API-Key: YOUR_API_KEY" \
  https://db-api.shakir-ansarii075.workers.dev/api/watch/69d5abd3e9b483a250dc8a49
```

### B. Resolve Video by Full URL
```http
GET /api/resolve?url=https://diskbunker.com/watch/{slug}
```
**Example**:
```bash
curl -H "X-API-Key: YOUR_API_KEY" \
  "https://db-api.shakir-ansarii075.workers.dev/api/resolve?url=https://diskbunker.com/watch/69d5abd3e9b483a250dc8a49"
```

---

## 4. Response Format

### Success (`200 OK`)
```json
{
  "success": true,
  "data": {
    "video": {
      "id": "6addf69c098a986422e68fdc",
      "title": "sample_video_title",
      "description": "",
      "duration": 28.9,
      "fileSize": 32416531,
      "createdAt": "2026-10-25T12:31:24.773Z",
      "thumbnail": "https://db-api.shakir-ansarii075.workers.dev/api/hls/<token>.jpg",
      "hlsUrl": "https://db-api.shakir-ansarii075.workers.dev/api/hls/<token>.m3u8"
    },
    "link": {
      "id": "6addf6a8098a986422e69036",
      "slug": "69d5abd3e9b483a250dc8a49",
      "creator": "Creator Name",
      "creatorAvatar": "https://db-api.shakir-ansarii075.workers.dev/api/hls/<token>.jpg"
    }
  }
}
```

---

## 5. Streaming Rules & Player Setup (Crucial)

Diskbunker’s upstream media CDN enforces a strict referrer security policy. 

> [!IMPORTANT]
> When your video player requests the HLS playlist (`.m3u8`) or video segments (`.ts`), your player **must include the following HTTP header**:
> ```http
> Referer: https://diskbunker.com/
> ```
> Normal user devices (phones, tablets, PCs) pass through with `200 OK`. Requests without this header are rejected with `403 Forbidden`.

---

## 6. Implementation Code Examples

### Android (ExoPlayer / Media3)
```kotlin
val defaultHttpDataSourceFactory = DefaultHttpDataSource.Factory()
    .setUserAgent("okhttp/4.12.0")
    .setDefaultRequestProperties(
        mapOf("Referer" to "https://diskbunker.com/")
    )

val mediaSource = HlsMediaSource.Factory(defaultHttpDataSourceFactory)
    .createMediaSource(MediaItem.fromUri(videoHlsUrl))

exoPlayer.setMediaSource(mediaSource)
exoPlayer.prepare()
exoPlayer.play()
```

### iOS (Swift / AVPlayer)
```swift
import AVFoundation

guard let url = URL(string: videoHlsUrl) else { return }
let headers: [String: String] = ["Referer": "https://diskbunker.com/"]
let asset = AVURLAsset(url: url, options: ["AVURLAssetHTTPHeaderFieldsKey": headers])
let playerItem = AVPlayerItem(asset: asset)
let player = AVPlayer(playerItem: playerItem)
player.play()
```

### Flutter (`video_player`)
```dart
import 'package:video_player/video_player.dart';

final controller = VideoPlayerController.networkUrl(
  Uri.parse(videoHlsUrl),
  httpHeaders: {
    'Referer': 'https://diskbunker.com/',
  },
);

await controller.initialize();
controller.play();
```

### Python (Download / Stream Segments)
```python
import requests

API_KEY = "YOUR_API_KEY"
SLUG = "69d5abd3e9b483a250dc8a49"

# 1. Resolve video details
resp = requests.get(
    f"https://db-api.shakir-ansarii075.workers.dev/api/watch/{SLUG}",
    headers={"X-API-Key": API_KEY}
)
data = resp.json()["data"]
hls_url = data["video"]["hlsUrl"]
print("Resolved Title:", data["video"]["title"])
print("HLS URL:", hls_url)

# 2. Fetch playlist (must send Referer)
stream_res = requests.get(
    hls_url,
    headers={"Referer": "https://diskbunker.com/"}
)
print("Playlist status:", stream_res.status_code)
```

### Node.js / JavaScript
```javascript
const API_KEY = "YOUR_API_KEY";
const SLUG = "69d5abd3e9b483a250dc8a49";

// 1. Resolve video
const res = await fetch(`https://db-api.shakir-ansarii075.workers.dev/api/watch/${SLUG}`, {
  headers: { "X-API-Key": API_KEY }
});
const { data } = await res.json();
console.log("Title:", data.video.title);

// 2. Load stream (with Referer header)
const playlistRes = await fetch(data.video.hlsUrl, {
  headers: { "Referer": "https://diskbunker.com/" }
});
console.log("Playlist HTTP Status:", playlistRes.status);
```

### CLI / VLC / mpv / ffmpeg
```bash
# Play directly in mpv
mpv --http-header-fields="Referer: https://diskbunker.com/" "<HLS_URL>"

# Convert / Download with ffmpeg
ffmpeg -headers "Referer: https://diskbunker.com/" -i "<HLS_URL>" -c copy output.mp4
```

---

## 7. Rate Limiting & Quotas

- **Default Limit**: 60 requests per 60 seconds per API key (and per client IP for public endpoints).
- **RFC Standard Headers Returned**:
  - `RateLimit-Limit`: Maximum requests per window (e.g. `60`)
  - `RateLimit-Remaining`: Remaining requests in current window
  - `RateLimit-Reset`: Seconds remaining until window resets
  - `Retry-After`: Returned on `429 Too Many Requests` indicating how many seconds to pause before retrying.

---

## 8. Error Codes & Handling

| HTTP Code | Error Code | Description | Fix |
| :---: | :--- | :--- | :--- |
| `400` | `invalid_slug` | Slug contains invalid characters or length | Ensure slug is 6-128 chars `[a-zA-Z0-9_-]` |
| `401` | `unauthorized` | Missing API key | Supply `X-API-Key` or `Authorization: Bearer` |
| `403` | `forbidden` | Invalid API key | Verify key against your configured secret |
| `404` | `link_not_found` | Video does not exist or was deleted | Verify link exists on Diskbunker |
| `429` | `rate_limit_exceeded` | Exceeded 60 requests/minute | Inspect `Retry-After` header and back off |
| `502` | `upstream_error` | Diskbunker origin service unreachable | Retry with exponential backoff |
| `503` | `configuration_error` | Missing worker secrets | Ensure `API_KEY` and `STREAM_TOKEN_SECRET` are set |
