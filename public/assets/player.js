const video = document.querySelector("#video");
const status = document.querySelector("#status");
const title = document.querySelector("#title");
const slug = location.pathname.match(/^\/play\/([a-zA-Z0-9_-]{6,128})\/?$/)?.[1];

function showError(message) {
  status.textContent = message;
}

async function start() {
  if (!slug) {
    showError("This watch link is invalid.");
    return;
  }

  try {
    const params = new URLSearchParams(location.search);
    const apiKey = params.get("api_key") || params.get("key");
    const watchUrl = new URL(`/api/watch/${encodeURIComponent(slug)}`, location.origin);
    if (apiKey) {
      watchUrl.searchParams.set("api_key", apiKey);
    }

    const headers = { Accept: "application/json" };
    if (apiKey) {
      headers["X-API-Key"] = apiKey;
    }

    const response = await fetch(watchUrl.href, {
      headers,
      cache: "no-store",
    });
    const result = await response.json();
    const data = result?.data;
    if (!response.ok || !result?.success || !data?.video) {
      throw new Error(result?.error?.message || "Could not resolve this watch link.");
    }
    title.textContent = data.video.title || "Diskbunker Player";
    if (!data.video.hlsUrl) throw new Error("This video does not have an HLS stream yet.");

    if (window.Hls?.isSupported()) {
      const hls = new Hls();
      hls.loadSource(data.video.hlsUrl);
      hls.attachMedia(video);
      hls.on(Hls.Events.MANIFEST_PARSED, () => {
        status.textContent = "Stream ready. Press play.";
      });
      hls.on(Hls.Events.ERROR, (_event, error) => {
        if (error.fatal) showError("Playback failed while loading the HLS stream.");
      });
      return;
    }

    if (video.canPlayType("application/vnd.apple.mpegurl")) {
      video.src = data.video.hlsUrl;
      status.textContent = "Stream ready. Press play.";
      return;
    }

    showError("This browser does not support HLS playback.");
  } catch (error) {
    showError(error instanceof Error ? error.message : "Could not load this video.");
  }
}

void start();
