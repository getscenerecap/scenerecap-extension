# SceneRecap Chrome extension

The open-source capture side of [SceneRecap](https://scenerecap.com) — a screen recorder whose AI watches the
pixels and interaction events and writes the explanation (bug report, tutorial, explanation, recap), every
claim linked to its exact second.

This repository is the **entire extension**: what runs in your browser, what it captures, and what it sends.
The backend (upload, transcode, AI passes, share pages) is SceneRecap's hosted service; you can also use the
product without the extension by uploading any screen recording at https://scenerecap.com/dashboard/upload.

## What it does

- **Capture** — Manifest V3. The service worker mints a `tabCapture` stream id; `MediaRecorder` runs in an
  offscreen document (an MV3 service worker can't hold media streams). Capture is capped at 1080p/30 fps.
- **Interaction log** — a content script records, for the duration of a recording only: clicks (target
  role/label and normalised position), scrolls, navigations (**path only**, never query strings or
  fragments), key **combinations** (⌘C, Enter, Esc — never typed text), console errors and failed requests
  (method, path, status — no bodies, no headers), page title/h1.
- **Review page** — shows the clip; nothing uploads until you press *Upload & analyze*. *Save to disk* is
  always available, even signed out.

## Privacy invariants (enforced, tested)

| Never captured | How |
|---|---|
| Typed text / keystrokes as text | the event schema has no field that could carry it (`telemetryEventSchema` in the product repo; tested) |
| Password / payment field contents | such fields emit only a `sensitive_field_interaction` event and are masked in the capture |
| URL query strings / fragments | navigations are recorded path-only |
| Incognito tabs, browser-internal pages | recording is refused |
| Anything before you press Record | the content script is injected only for the duration of a recording |

See [`src/content.ts`](src/content.ts) for the capture logic and [`src/background.ts`](src/background.ts) for
the refusal rules. The product's privacy policy is at https://scenerecap.com/legal/privacy.

## Permissions (from `public/manifest.json`)

`activeTab`, `tabs` (title/URL path of the recorded tab), `tabCapture` (the recording itself), `storage`
(auth token + settings), `offscreen` (MediaRecorder host), `scripting` (inject the interaction logger),
`downloads` (Save to disk). Host permission is limited to the SceneRecap API/app origins used for upload and
sign-in.

## Build & load

```bash
pnpm install
pnpm build            # → dist/ (uses API_URL/APP_URL env; defaults to localhost for local development)
pnpm build:prod       # → dist/ against https://api.scenerecap.com
```

Then `chrome://extensions` → Developer mode → *Load unpacked* → select `dist/`.

The Chrome Web Store listing is the supported install path once it is live; until then, load unpacked.

## Reporting security issues

Email security@scenerecap.com. Please don't open public issues for vulnerabilities.

## License

MIT — see [LICENSE](LICENSE). "SceneRecap" and the logo are trademarks of Neurotech AI Solutions GmbH.
