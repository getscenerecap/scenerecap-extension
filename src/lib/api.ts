declare const process: { env: Record<string, string> };
export const API_URL = process.env.API_URL;
export const APP_URL = process.env.APP_URL;

export async function getTokens(): Promise<{ accessToken?: string; refreshToken?: string }> {
  const st = await chrome.storage.local.get(["accessToken", "refreshToken"]);
  return st as { accessToken?: string; refreshToken?: string };
}

export async function setTokens(t: { accessToken?: string; refreshToken?: string }) {
  await chrome.storage.local.set(t);
}

export async function clearTokens() {
  await chrome.storage.local.remove(["accessToken", "refreshToken"]);
}

async function refresh(): Promise<boolean> {
  const { refreshToken } = await getTokens();
  if (!refreshToken) return false;
  const res = await fetch(`${API_URL}/v1/auth/refresh`, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ refreshToken }),
  });
  if (!res.ok) {
    await clearTokens();
    return false;
  }
  const data = (await res.json()) as { accessToken: string; refreshToken?: string };
  await setTokens({ accessToken: data.accessToken, refreshToken: data.refreshToken ?? refreshToken });
  return true;
}

export async function api<T = unknown>(path: string, opts: { method?: string; body?: unknown } = {}, retried = false): Promise<T> {
  const { accessToken } = await getTokens();
  const res = await fetch(`${API_URL}${path}`, {
    method: opts.method ?? "GET",
    headers: {
      ...(opts.body !== undefined ? { "content-type": "application/json" } : {}),
      ...(accessToken ? { authorization: `Bearer ${accessToken}` } : {}),
    },
    body: opts.body !== undefined ? JSON.stringify(opts.body) : undefined,
  });
  if (res.status === 401 && !retried && (await refresh())) return api(path, opts, true);
  if (!res.ok) {
    const text = await res.text().catch(() => "");
    throw new Error(`API ${res.status}: ${text.slice(0, 200)}`);
  }
  return (res.status === 204 ? undefined : await res.json()) as T;
}

/** Multipart upload of a Blob through presigned part URLs. */
export async function uploadBlob(blob: Blob, filename: string, contentType: string, kind: "media" | "eventlog"): Promise<string> {
  const session = await api<{ uploadId: string; partSize: number; parts: { n: number; url: string }[] }>("/v1/uploads", {
    method: "POST",
    body: { filename, sizeBytes: blob.size, contentType, kind },
  });
  const parts: { n: number; etag: string }[] = [];
  for (const part of session.parts) {
    const start = (part.n - 1) * session.partSize;
    const chunk = blob.slice(start, start + session.partSize);
    let etag = "";
    for (let attempt = 0; attempt < 3; attempt++) {
      const put = await fetch(part.url, { method: "PUT", body: chunk });
      if (put.ok) {
        etag = (put.headers.get("etag") ?? "").replaceAll('"', "");
        break;
      }
      if (attempt === 2) throw new Error(`part ${part.n} failed: ${put.status}`);
      await new Promise((r) => setTimeout(r, 1000 * (attempt + 1)));
    }
    parts.push({ n: part.n, etag });
  }
  await api(`/v1/uploads/${session.uploadId}/complete`, { method: "POST", body: { parts } });
  return session.uploadId;
}
