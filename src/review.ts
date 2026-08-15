import { api, uploadBlob, getTokens, APP_URL } from "./lib/api.js";

const $ = <T extends HTMLElement>(id: string) => document.getElementById(id) as T;

interface ReviewData { blobUrl: string; eventsJsonl: string; mode: string; durationMs: number }

async function main() {
  const { review } = (await chrome.storage.session.get("review")) as { review?: ReviewData };
  if (!review) {
    $("status").textContent = "No recording found. Record something first.";
    return;
  }
  // The blobUrl was minted in the offscreen document; fetch it from there via message is complex —
  // instead re-fetch it directly (blob: URLs are origin-scoped to the extension, so this works).
  const blob = await (await fetch(review.blobUrl)).blob();
  const video = $("preview") as HTMLVideoElement;
  video.src = URL.createObjectURL(blob);

  const durSec = Math.round(review.durationMs / 1000);
  $("meta").textContent = `${Math.floor(durSec / 60)}:${String(durSec % 60).padStart(2, "0")} · ${(blob.size / 1024 / 1024).toFixed(1)} MB · ${review.eventsJsonl.split("\n").filter(Boolean).length} events captured`;
  ($("mode") as HTMLSelectElement).value = review.mode;

  $("save").onclick = () => {
    const a = document.createElement("a");
    a.href = video.src;
    a.download = `scenerecap-${Date.now()}.webm`;
    a.click();
  };

  $("upload").onclick = async () => {
    const btn = $("upload") as HTMLButtonElement;
    btn.disabled = true;
    const status = $("status");
    try {
      const { accessToken } = await getTokens();
      if (!accessToken) {
        status.innerHTML = `Sign in first — <a href="${APP_URL}/auth/extension" target="_blank">open sign-in</a>, then click Upload again.`;
        btn.disabled = false;
        return;
      }
      status.textContent = "Uploading video…";
      const mediaId = await uploadBlob(blob, "recording.webm", "video/webm", "media");
      status.textContent = "Uploading activity log…";
      const eventsId = await uploadBlob(new Blob([review.eventsJsonl], { type: "application/jsonl" }), "events.jsonl", "application/jsonl", "eventlog");
      status.textContent = "Creating recording…";
      const { recording } = await api<{ recording: { id: string } }>("/v1/recordings", {
        method: "POST",
        body: {
          uploadId: mediaId,
          eventLogUploadId: eventsId,
          title: ($("title-input") as HTMLInputElement).value || "Untitled recording",
          mode: ($("mode") as HTMLSelectElement).value,
          durationSec: durSec,
          sourceMeta: { source: "extension", version: chrome.runtime.getManifest().version },
        },
      });
      status.innerHTML = `Processing started ✓ — <a href="${APP_URL}/dashboard/r/${recording.id}" target="_blank">open in SceneRecap</a>`;
      await chrome.storage.session.remove("review");
    } catch (e) {
      status.textContent = e instanceof Error ? e.message : "Upload failed";
      btn.disabled = false;
    }
  };
}

void main();
