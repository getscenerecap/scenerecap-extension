/// <reference types="chrome" />
/** Offscreen document: owns getUserMedia + MediaRecorder (SWs can't). */

let recorder: MediaRecorder | null = null;
let chunks: Blob[] = [];
let stream: MediaStream | null = null; // what MediaRecorder consumes (tab, or tab+mic mix)
let sourceStreams: MediaStream[] = []; // originals (tab capture, mic) — must ALL be stopped on stop, or the mic stays hot

chrome.runtime.onMessage.addListener((msg: { kind: string; streamId?: string; mic?: boolean }, _sender, sendResponse) => {
  (async () => {
    if (msg.kind === "offscreen:start") {
      try {
        // Tab video+audio via the streamId minted by tabCapture in the SW
        stream = await (navigator.mediaDevices as MediaDevices & { getUserMedia: typeof navigator.mediaDevices.getUserMedia }).getUserMedia({
          video: {
            // @ts-expect-error chrome-specific constraints
            // Cap at 1080p/30: Retina tabs otherwise capture at 2x device pixels (2880x1800+), which
            // multiplies upload size and makes the server transcode crawl; 1080p is plenty for the AI passes.
            mandatory: { chromeMediaSource: "tab", chromeMediaSourceId: msg.streamId, maxWidth: 1920, maxHeight: 1080, maxFrameRate: 30 },
          },
          audio: {
            // @ts-expect-error chrome-specific constraints
            mandatory: { chromeMediaSource: "tab", chromeMediaSourceId: msg.streamId },
          },
        });
        const tab = stream;
        sourceStreams = [tab];
        // Keep tab audio audible to the user while recording
        try {
          const ctx = new AudioContext();
          ctx.createMediaStreamSource(tab).connect(ctx.destination);
        } catch { /* non-fatal */ }

        if (msg.mic) {
          // Permission was granted up-front via mic.html (a visible page) — an offscreen document
          // cannot show the prompt itself, so an ungranted getUserMedia here rejects immediately.
          try {
            const mic = await navigator.mediaDevices.getUserMedia({ audio: { echoCancellation: true, noiseSuppression: true } });
            sourceStreams.push(mic);
            const ctx = new AudioContext();
            const dest = ctx.createMediaStreamDestination();
            ctx.createMediaStreamSource(tab).connect(dest);
            ctx.createMediaStreamSource(mic).connect(dest);
            stream = new MediaStream([...tab.getVideoTracks(), ...dest.stream.getAudioTracks()]); // video from tab, mixed audio
          } catch { /* mic revoked between popup check and start -> proceed tab-only */ }
        }

        chunks = [];
        recorder = new MediaRecorder(stream, { mimeType: "video/webm;codecs=vp9,opus", videoBitsPerSecond: 5_000_000 });
        recorder.ondataavailable = (e) => { if (e.data.size) chunks.push(e.data); };
        recorder.start(5000); // 5s timeslice (§3.6)
        sendResponse({ ok: true });
      } catch (e) {
        sendResponse({ ok: false, error: e instanceof Error ? e.message : "getUserMedia failed" });
      }
    }
    if (msg.kind === "offscreen:stop") {
      try {
        if (!recorder) throw new Error("no active recorder");
        const stopped = new Promise<void>((resolve) => {
          recorder!.onstop = () => resolve();
        });
        recorder.stop();
        await stopped;
        stream?.getTracks().forEach((t) => t.stop());
        sourceStreams.forEach((s) => s.getTracks().forEach((t) => t.stop()));
        sourceStreams = [];
        const blob = new Blob(chunks, { type: "video/webm" });
        const blobUrl = URL.createObjectURL(blob);
        recorder = null;
        stream = null;
        sendResponse({ ok: true, blobUrl });
      } catch (e) {
        sendResponse({ ok: false, error: e instanceof Error ? e.message : "stop failed" });
      }
    }
  })();
  return true;
});

export {};
