import { describe, expect, it, vi } from 'vitest';
import { plausible, sign, verify } from '@/server/signing';
import { iranMobile, sendLoginCode } from '@/server/smsir';
import { e164Iran } from '@/server/pipeline';
import { buildInstructions, ExtractionSchema, toDrafts, type ExtractContext, type Extraction } from './ai/extract';
import { processJob, type Job } from './ai/worker';
import { filesOf, handleUpdate, MSG, type Core, type Pending } from './bots/conversation';
import { handleWithRetry } from '../../services/run-bot';
import type { BotApi, TgUpdate } from './bots/tgapi';
import { validateDraft } from './drafts';
import { cer } from '../../scripts/stt-eval';

const SECRET = 'x'.repeat(40);
const ctx: ExtractContext = {
  today: '2026-11-17',
  people: [{ id: 'p-rezaei', name: 'حسین رضایی', role: 'آرماتوربند' }, { id: 'p-crew', name: 'کارگران روزمزد' }, { id: 'p-salehi', name: 'آهن‌آلات صالحی' }],
  accounts: [{ id: 'a-bank', name: 'بانک ملت', ledgerKind: 'project' }, { id: 'a-cash', name: 'تنخواه کارگاه', ledgerKind: 'project' }],
  stages: [{ id: 's-frame', name: 'اسکلت', inProgress: true }],
};
const blank = (over: Partial<Extraction['cards'][number]>): Extraction['cards'][number] => ({
  kind: 'payment', amount: null, wage_per_person: null, headcount: null, paid: null, settles: null, direction: null, person_id: null,
  account_id: null, from_account_id: null, to_account_id: null, stage_id: null, date: null, due_date: null, progress_pct: null,
  stage_status: null, method: null, tracking_no: null, bank: null, sayad_no: null, title: null, category_code: null, body: null,
  description: null, guesses: [], ...over,
});

describe('signed requests between our processes', () => {
  it('a correct signature passes once; tampering, a weak secret, an old or replayed request do not', () => {
    const body = JSON.stringify({ job: 1 });
    const h = new Headers(sign(SECRET, 'POST', '/api/internal/claim', body));
    expect(verify(SECRET, 'POST', '/api/internal/claim', body, h)).toBe(true);
    expect(verify(SECRET, 'POST', '/api/internal/claim', body, h)).toBe(false); // replay
    const h2 = new Headers(sign(SECRET, 'POST', '/api/internal/claim', body));
    expect(verify(SECRET, 'POST', '/api/internal/claim', body + ' ', h2)).toBe(false);
    expect(verify(SECRET, 'POST', '/api/internal/fail', body, h2)).toBe(false);
    expect(verify('short', 'POST', '/api/internal/claim', body, new Headers(sign('short', 'POST', '/api/internal/claim', body)))).toBe(false);
    const old = new Headers(sign(SECRET, 'POST', '/x', body, Date.now() - 10 * 60_000));
    expect(verify(SECRET, 'POST', '/x', body, old)).toBe(false);
    const future = new Headers(sign(SECRET, 'POST', '/x', body, Date.now() + 5 * 60_000));
    expect(plausible(future)).toBe(false);
  });
  it('each request has its own nonce, so identical requests in the same second are both accepted', () => {
    const body = JSON.stringify({ externalUser: '42' });
    const now = Date.now();
    const a = new Headers(sign(SECRET, 'POST', '/api/internal/linked', body, now)), b = new Headers(sign(SECRET, 'POST', '/api/internal/linked', body, now));
    expect(a.get('x-sig-nonce')).not.toBe(b.get('x-sig-nonce'));
    expect(verify(SECRET, 'POST', '/api/internal/linked', body, a, now)).toBe(true);
    expect(verify(SECRET, 'POST', '/api/internal/linked', body, b, now)).toBe(true);
    const swapped = new Headers(a); swapped.set('x-sig-nonce', 'f'.repeat(32));
    expect(verify(SECRET, 'POST', '/api/internal/linked', body, swapped, now)).toBe(false);
  });
});

describe('what the AI returns becomes draft cards', () => {
  it('the instructions carry the templates and only the project’s own ids', () => {
    const s = buildInstructions(ctx);
    expect(s).toContain('p-rezaei — حسین رضایی');
    expect(s).toContain('work_log');
    expect(s).toMatch(/Never invent an id/);
  });
  it('money in Toman becomes Rial, made-up ids are dropped and flagged, unknown becomes a note to check', () => {
    const out: Extraction = ExtractionSchema.parse({
      highlights: ['پنج کارگر', 'دوازده میلیون'], chips: ['کارکرد ۵ نفر', 'پرداخت ۱۲ میلیون', 'نامفهوم'],
      cards: [
        blank({ kind: 'work_log', headcount: 5, wage_per_person: { value: 1_200_000, unit: 'toman' }, paid: false, person_id: 'p-crew', stage_id: 's-frame' }),
        blank({ kind: 'payment', amount: { value: 12_000_000, unit: 'toman' }, person_id: 'p-rezaei', account_id: 'invented', settles: true }),
        blank({ kind: 'unknown', description: 'یک چیز نامفهوم' }),
      ],
    });
    const r = toDrafts(out, ctx);
    expect(r.cards[0]).toMatchObject({ kind: 'work_log', fields: { headcount: 5, wage_rial: '12000000', paid: false, crew_person_id: 'p-crew', stage_id: 's-frame', work_date: '2026-11-17' } });
    expect(validateDraft('work_log', r.cards[0].fields).ok).toBe(true);
    expect(r.cards[1].fields).toMatchObject({ amount_rial: '120000000', person_id: 'p-rezaei', settles: true });
    expect(r.cards[1].fields.account_id).toBeUndefined();
    expect(r.cards[1].guess.account_id).toMatch(/فهرست/);
    expect(r.cards[1].fields.occurred_on).toBe('2026-11-17'); // no day said: the day the message arrived
    expect(r.cards[2]).toMatchObject({ kind: 'daily_note', fields: { body: 'یک چیز نامفهوم', note_date: '2026-11-17' } });
  });
  it('dates come back in Jalali and are converted here; a day that cannot be is flagged; an unsaid wage is flagged', () => {
    const out = ExtractionSchema.parse({ highlights: [], chips: ['الف', 'ب', 'پ', 'ت', 'ث'], cards: [
      blank({ kind: 'payment', date: '1405/08/25' }),
      blank({ kind: 'payment', date: '1405/13/40' }),
      blank({ kind: 'work_log', headcount: 3, date: '1405/09/20' }), // a month ahead: not something that already happened
      blank({ kind: 'cheque', due_date: '1405/08/30' }),
    ] });
    const [a, b, w, c] = toDrafts(out, ctx).cards;
    expect(a.fields.occurred_on).toBe('2026-11-16');
    expect(a.guess.occurred_on).toBeUndefined();
    expect(b.fields.occurred_on).toBe('2026-11-17');
    expect(b.guess.occurred_on).toMatch(/درست فهمیده نشد/);
    expect(w.fields.work_date).toBe('2026-11-17');
    expect(w.guess.work_date).toBeDefined();
    expect(w.guess.wage_rial).toMatch(/دستمزد/);
    expect(c.fields.due_date).toBe('2026-11-21');
    expect(toDrafts(out, ctx).chips).toHaveLength(4); // never more labels than cards
    expect(buildInstructions(ctx)).toContain('1405/08/26');
  });
  it('the model’s guesses land on the card’s own field names, so the review sheet shows them', () => {
    const out = ExtractionSchema.parse({ highlights: [], chips: ['پرداخت'], cards: [blank({ kind: 'payment', amount: { value: 500_000, unit: 'toman' }, date: '1405/08/25',
      guesses: [{ field: 'amount', reason: '«پانصد تومن» مبهم بود' }, { field: 'date', reason: 'فقط «پریروز» گفته شد' }, { field: 'person_id', reason: 'نام کامل گفته نشد' }] })] });
    const g = toDrafts(out, ctx).cards[0].guess;
    expect(g).toEqual({ amount_rial: '«پانصد تومن» مبهم بود', occurred_on: 'فقط «پریروز» گفته شد', person_id: 'نام کامل گفته نشد' });
  });
  it('impossible values are dropped: dates, headcounts, percentages, amounts', () => {
    const out = ExtractionSchema.parse({ highlights: [], chips: [], cards: [
      blank({ kind: 'work_log', headcount: 0, date: '2026-02-30' }),
      blank({ kind: 'stage_progress', progress_pct: 140, stage_id: 's-frame' }),
      blank({ kind: 'payment', amount: { value: 1e20, unit: 'toman' }, date: '1990-01-01' }),
      blank({ kind: 'payment', amount: { value: -5, unit: 'toman' }, date: '2026-11-16' }),
    ] });
    const [w, s, p, q] = toDrafts(out, ctx).cards;
    expect(w.fields.headcount).toBeUndefined();
    expect(w.fields.work_date).toBe('2026-11-17');
    expect(s.fields.progress_pct).toBeUndefined();
    expect(p.fields.amount_rial).toBeUndefined();
    expect(p.fields.occurred_on).toBe('2026-11-17');
    expect(q.fields).toMatchObject({ occurred_on: '2026-11-16' });
    expect(q.fields.amount_rial).toBeUndefined();
  });
  it('a rial amount from a receipt stays rial; a bad Sayad number is not kept', () => {
    const out = ExtractionSchema.parse({ highlights: [], chips: ['چک'], cards: [blank({ kind: 'cheque', direction: 'issued', amount: { value: 900_000_000, unit: 'rial' }, person_id: 'p-salehi', due_date: '2026-11-26', account_id: 'a-bank', sayad_no: '123' })] });
    const c = toDrafts(out, ctx).cards[0];
    expect(c.fields).toMatchObject({ amount_rial: '900000000', due_date: '2026-11-26' });
    expect(c.fields.sayad_no).toBeUndefined();
  });
});

describe('the relay worker', () => {
  const job = (kind: string, over: Partial<Job> = {}): Job => ({
    job: { id: 7, kind, attempts: 1, lease: 'L' }, inbox: { id: 'ib', text: null }, today: ctx.today,
    media: [{ id: 'm1', kind: 'voice', mime: 'audio/ogg', storage_path: 'l/inbox/x.ogg', transcript: 'امروز پنج کارگر' }],
    people: ctx.people, accounts: ctx.accounts, stages: ctx.stages, ...over,
  });
  it('a voice is transcribed and handed back; reading turns transcripts into cards', async () => {
    const post = vi.fn(async () => ({}));
    const deps = {
      file: vi.fn(async () => ({ bytes: new Uint8Array([1, 2]), mime: 'audio/ogg' })),
      heartbeat: vi.fn(async () => ({})),
      stt: { name: 'fake', transcribe: async () => ({ text: 'سلام', provider: 'fake', model: 'm', ms: 1 }) },
      extract: async () => ({ out: ExtractionSchema.parse({ highlights: ['پنج کارگر'], chips: ['کارکرد'], cards: [blank({ kind: 'work_log', headcount: 5, paid: false })] }), model: 'gpt', promptVersion: 'v' }),
      post,
    };
    expect(await processJob(job('transcribe'), deps)).toBe('done');
    expect(deps.file).toHaveBeenCalledWith(7, 'L', 'm1');
    expect(post).toHaveBeenLastCalledWith('transcript', { job: 7, lease: 'L', items: [{ media: 'm1', text: 'سلام' }], model: 'fake:m' });
    expect(await processJob(job('extract'), deps)).toBe('done');
    expect(post).toHaveBeenLastCalledWith('extraction', expect.objectContaining({ job: 7, lease: 'L', chips: ['کارکرد'], model: 'gpt' }));
  });
  it('two documents in one message are filed one each; a settings error from the AI service is retried, not given up', async () => {
    const post = vi.fn(async () => ({}));
    const twoDocs = ExtractionSchema.parse({ highlights: [], chips: ['قرارداد', 'نقشه'], cards: [blank({ kind: 'document', title: 'قرارداد' }), blank({ kind: 'document', title: 'نقشه' })] });
    await processJob(job('extract', { media: [
      { id: 'pdf1', kind: 'document', mime: 'application/pdf', storage_path: 'l/inbox/a.pdf', transcript: null, caption: 'قرارداد و نقشه' },
      { id: 'pdf2', kind: 'document', mime: 'application/pdf', storage_path: 'l/inbox/b.pdf', transcript: null },
    ] }), { file: vi.fn(), heartbeat: vi.fn(), stt: { name: 'x', transcribe: vi.fn() }, extract: async () => ({ out: twoDocs, model: 'gpt', promptVersion: 'v' }), post });
    const sent = (post.mock.calls.at(-1) as unknown as [string, { cards: { fields: { media_ids?: string[] } }[] }])[1];
    expect(sent.cards.map((c) => c.fields.media_ids)).toEqual([['pdf1'], ['pdf2']]);
    const settings = vi.fn(async () => { throw Object.assign(new Error('Invalid value for model'), { status: 400 }); });
    await processJob(job('extract'), { file: vi.fn(), heartbeat: vi.fn(), stt: { name: 'x', transcribe: vi.fn() }, extract: settings, post });
    expect(post).toHaveBeenLastCalledWith('fail', expect.objectContaining({ permanent: false }));
    const badFile = vi.fn(async () => { throw Object.assign(new Error('Invalid image format'), { status: 400 }); });
    await processJob(job('extract'), { file: vi.fn(), heartbeat: vi.fn(), stt: { name: 'x', transcribe: vi.fn() }, extract: badFile, post });
    expect(post).toHaveBeenLastCalledWith('fail', expect.objectContaining({ permanent: true }));
  });
  it('a failure is reported with the lease; one that retrying cannot fix says so', async () => {
    const post = vi.fn(async () => ({}));
    const r = await processJob(job('extract', { media: [] }), { file: vi.fn(), heartbeat: vi.fn(), stt: { name: 'x', transcribe: vi.fn() }, extract: vi.fn(), post });
    expect(r).toBe('failed');
    expect(post).toHaveBeenCalledWith('fail', { job: 7, lease: 'L', error: 'nothing to read in this item', permanent: true });
    const flaky = vi.fn(async () => { throw new Error('socket hang up'); });
    await processJob(job('extract'), { file: vi.fn(), heartbeat: vi.fn(), stt: { name: 'x', transcribe: vi.fn() }, extract: flaky, post });
    expect(post).toHaveBeenLastCalledWith('fail', { job: 7, lease: 'L', error: 'socket hang up', permanent: false });
  });
  it('a long job keeps sending its heartbeat; a document card is filed with its file; unreadable images are not sent to the AI', async () => {
    const heartbeat = vi.fn(async () => ({}));
    const post = vi.fn(async () => ({}));
    let release!: () => void;
    const extract = vi.fn(async () => {
      await new Promise<void>((r) => { release = r; });
      return { out: ExtractionSchema.parse({ highlights: [], chips: ['نقشه'], cards: [blank({ kind: 'document', title: 'نقشهٔ برق' })] }), model: 'gpt', promptVersion: 'v' };
    });
    const file = vi.fn();
    const p = processJob(job('extract', { media: [
      { id: 'dwg', kind: 'document', mime: 'application/octet-stream', storage_path: 'l/inbox/a.dwg', transcript: null, caption: 'نقشهٔ برق' },
      { id: 'heic', kind: 'image', mime: 'image/heic', storage_path: 'l/inbox/b.heic', transcript: null },
    ] }), { file, heartbeat, stt: { name: 'x', transcribe: vi.fn() }, extract, post, heartbeatMs: 5 });
    await new Promise((r) => setTimeout(r, 30));
    release();
    expect(await p).toBe('done');
    expect(heartbeat).toHaveBeenCalledWith(7, 'L');
    expect(file).not.toHaveBeenCalled();
    expect(post).toHaveBeenLastCalledWith('extraction', expect.objectContaining({ cards: [expect.objectContaining({ kind: 'document', fields: expect.objectContaining({ media_ids: ['dwg'] }) })] }));
    const n = heartbeat.mock.calls.length;
    await new Promise((r) => setTimeout(r, 20));
    expect(heartbeat.mock.calls.length).toBe(n); // stopped once the job ended
  });
});

describe('the bot conversation', () => {
  const setup = (linked = false) => {
    const sent: { chat: string; text: string; kb?: string }[] = [];
    const api: BotApi = { getUpdates: vi.fn(), download: vi.fn(async () => new Uint8Array([9])), send: vi.fn(async (chat, text, kb) => { sent.push({ chat: String(chat), text, kb }); }) };
    const core: Core = { linked: vi.fn(async () => linked), link: vi.fn(async () => undefined), ingest: vi.fn(async () => undefined) };
    return { sent, api, core, pending: new Map() as Pending };
  };
  const msg = (m: Partial<NonNullable<TgUpdate['message']>>): TgUpdate => ({ update_id: 1, message: { message_id: 5, from: { id: 42 }, chat: { id: 42, type: 'private' }, ...m } });

  it('linking: own contact, then the 6-digit code (Persian digits too)', async () => {
    const s = setup();
    await handleUpdate(msg({ text: '/start' }), s.api, s.core, s.pending);
    expect(s.sent.at(-1)).toMatchObject({ text: MSG.welcome, kb: 'contact' });
    await handleUpdate(msg({ contact: { phone_number: '+989121234567', user_id: 99 } }), s.api, s.core, s.pending);
    expect(s.sent.at(-1)!.text).toBe(MSG.notYours);
    await handleUpdate(msg({ contact: { phone_number: '+989121234567', user_id: 42 } }), s.api, s.core, s.pending);
    expect(s.sent.at(-1)!.text).toBe(MSG.askCode);
    await handleUpdate(msg({ text: '۱۲۳۴۵۶' }), s.api, s.core, s.pending);
    expect(s.core.link).toHaveBeenCalledWith({ senderId: '42', contactUserId: '42', phone: '+989121234567', code: '123456' });
    expect(s.sent.at(-1)!.text).toBe(MSG.linked);
  });
  it('a wrong code says how many tries are left; a waiting sender is asked only for the code; groups are not read', async () => {
    const s = setup();
    (s.core.link as ReturnType<typeof vi.fn>).mockRejectedValueOnce(new Error('the code is wrong or expired'));
    s.pending.set('42', { phone: '+98912', contactUserId: '42', at: Date.now() });
    await handleUpdate(msg({ text: '000000' }), s.api, s.core, s.pending);
    expect(s.sent.at(-1)!.text).toBe(MSG.wrongCode(4));
    expect(s.sent.at(-1)!.text).toContain('۴ بار');
    await handleUpdate(msg({ text: '۱۲۳ ۴۵' }), s.api, s.core, s.pending);
    expect(s.sent.at(-1)!.text).toBe(MSG.codeShape);
    await handleUpdate(msg({ voice: { file_id: 'v', duration: 3 } }), s.api, s.core, s.pending);
    expect(s.sent.at(-1)!.text).toBe(MSG.waitingCode);
    await handleUpdate(msg({ chat: { id: -1, type: 'group' }, text: 'سلام' }), s.api, s.core, s.pending);
    expect(s.sent).toHaveLength(3);
    await handleUpdate(msg({ chat: { id: -1, type: 'group' }, text: '/start' }), s.api, s.core, s.pending);
    expect(s.sent.at(-1)).toMatchObject({ chat: '-1', text: MSG.privateOnly });
    const fresh = setup();
    await handleUpdate(msg({ voice: { file_id: 'v', duration: 3 } }), fresh.api, fresh.core, fresh.pending);
    expect(fresh.sent.at(-1)).toMatchObject({ text: MSG.notLinked, kb: 'contact' });
    await handleUpdate(msg({ text: '123456' }), fresh.api, fresh.core, fresh.pending);
    expect(fresh.sent.at(-1)).toMatchObject({ text: MSG.codeFirst, kb: 'contact' });
    await handleUpdate(msg({ text: '/help' }), fresh.api, fresh.core, fresh.pending);
    expect(fresh.sent.at(-1)!.text).toContain(MSG.helpUnlinked);
  });
  it('wrong codes still count when the number is shared again; a linked sender sharing a number is told; a lost «linked» reply does not file the code', async () => {
    const s = setup();
    (s.core.link as ReturnType<typeof vi.fn>).mockRejectedValue(new Error('the code is wrong or expired'));
    const contact = () => handleUpdate(msg({ contact: { phone_number: '+989121234567', user_id: 42 } }), s.api, s.core, s.pending);
    await contact();
    for (let i = 0; i < 3; i++) await handleUpdate(msg({ text: '000000' }), s.api, s.core, s.pending);
    await contact();
    for (let i = 0; i < 3; i++) await handleUpdate(msg({ text: '000000' }), s.api, s.core, s.pending);
    expect(s.core.link).toHaveBeenCalledTimes(5);
    expect(s.sent.at(-1)!.text).toBe(MSG.tooManyTries);
    await contact();
    expect(s.sent.at(-1)!.text).toBe(MSG.tooManyTries);

    const l = setup(true);
    await handleUpdate(msg({ contact: { phone_number: '+989121234567', user_id: 42 } }), l.api, l.core, l.pending);
    expect(l.sent.at(-1)).toMatchObject({ text: MSG.alreadyLinked, kb: 'remove' });

    const k = setup();
    k.pending.set('42', { phone: '+98912', contactUserId: '42', at: Date.now() });
    (k.api.send as ReturnType<typeof vi.fn>).mockRejectedValueOnce(new Error('502'));
    await expect(handleUpdate(msg({ text: '123456' }), k.api, k.core, k.pending)).resolves.toBeUndefined();
    expect(k.core.ingest).not.toHaveBeenCalled();
  });
  it('an edit is answered, not filed; a video is archived with a note that its words are not read; replies quote the message', async () => {
    const s = setup(true);
    await handleUpdate({ update_id: 2, edited_message: { message_id: 8, from: { id: 42 }, chat: { id: 42, type: 'private' }, text: 'پنج میلیون' } }, s.api, s.core, s.pending);
    expect(s.sent.at(-1)!.text).toBe(MSG.edited);
    expect(s.core.ingest).not.toHaveBeenCalled();
    await handleUpdate(msg({ video_note: { file_id: 'vn', duration: 5 }, date: 1_763_400_000 }), s.api, s.core, s.pending);
    expect(s.sent.at(-1)!.text).toBe(MSG.video); // nothing to read: archived only, no «result» promised
    expect(s.api.send).toHaveBeenLastCalledWith('42', expect.any(String), undefined, 5);
    expect(s.core.ingest).toHaveBeenLastCalledWith(expect.objectContaining({ sentAt: new Date(1_763_400_000_000).toISOString() }), expect.anything());
    // an audio format the speech-to-text cannot read: archived, and the sender is told how to send it instead
    await handleUpdate(msg({ message_id: 6, audio: { file_id: 'amr', mime_type: 'audio/amr', duration: 4 } }), s.api, s.core, s.pending);
    expect(s.core.ingest).toHaveBeenLastCalledWith(expect.objectContaining({ files: [expect.objectContaining({ kind: 'other' })] }), expect.anything());
    expect(s.sent.at(-1)!.text).toBe(MSG.audioFormat);
    await handleUpdate(msg({ message_id: 7, document: { file_id: 'w', mime_type: 'audio/x-wav' } }), s.api, s.core, s.pending);
    expect(s.core.ingest).toHaveBeenLastCalledWith(expect.objectContaining({ files: [expect.objectContaining({ kind: 'voice' })] }), expect.anything());
    expect(s.sent.at(-1)!.text).toBe(MSG.received);
  });
  it('after five wrong codes the sender starts again; a file too large for the bot is refused with a reason', async () => {
    const s = setup();
    (s.core.link as ReturnType<typeof vi.fn>).mockRejectedValue(new Error('the code is wrong or expired'));
    s.pending.set('42', { phone: '+98912', contactUserId: '42', at: Date.now() });
    for (let i = 0; i < 5; i++) await handleUpdate(msg({ text: '000000' }), s.api, s.core, s.pending);
    await handleUpdate(msg({ text: '000000' }), s.api, s.core, s.pending);
    expect(s.sent.at(-1)!.text).toBe(MSG.tooManyTries);
    expect(s.core.link).toHaveBeenCalledTimes(5);
    const l = setup(true);
    await handleUpdate(msg({ video: { file_id: 'big', file_size: 40 * 1024 * 1024 } }), l.api, l.core, l.pending);
    expect(l.sent.at(-1)!.text).toBe(MSG.tooBig);
    expect(l.api.download).not.toHaveBeenCalled();
  });
  it('the site briefly down: the error goes back to the bot loop to retry; a refusal is answered', async () => {
    const s = setup(true);
    (s.core.ingest as ReturnType<typeof vi.fn>).mockRejectedValueOnce(Object.assign(new Error('503'), { status: 503, site: true }));
    await expect(handleUpdate(msg({ text: 'سلام' }), s.api, s.core, s.pending)).rejects.toThrow();
    (s.core.ingest as ReturnType<typeof vi.fn>).mockRejectedValueOnce(Object.assign(new Error('no project for this sender'), { status: 400, site: true }));
    await handleUpdate(msg({ text: 'سلام' }), s.api, s.core, s.pending);
    expect(s.sent.at(-1)!.text).toBe(MSG.noProject);
  });
  it('the bot loop waits for the site as long as it takes, but gives up on other failures after five tries', async () => {
    const s = setup(true);
    const wait = vi.fn(async () => undefined);
    let down = 12;
    const onSite = vi.fn(async () => { if (down-- > 0) throw Object.assign(new Error('fetch failed'), { site: true }); });
    await handleWithRetry('t', msg({ text: 'x' }), s.api, onSite, wait);
    expect(onSite).toHaveBeenCalledTimes(13); // handled in the end, nothing dropped
    expect(s.sent).toHaveLength(0);
    // a message the site keeps refusing as «down» is not waited for beyond a day's worth: it is reported, the bot goes on
    const old = msg({ text: 'x', date: 1_000 });
    const always = vi.fn(async () => { throw Object.assign(new Error('503'), { site: true, status: 503 }); });
    await handleWithRetry('t', old, s.api, always, wait, () => 1_000_000 + 21 * 3600_000);
    expect(s.sent.at(-1)!.text).toBe(MSG.failed);
    // a fault about the message itself (500) is tried a few times, not forever
    const fault = vi.fn(async () => { throw Object.assign(new Error('500'), { site: true, status: 500 }); });
    await handleWithRetry('t', msg({ text: 'x' }), s.api, fault, wait);
    expect(fault).toHaveBeenCalledTimes(5);
    // a timeout may be this message (a large file over a slow link): a few tries, never the whole queue held up
    const slow = vi.fn(async () => { throw Object.assign(new Error('The operation was aborted due to timeout'), { site: true, timeout: true }); });
    await handleWithRetry('t', msg({ text: 'x' }), s.api, slow, wait);
    expect(slow).toHaveBeenCalledTimes(5);
    // a fault at the site while storing a message goes back to the loop (so it gets those tries), not answered at once
    const l = setup(true);
    (l.core.ingest as ReturnType<typeof vi.fn>).mockRejectedValueOnce(Object.assign(new Error('500'), { site: true, status: 500 }));
    await expect(handleUpdate(msg({ text: 'سلام' }), l.api, l.core, l.pending)).rejects.toThrow();
    // a timed-out upload goes back to the loop too (the next try finds the message if the site did store it)
    (l.core.ingest as ReturnType<typeof vi.fn>).mockRejectedValueOnce(Object.assign(new Error('timeout'), { site: true, timeout: true }));
    await expect(handleUpdate(msg({ text: 'سلام' }), l.api, l.core, l.pending)).rejects.toThrow();
    // a voice note in a type that cannot be read is not answered with «use the microphone» (the sender did)
    await handleUpdate(msg({ message_id: 9, voice: { file_id: 'v', mime_type: 'audio/amr' } }), l.api, l.core, l.pending);
    expect(l.sent.at(-1)!.text).toBe(MSG.voiceFormat);
    const broken = vi.fn(async () => { throw new Error('download failed: 500'); });
    await handleWithRetry('t', msg({ text: 'x' }), s.api, broken, wait);
    expect(broken).toHaveBeenCalledTimes(5);
    expect(s.sent.at(-1)!.text).toBe(MSG.failed);
  });
  it('a linked voice is downloaded and handed in; the largest photo is kept; drawings keep their name', async () => {
    const s = setup(true);
    await handleUpdate(msg({ voice: { file_id: 'v1', duration: 12 }, caption: 'کارکرد' }), s.api, s.core, s.pending);
    expect(s.core.ingest).toHaveBeenCalledWith(expect.objectContaining({ externalUser: '42', chat: '42', message: '5', text: undefined,
      files: [expect.objectContaining({ kind: 'voice', mime: 'audio/ogg', durationMs: 12000, caption: 'کارکرد' })] }), [new Uint8Array([9])]);
    expect(s.sent.at(-1)!.text).toBe(MSG.received);
    const f = filesOf({ message_id: 1, chat: { id: 1, type: 'private' },
      photo: [{ file_id: 'small', width: 90, height: 90 }, { file_id: 'big', width: 1280, height: 960 }],
      document: { file_id: 'd', mime_type: 'application/acad', file_name: 'plan.dwg' } });
    expect(f.map((x) => x.fileId)).toEqual(['big', 'd']);
    expect(f[1]).toMatchObject({ kind: 'document', filename: 'plan.dwg' });
    const kinds = (mime: string) => filesOf({ message_id: 1, chat: { id: 1, type: 'private' }, document: { file_id: 'd', mime_type: mime } })[0].kind;
    expect(kinds('image/vnd.dwg')).toBe('document');
    expect(kinds('image/png')).toBe('image');
    expect(kinds('audio/mp4')).toBe('voice');
    expect(filesOf({ message_id: 1, chat: { id: 1, type: 'private' }, voice: { file_id: 'v', mime_type: 'audio/x-opus+ogg' } })[0]).toMatchObject({ kind: 'voice', mime: 'audio/ogg' });
    expect(kinds('audio/amr')).toBe('other');
    expect(filesOf({ message_id: 1, chat: { id: 1, type: 'private' }, video_note: { file_id: 'vn', duration: 9 } })[0]).toMatchObject({ kind: 'video', durationMs: 9000 });
  });
});

describe('login codes by SMS.ir', () => {
  it('only Iranian mobiles, in the form SMS.ir wants', () => {
    expect(iranMobile('+989121234567')).toBe('09121234567');
    expect(iranMobile('989121234567')).toBe('09121234567');
    expect(iranMobile('۰۹۱۲۱۲۳۴۵۶۷'.replace(/[۰-۹]/g, (d) => String('۰۱۲۳۴۵۶۷۸۹'.indexOf(d))))).toBe('09121234567');
    expect(iranMobile('+14155550100')).toBeNull();
    for (const p of ['+989121234567', '989121234567', '09121234567', '۰۹۱۲۱۲۳۴۵۶۷']) expect(e164Iran(p)).toBe('+989121234567');
  });
  it('sends the code with the template and reports SMS.ir’s answer', async () => {
    process.env.SMSIR_API_KEY = 'k'; process.env.SMSIR_TEMPLATE_ID = '123456';
    const f = vi.fn(async () => new Response(JSON.stringify({ status: 1, message: 'ok' }), { status: 200 }));
    expect(await sendLoginCode('+989121234567', '561166', f as unknown as typeof fetch)).toEqual({ ok: true, message: 'sent' });
    const [, init] = f.mock.calls[0] as unknown as [string, RequestInit];
    expect(JSON.parse(String(init.body))).toEqual({ mobile: '09121234567', templateId: 123456, parameters: [{ name: 'CODE', value: '561166' }] });
    const bad = vi.fn(async () => new Response(JSON.stringify({ status: 0, message: 'credit' }), { status: 200 }));
    expect(await sendLoginCode('+989121234567', '561166', bad as unknown as typeof fetch)).toEqual({ ok: false, message: 'credit' });
  });
});

describe('comparing speech-to-text models', () => {
  it('character error rate ignores spaces and punctuation', () => {
    expect(cer('پنج کارگر داشتیم.', 'پنج‌کارگر داشتیم')).toBe(0);
    expect(cer('سلام', 'سلم')).toBeCloseTo(0.25);
  });
});
