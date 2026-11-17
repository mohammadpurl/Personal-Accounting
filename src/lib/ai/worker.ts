// One job on the relay: a voice is turned into text; then the text, transcripts and photo are read by the AI and
// handed back as draft cards. Every call carries the job's lease, so a worker whose claim was taken over cannot write.
// While the job runs it sends a heartbeat, so a long voice is not handed to a second worker. Any failure is reported:
// retried later, or — when retrying cannot help — the item is shown as failed at once. (A worker that dies mid-job
// reports nothing; the queue hands the job out again and gives up once its attempts are used.)
import type { SpeechToText } from './providers';
import { sttKeywords } from './providers';
import { toDrafts, type ExtractContext, type Extraction } from './extract';
import { READABLE_IMAGE } from '../media-types'; // what the AI can look at; HEIC and the rest stay as files

export interface Job {
  job: { id: number; kind: string; attempts: number; lease: string };
  inbox: { id: string; text: string | null };
  today: string;
  media: { id: string; kind: 'voice' | 'image' | 'document' | 'video' | 'other'; mime: string; storage_path: string; transcript: string | null; caption?: string | null }[];
  people: ExtractContext['people']; accounts: ExtractContext['accounts']; stages: ExtractContext['stages'];
}
export interface WorkerDeps {
  file(job: number, lease: string, media: string): Promise<{ bytes: Uint8Array; mime: string }>;
  heartbeat(job: number, lease: string): Promise<unknown>;
  stt: SpeechToText;
  extract(input: { text?: string; imageDataUrl?: string; context: ExtractContext }): Promise<{ out: Extraction; model: string; promptVersion: string }>;
  post(action: 'transcript' | 'extraction' | 'fail', body: unknown): Promise<unknown>;
  heartbeatMs?: number;
}

/** A failure that retrying cannot fix (the file itself is the problem). */
export class PermanentError extends Error {}

const ctxOf = (j: Job): ExtractContext => ({ today: j.today, people: j.people, accounts: j.accounts, stages: j.stages });
const ext = (mime: string, path: string) => path.split('.').pop() || (mime.split('/')[1] ?? 'bin');
const IMAGE_MAX = 15 * 1024 * 1024;
const VOICE_MAX = 25 * 1024 * 1024; // the speech-to-text upload limit

async function run(j: Job, d: WorkerDeps, lease: string): Promise<void> {
  if (j.job.kind === 'transcribe') {
    const items = [];
    let model = d.stt.name;
    for (const m of j.media.filter((x) => x.kind === 'voice')) {
      const f = await d.file(j.job.id, lease, m.id);
      if (f.bytes.byteLength > VOICE_MAX) throw new PermanentError('voice is longer than the speech-to-text limit (25 MB)');
      const t = await d.stt.transcribe(f.bytes, { filename: `voice.${ext(m.mime, m.storage_path)}`, keywords: sttKeywords(ctxOf(j)), prompt: 'گزارش روزانهٔ کارگاه ساختمانی، به فارسی' });
      items.push({ media: m.id, text: t.text });
      model = `${t.provider}:${t.model}`;
    }
    if (!items.length) throw new PermanentError('no voice in this item');
    await d.post('transcript', { job: j.job.id, lease, items, model });
    return;
  }
  if (j.job.kind === 'extract') {
    const parts: string[] = [];
    if (j.inbox.text) parts.push(j.inbox.text);
    for (const m of j.media) {
      if (m.kind === 'voice' && m.transcript) parts.push(m.transcript);
      if (m.caption && !parts.includes(m.caption)) parts.push(m.caption);
      if (m.kind === 'document' || (m.kind === 'image' && !READABLE_IMAGE.test(m.mime))) parts.push(`(یک فایل ${ext(m.mime, m.storage_path).toUpperCase()} هم فرستاده شد)`);
    }
    const img = j.media.find((m) => m.kind === 'image' && READABLE_IMAGE.test(m.mime));
    let imageDataUrl: string | undefined;
    if (img) {
      const f = await d.file(j.job.id, lease, img.id);
      if (f.bytes.byteLength <= IMAGE_MAX && READABLE_IMAGE.test(f.mime)) imageDataUrl = `data:${f.mime};base64,${Buffer.from(f.bytes).toString('base64')}`;
    }
    const text = parts.join('\n').trim() || undefined;
    if (!text && !imageDataUrl) throw new PermanentError('nothing to read in this item');
    const r = await d.extract({ text, imageDataUrl, context: ctxOf(j) });
    const done = toDrafts(r.out, ctxOf(j));
    // document cards are filed with the files of this message, in order (a drawing, a contract …)
    const docFiles = [...j.media.filter((m) => m.kind === 'document'), ...j.media.filter((m) => m.kind === 'image')];
    let nextFile = 0;
    const cards = done.cards.map(({ kind, fields, guess }) => {
      const file = kind === 'document' ? docFiles[nextFile++] : undefined;
      return { kind, guess, fields: file ? { ...fields, media_ids: [file.id] } : fields };
    });
    await d.post('extraction', { job: j.job.id, lease, cards, chips: done.chips, highlights: r.out.highlights, ocr: null, model: r.model, promptVersion: r.promptVersion });
    return;
  }
  throw new PermanentError(`unknown job kind ${j.job.kind}`);
}

export async function processJob(j: Job, d: WorkerDeps): Promise<'done' | 'failed'> {
  const lease = j.job.lease;
  const beat = setInterval(() => { d.heartbeat(j.job.id, lease).catch(() => undefined); }, d.heartbeatMs ?? 60_000);
  try {
    await run(j, d, lease);
    return 'done';
  } catch (e) {
    const err = e as Error & { status?: number };
    // the AI service refusing this input itself (too large, unsupported or unreadable file) will refuse it again; a
    // 400 about our settings (model, parameters, key) is not the file's fault and is retried, so a fixed setting helps
    const aboutSettings = /parameter|model|api key|organization|permission/i.test(err.message);
    const aboutTheFile = !aboutSettings && /file|audio|image|format|decode|duration|too (long|large)|unsupported/i.test(err.message);
    const permanent = e instanceof PermanentError || [413, 415].includes(err.status ?? 0) || ([400, 422].includes(err.status ?? 0) && aboutTheFile);
    await d.post('fail', { job: j.job.id, lease, error: err.message, permanent }).catch(() => undefined);
    return 'failed';
  } finally {
    clearInterval(beat);
  }
}
