// What the site does for its own processes: take in a message from a bot (archive the files, queue the work), hand jobs
// to the relay, take back transcripts and draft cards, and pass replies to the bots. All checks that matter are in
// the database functions; this layer stores files and moves data. Callers are identified by their signing secret.
import { randomUUID } from 'node:crypto';
import { sha256 } from './signing';
import { iranMobile } from './smsir';
import { STT_AUDIO } from '../lib/media-types';
import type { ServerDb } from './db';

export type Caller = 'relay' | 'bale-bot';
export type Channel = 'bale' | 'telegram';

/** Each process may act only for its own channel: the Bale bot for Bale, the relay for Telegram and the AI jobs. */
export const channelOf = (caller: Caller): Channel => (caller === 'bale-bot' ? 'bale' : 'telegram');

// Only these types are stored as what they claim to be; anything else (html, svg, scripts …) is kept as an opaque
// download, so an archived file can never run as a page.
const EXT: Record<string, string> = {
  ...STT_AUDIO, // audio: only the formats speech-to-text reads (others, e.g. AMR or AAC, are kept as plain files)
  'image/jpeg': 'jpg', 'image/png': 'png', 'image/webp': 'webp', 'image/gif': 'gif', 'image/heic': 'heic', 'application/pdf': 'pdf',
  'image/vnd.dwg': 'dwg', 'application/acad': 'dwg', 'application/x-dwg': 'dwg', 'image/vnd.dxf': 'dxf',
  'video/mp4': 'mp4', 'video/quicktime': 'mov',
};
const IMAGE = /^image\/(jpeg|png|webp|gif|heic)$/;
export const MAX_FILE_BYTES = 50 * 1024 * 1024;
export const MAX_FILES = 10;
export type MediaKind = 'voice' | 'image' | 'document' | 'video' | 'other';

export interface IncomingFile { bytes: Uint8Array; mime: string; kind: MediaKind; filename?: string; durationMs?: number; caption?: string }
export interface Incoming { externalUser: string; chat: string; message: string; text?: string; files: IncomingFile[]; album?: string; sentAt?: string }

/** The stored type and kind of a file: never trust what the sender says beyond the whitelist. */
export function safeType(f: { mime: string; kind: MediaKind; filename?: string }): { mime: string; ext: string; kind: MediaKind } {
  const known = EXT[f.mime];
  const mime = known ? f.mime : 'application/octet-stream';
  const fromName = f.filename?.match(/\.(dwg|dxf|pdf)$/i)?.[1]?.toLowerCase(); // drawings often arrive as octet-stream
  const ext = known ?? fromName ?? 'bin';
  const kind: MediaKind = f.kind === 'image' && !IMAGE.test(mime) ? 'document'
    : f.kind === 'voice' && !mime.startsWith('audio/') ? 'other' : f.kind;
  return { mime, ext, kind };
}

/** Archive the files under the sender's project, then queue the message. Returns the inbox item. */
export async function ingest(db: ServerDb, channel: Channel, m: Incoming): Promise<string> {
  if (!m.files.length && !m.text?.trim()) throw new Error('an empty message');
  if (m.files.length > MAX_FILES) throw new Error('at most 10 files in one message');
  const seen = await db.rpc<string | null>('inbox_by_source', { p_channel: channel, p_chat: m.chat, p_message: m.message });
  if (seen) return seen; // a repeated message: nothing uploaded twice
  const ledger = await db.rpc<string>('sender_ledger', { p_channel: channel, p_external_user: m.externalUser });
  const files = [];
  for (const f of m.files) {
    if (f.bytes.byteLength === 0 || f.bytes.byteLength > MAX_FILE_BYTES) throw new Error('file is empty or larger than 50 MB');
    const t = safeType(f);
    const path = `${ledger}/inbox/${randomUUID()}.${t.ext}`;
    await db.putFile(path, f.bytes, t.mime);
    files.push({ storage_path: path, mime: t.mime, size_bytes: f.bytes.byteLength, sha256: sha256(f.bytes), kind: t.kind,
      duration_ms: f.durationMs ?? null, caption: f.caption?.slice(0, 1000) ?? null });
  }
  return db.rpc<string>('ingest_message', {
    p_channel: channel, p_external_user: m.externalUser, p_chat: m.chat, p_message: m.message,
    p_text: m.text?.slice(0, 8000) ?? null, p_files: files, p_album: m.album ?? null, p_sent_at: m.sentAt ?? null,
  });
}

export interface JobContext {
  job: { id: number; kind: string; attempts: number; status: string; lease: string };
  inbox: { id: string; ledger_id: string; channel: string; text: string | null };
  today: string;
  media: { id: string; kind: MediaKind; mime: string; storage_path: string; transcript: string | null; caption: string | null }[];
  people: { id: string; name: string; role?: string; aliases?: string[] }[];
  accounts: { id: string; name: string; ledgerKind: 'project' | 'company' | 'personal' }[];
  stages: { id: string; name: string; inProgress?: boolean }[];
}

const AI_KINDS = ['transcribe', 'extract'] as const;

/** The next AI job, with what the relay needs to do it (never the files themselves: those are fetched one by one). */
export async function claim(db: ServerDb, kinds: unknown): Promise<JobContext | null> {
  const asked = Array.isArray(kinds) ? kinds.filter((k): k is (typeof AI_KINDS)[number] => (AI_KINDS as readonly string[]).includes(k)) : [];
  const job = await db.rpc<{ id: number | null } | null>('claim_job', { p_kinds: asked.length ? asked : [...AI_KINDS] });
  if (!job?.id) return null;
  return db.rpc<JobContext>('job_context', { p_job: job.id });
}

/** A file of a job the relay is working on right now, under its current lease — nothing else can be fetched. */
export async function jobFile(db: ServerDb, jobId: number, lease: string, mediaId: string) {
  const ctx = await db.rpc<JobContext | null>('job_context', { p_job: jobId });
  const m = ctx?.job.status === 'running' && ctx.job.lease === lease ? ctx.media.find((x) => x.id === mediaId) : undefined;
  if (!m) throw Object.assign(new Error('not a file of a running job'), { status: 404 });
  return db.getFile(m.storage_path);
}

export const heartbeat = (db: ServerDb, job: number, lease: string) => db.rpc('job_heartbeat', { p_job: job, p_lease: lease });

export const saveTranscript = (db: ServerDb, job: number, lease: string, items: { media: string; text: string }[], model: string) =>
  db.rpc('save_transcript', { p_job: job, p_lease: lease, p_items: items, p_model: model });

export const saveExtraction = (db: ServerDb, job: number, lease: string, r: { cards: unknown[]; chips: string[]; highlights: string[]; ocr?: string | null; model: string; promptVersion: string }) =>
  db.rpc('save_extraction', { p_job: job, p_lease: lease, p_cards: r.cards, p_chips: r.chips, p_highlights: r.highlights, p_ocr: r.ocr ?? null, p_model: r.model, p_prompt_version: r.promptVersion });

export const failJob = (db: ServerDb, job: number, lease: string, error: string, permanent = false) =>
  db.rpc('fail_job', { p_job: job, p_lease: lease, p_error: error.slice(0, 500), p_permanent: permanent });

export interface Reply { id: number; lease: string; chat_id: string; text: string; reply_to?: string }

/** Replies waiting for this channel's bot (each answering the message it is about). */
export async function claimNotify(db: ServerDb, channel: Channel): Promise<Reply | null> {
  const job = await db.rpc<{ id: number | null; lease: string; payload: { chat_id: string; text: string; reply_to?: string } } | null>('claim_job', { p_kinds: [`notify_${channel}`] });
  return job?.id ? { id: job.id, lease: job.lease, ...job.payload } : null;
}
export const finishNotify = (db: ServerDb, channel: Channel, job: number, lease: string, ok: boolean, error?: string) =>
  db.rpc('finish_notify', { p_job: job, p_lease: lease, p_channel: channel, p_ok: ok, p_error: error ?? null });

/** Any Iranian mobile form → +989…, the form the site keeps; anything else is passed on as it is (and will not match). */
export const e164Iran = (phone: string) => { const m = iranMobile(phone); return m ? `+98${m.slice(1)}` : phone; };

/** Linking: the sender shared their own contact, and typed the code shown on the site. */
export const link = (db: ServerDb, channel: Channel, l: { senderId: string; contactUserId: string; phone: string; code: string }) =>
  db.rpc<string>('link_identity', { p_channel: channel, p_sender_id: String(l.senderId), p_contact_user_id: String(l.contactUserId), p_phone: e164Iran(String(l.phone)), p_code: String(l.code) });

export const isLinked = (db: ServerDb, channel: Channel, externalUser: string) =>
  db.rpc<boolean>('is_linked', { p_channel: channel, p_external_user: externalUser });
