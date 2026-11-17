// How our processes (Bale bot, relay) call the site: every request signed with the process's own secret, with a fresh
// nonce each time (src/server/signing), so two identical requests in the same second are both accepted.
import { sign } from '../../server/signing';
import type { Core, OutFile } from './conversation';

export interface CoreClient extends Core {
  post<T = unknown>(action: string, body?: unknown): Promise<T>;
  file(job: number, lease: string, media: string): Promise<{ bytes: Uint8Array; mime: string }>;
}

export function coreClient(baseUrl: string, secret: string, fetchImpl: typeof fetch = fetch): CoreClient {
  if (!secret || secret.length < 32) throw new Error('the signing secret must be at least 32 characters');
  const url = new URL(baseUrl.replace(/\/$/, ''));
  const prefix = url.pathname.replace(/\/$/, ''); // normally empty: the site is served at the domain root (docs/deploy.md)
  const send = async (method: 'GET' | 'POST', pathAndQuery: string, body: Uint8Array, contentType?: string) => {
    const full = prefix + pathAndQuery;
    // every error from here is marked as the site's (`site: true`), so the bot can tell it from a messenger error
    const r = await fetchImpl(url.origin + full, {
      method, body: method === 'POST' ? Buffer.from(body) : undefined,
      headers: { ...(contentType ? { 'content-type': contentType } : {}), ...sign(secret, method, full, body) },
      // two minutes, plus time for a large upload over a slow international link (100 KB/s)
      signal: AbortSignal.timeout(120_000 + Math.ceil(body.byteLength / 100)),
    }).catch((e: Error) => {
      // a timeout on a large upload may be this message (a big file over a slow link): it is told apart, so it is not
      // waited on forever. A timeout on a small request means the site is out of reach (a network cut), and is waited out.
      const timedOut = e.name === 'TimeoutError' || e.name === 'AbortError';
      throw Object.assign(new Error(`${pathAndQuery}: ${e.message}`), { site: true, timeout: timedOut && body.byteLength > 1024 * 1024 });
    });
    if (!r.ok) throw Object.assign(new Error(`${pathAndQuery}: ${r.status} ${(await r.text().catch(() => '')).slice(0, 300)}`), { status: r.status, site: true });
    return r;
  };
  const post = async <T,>(action: string, body: unknown = {}) =>
    (await (await send('POST', `/api/internal/${action}`, new TextEncoder().encode(JSON.stringify(body)), 'application/json')).json()) as T;
  return {
    post,
    async file(job, lease, media) {
      const q = new URLSearchParams({ job: String(job), lease, media });
      const r = await send('GET', `/api/internal/file?${q}`, new Uint8Array());
      return { bytes: new Uint8Array(await r.arrayBuffer()), mime: r.headers.get('content-type') ?? 'application/octet-stream' };
    },
    linked: async (externalUser) => (await post<{ linked: boolean }>('linked', { externalUser })).linked,
    link: async (l) => { await post('link', l); },
    async ingest(meta, bytes) {
      // the multipart body is built here so the exact bytes that are sent are the bytes that are signed
      const form = new FormData();
      form.set('meta', JSON.stringify(meta));
      meta.files.forEach((f: Omit<OutFile, 'fileId'>, i) => form.set(`file${i}`, new Blob([Buffer.from(bytes[i])], { type: f.mime }), f.filename ?? `file${i}`));
      const req = new Request('http://x', { method: 'POST', body: form });
      const raw = new Uint8Array(await req.arrayBuffer());
      await send('POST', '/api/internal/ingest', raw, req.headers.get('content-type') ?? undefined);
    },
  };
}
