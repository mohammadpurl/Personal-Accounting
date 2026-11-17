// The one door for our own processes: the relay abroad and the Bale bot on this server. Every request is signed
// (src/server/signing); the secret that matches says who is calling, and each caller may act only for its own channel.
// The headers are checked before the body is read, and the body is read only up to a size limit.
import { NextResponse } from 'next/server';
import { matches, plausible, remember } from '@/server/signing';
import { serverDb } from '@/server/db';
import {
  channelOf, claim, claimNotify, failJob, finishNotify, heartbeat, ingest, isLinked, jobFile, link, MAX_FILE_BYTES, MAX_FILES,
  saveExtraction, saveTranscript, type Caller, type IncomingFile, type MediaKind,
} from '@/server/pipeline';

const MAX_BODY = MAX_FILE_BYTES + 5 * 1024 * 1024; // one large file plus the form around it
const MAX_JSON = 2 * 1024 * 1024;
const KINDS: MediaKind[] = ['voice', 'image', 'document', 'video', 'other'];

function secrets(): [Caller, string | undefined][] {
  const relay = process.env.RELAY_SECRET, bale = process.env.BALE_BOT_SECRET;
  if (relay && relay === bale) throw new Error('RELAY_SECRET and BALE_BOT_SECRET must differ');
  return [['relay', relay], ['bale-bot', bale]];
}
function who(method: string, path: string, body: Uint8Array, headers: Headers): Caller | null {
  for (const [caller, secret] of secrets()) if (matches(secret, method, path, body, headers)) return remember(headers) ? caller : null;
  return null;
}
const bad = (status: number, error: string) => NextResponse.json({ error }, { status });

/** Read at most `limit` bytes; null when the body is larger. */
async function readCapped(req: Request, limit: number): Promise<Uint8Array | null> {
  const declared = Number(req.headers.get('content-length') ?? 0); // absent when chunked: the stream cap below still holds
  if (!Number.isFinite(declared) || declared > limit) return null;
  if (!req.body) return new Uint8Array();
  const reader = req.body.getReader();
  const parts: Uint8Array[] = [];
  let size = 0;
  for (;;) {
    const { done, value } = await reader.read();
    if (done) break;
    size += value.byteLength;
    if (size > limit) { await reader.cancel(); return null; }
    parts.push(value);
  }
  const out = new Uint8Array(size);
  let at = 0;
  for (const p of parts) { out.set(p, at); at += p.byteLength; }
  return out;
}

/** Messages our own processes may act on; anything else from the database is reported in general terms. */
function failure(e: unknown) {
  const err = e as Error & { status?: number; code?: string };
  if (err.status) return bad(err.status, err.message);
  if (['23514', '42501', 'P0002', '22P02', '22023', '22007', '22008'].includes(err.code ?? '') || /not linked|no project|empty message|at most|too long|own ledger|larger than|bad (chat|album|file)|no longer running|wrong or expired|own number|not the one/.test(err.message))
    return bad(400, err.message);
  console.error('internal api', err);
  // 503 only when trying again later can help (the database or the archive briefly unreachable); anything else is a
  // fault about this request (500), which the bots try a few times and then report, so one bad message never holds
  // up the others
  const transient = /fetch failed|ECONN(REFUSED|RESET)|ETIMEDOUT|EAI_AGAIN|socket hang up|network|timeout|too many connections/i.test(err.message)
    || ['57P01', '57P03', '53300', '08000', '08001', '08003', '08006', '40001', '40P01'].includes(err.code ?? '');
  return transient ? bad(503, 'temporarily unavailable') : bad(500, 'internal error');
}

export async function POST(req: Request, ctx: { params: Promise<{ action: string }> }) {
  const { action } = await ctx.params;
  if (!plausible(req.headers)) return bad(401, 'unsigned');
  const raw = await readCapped(req, action === 'ingest' ? MAX_BODY : MAX_JSON);
  if (!raw) return bad(413, 'too large');
  let caller: Caller | null;
  try { caller = who('POST', new URL(req.url).pathname, raw, req.headers); } catch (e) { console.error(e); return bad(500, 'misconfigured'); }
  if (!caller) return bad(401, 'unsigned');
  const channel = channelOf(caller);
  try {
    if (action === 'ingest') {
      const form = await new Request(req.url, { method: 'POST', body: Buffer.from(raw), headers: req.headers }).formData();
      const meta = JSON.parse(String(form.get('meta') ?? '{}'));
      const list: unknown[] = Array.isArray(meta.files) ? meta.files : [];
      if (list.length > MAX_FILES) return bad(400, 'at most 10 files in one message');
      const files: IncomingFile[] = [];
      for (const [i, f] of (list as { kind: MediaKind; mime?: string; filename?: string; durationMs?: number; caption?: string }[]).entries()) {
        const blob = form.get(`file${i}`);
        if (!(blob instanceof Blob) || !KINDS.includes(f.kind)) return bad(400, 'bad file');
        files.push({ bytes: new Uint8Array(await blob.arrayBuffer()), mime: String(f.mime || blob.type || 'application/octet-stream'), kind: f.kind,
          filename: f.filename, durationMs: Number(f.durationMs) || undefined, caption: f.caption });
      }
      const id = await ingest(serverDb, channel, { externalUser: String(meta.externalUser), chat: String(meta.chat), message: String(meta.message),
        text: typeof meta.text === 'string' ? meta.text : undefined, files, album: typeof meta.album === 'string' ? meta.album : undefined,
        sentAt: typeof meta.sentAt === 'string' && !Number.isNaN(Date.parse(meta.sentAt)) ? meta.sentAt : undefined });
      return NextResponse.json({ inboxItemId: id });
    }
    const body = raw.byteLength ? JSON.parse(new TextDecoder().decode(raw)) : {};
    switch (action) {
      case 'linked': return NextResponse.json({ linked: await isLinked(serverDb, channel, String(body.externalUser)) });
      case 'link': return NextResponse.json({ userId: await link(serverDb, channel, body) });
      case 'notify-claim': return NextResponse.json({ job: await claimNotify(serverDb, channel) });
      case 'notify-done': await finishNotify(serverDb, channel, Number(body.job), String(body.lease ?? ''), !!body.ok, body.error ? String(body.error) : undefined); return NextResponse.json({ ok: true });
    }
    // the AI work is the relay's alone
    if (caller !== 'relay') return bad(403, 'not allowed');
    const lease = String(body.lease ?? '');
    switch (action) {
      case 'claim': return NextResponse.json({ context: await claim(serverDb, body.kinds) });
      case 'heartbeat': await heartbeat(serverDb, Number(body.job), lease); return NextResponse.json({ ok: true });
      case 'transcript': await saveTranscript(serverDb, Number(body.job), lease, Array.isArray(body.items) ? body.items : [], String(body.model)); return NextResponse.json({ ok: true });
      case 'extraction': await saveExtraction(serverDb, Number(body.job), lease, body); return NextResponse.json({ ok: true });
      case 'fail': await failJob(serverDb, Number(body.job), lease, String(body.error ?? 'failed'), body.permanent === true); return NextResponse.json({ ok: true });
    }
    return bad(404, 'unknown action');
  } catch (e) {
    return failure(e);
  }
}

/** A file of a job the relay is working on: GET /api/internal/file?job=…&lease=…&media=… (signed, empty body). */
export async function GET(req: Request, ctx: { params: Promise<{ action: string }> }) {
  const { action } = await ctx.params;
  const url = new URL(req.url);
  let caller: Caller | null = null;
  try { caller = who('GET', url.pathname + url.search, new Uint8Array(), req.headers); } catch (e) { console.error(e); return bad(500, 'misconfigured'); }
  if (caller !== 'relay' || action !== 'file') return bad(401, 'unsigned');
  try {
    const f = await jobFile(serverDb, Number(url.searchParams.get('job')), String(url.searchParams.get('lease')), String(url.searchParams.get('media')));
    return new Response(Buffer.from(f.bytes), { headers: { 'content-type': f.mime, 'cache-control': 'no-store', 'x-content-type-options': 'nosniff' } });
  } catch (e) {
    return failure(e);
  }
}
