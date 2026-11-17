// What the bot says and does for each message — the same for Bale and Telegram. Linking an account takes two steps:
// the person shares their own number (request_contact), then types the 6-digit code shown on the site. After that,
// every voice, photo, file or text they send is archived and understood; nothing is recorded until the owner confirms.
import type { BotApi, TgMessage, TgUpdate } from './tgapi';
import { toLatinDigits, toPersianDigits } from '../money';
import { READABLE_IMAGE, STT_AUDIO } from '../media-types';

export type MediaKind = 'voice' | 'image' | 'document' | 'video' | 'other';
export interface OutFile { fileId: string; mime: string; kind: MediaKind; filename?: string; durationMs?: number; caption?: string; size?: number }
export interface Core {
  linked(externalUser: string): Promise<boolean>;
  link(l: { senderId: string; contactUserId: string; phone: string; code: string }): Promise<void>;
  ingest(meta: { externalUser: string; chat: string; message: string; text?: string; album?: string; sentAt?: string; files: Omit<OutFile, 'fileId'>[] }, bytes: Uint8Array[]): Promise<void>;
}

export const MSG = {
  welcome: 'سلام! این ربات «دفتر ساختمان» است. وصل‌شدن دو قدم دارد:\n۱) دکمهٔ «ارسال شمارهٔ خودم» را در پایین بزنید.\nدکمه را نمی‌بینید؟ آیکون کیبورد کنار جای نوشتن را بزنید (فقط در گوشی).\n۲) کد شش‌رقمی را از سایت، بخش «اتصال ربات»، بگیرید و همین‌جا بنویسید.',
  notYours: 'این شمارهٔ خود شما نیست؛ شاید مخاطب دیگری را فرستادید. فقط دکمهٔ «ارسال شمارهٔ خودم» را بزنید.',
  askCode: 'شماره‌تان ثبت شد. حالا در سایت به بخش «اتصال ربات» بروید، کد شش‌رقمی را بگیرید و همین‌جا بنویسید. کد ده دقیقه اعتبار دارد.',
  waitingCode: 'شماره‌تان رسیده است. فقط کد شش‌رقمی را از سایت، بخش «اتصال ربات»، بگیرید و همین‌جا بنویسید.',
  linked: 'حسابتان وصل شد.\nهمین‌جا بفرستید: ویس، عکس رسید، چک یا فاکتور.\nسند و نقشه را «به‌صورت فایل» بفرستید تا کیفیتش کم نشود.\nتا صاحب‌کار در سایت تأیید نکند، چیزی ثبت نمی‌شود.\nراهنما: /help',
  noProject: 'هنوز در هیچ پروژه‌ای عضو نیستید. از صاحب‌کار بخواهید شما را به پروژه اضافه کند.',
  alreadyLinked: 'حسابتان وصل است.',
  codeShape: 'کد باید شش رقم باشد. همان کدی را که سایت نشان می‌دهد بنویسید.',
  codeFirst: 'اول دکمهٔ «ارسال شمارهٔ خودم» را بزنید، بعد همین کد را دوباره بنویسید.',
  expired: 'مهلت نوشتن کد تمام شد. دوباره دکمهٔ «ارسال شمارهٔ خودم» را بزنید و بعد کد تازه را بنویسید.',
  notLinked: 'این حساب هنوز به دفتر ساختمان وصل نیست. دکمهٔ «ارسال شمارهٔ خودم» را در پایین بزنید، بعد کد شش‌رقمی را بنویسید.',
  received: 'دریافت شد. دارم بررسی می‌کنم؛ نتیجه را همین‌جا می‌فرستم.',
  video: 'فیلم بایگانی شد، ولی ربات حرف‌های داخل فیلم را نمی‌فهمد. اگر چیزی باید ثبت شود، جدا ویس بفرستید.',
  audioFormat: 'صدا بایگانی شد، ولی ربات این نوع فایل صوتی را نمی‌خواند. همین حرف‌ها را با دکمهٔ میکروفون، به‌صورت ویس معمولی، دوباره بگویید.',
  voiceFormat: 'ویس بایگانی شد، ولی ربات فعلاً ویس‌های این پیام‌رسان را نمی‌خواند. لطفاً همین را بنویسید.',
  archived: 'فایل بایگانی شد. ربات این نوع فایل را نمی‌خواند؛ اگر چیزی باید ثبت شود، با ویس بگویید یا بنویسید.',
  failed: 'ذخیره نشد. چند دقیقهٔ دیگر دوباره بفرستید.',
  help: 'طبیعی بگویید چه شد؛ مثلاً «امروز پنج کارگر داشتیم، نفری یک میلیون و دویست، هنوز ندادم» یا «یک چک صد و بیست میلیونی به صالحی دادم، سررسید سی آبان». راهنمای کامل در سایت، بخش «راهنمای ثبت».',
  helpUnlinked: 'اول باید وصل شوید: /start',
  empty: 'این پیام چیزی برای ثبت نداشت. ویس، عکس یا متن بفرستید.',
  edited: 'ویرایش پیام ثبت نمی‌شود؛ اصلاح را به‌صورت پیام تازه بفرستید.',
  privateOnly: 'من فقط در گفت‌وگوی خصوصی کار می‌کنم؛ مستقیم به خود ربات پیام بدهید.',
  tooBig: 'این فایل بزرگ‌تر از ۲۰ مگابایت است و ربات نمی‌تواند آن را بگیرد. ویس را کوتاه‌تر کنید (چند ویس پشت‌سرهم بفرستید)، یا فیلم را کوتاه یا فشرده کنید.',
  tooManyTries: 'چند بار کد اشتباه نوشته شد. برای امنیت، یک ساعت دیگر دوباره از اول شروع کنید: /start',
  notTheOne: 'شمارهٔ این حساب پیام‌رسان با شماره‌ای که با آن وارد سایت می‌شوید فرق دارد. از صاحب‌کار بخواهید همین شماره را در پروژه ثبت کند.',
  wrongCode: (left: number) => `کد درست نیست یا وقتش گذشته. کد تازه را از سایت بگیرید و همین‌جا بنویسید (${toPersianDigits(left)} بار دیگر می‌توانید).`,
  linkOther: 'وصل نشد. چند دقیقهٔ دیگر دوباره کد را بفرستید؛ اگر باز نشد، به صاحب‌کار خبر دهید.',
};

/** Telegram's bot API does not hand over files larger than this; Bale is assumed to be the same (to be checked). */
export const BOT_FILE_MAX = 20 * 1024 * 1024;
const CODE_TRIES = 5;
const PENDING_MS = 15 * 60 * 1000;
const LOCK_MS = 60 * 60 * 1000; // wrong codes count for an hour, even if the number is shared again

/** The files of a message, largest photo only; documents keep their name so drawings (DWG/PDF) stay recognisable.
 *  A sent-as-file photo counts as a photo only in a type the AI can read (a DWG often claims to be «image/vnd.dwg»);
 *  an audio file sent as a file is still a voice. */
export function filesOf(m: TgMessage): OutFile[] {
  const out: OutFile[] = [];
  const caption = m.caption?.slice(0, 1000);
  // audio counts as a voice only in a format the speech-to-text reads (the site decides the same way)
  const audioKind = (mime: string): MediaKind => (STT_AUDIO[mime] ? 'voice' : 'other');
  // a voice note is always OGG/Opus, whatever name the messenger gives the type
  if (m.voice) { const mime = !m.voice.mime_type || /ogg|opus/i.test(m.voice.mime_type) ? 'audio/ogg' : m.voice.mime_type; out.push({ fileId: m.voice.file_id, mime, kind: audioKind(mime), durationMs: (m.voice.duration ?? 0) * 1000, caption, size: m.voice.file_size }); }
  if (m.audio) { const mime = m.audio.mime_type ?? 'audio/mpeg'; out.push({ fileId: m.audio.file_id, mime, kind: audioKind(mime), filename: m.audio.file_name, durationMs: (m.audio.duration ?? 0) * 1000, caption, size: m.audio.file_size }); }
  if (m.photo?.length) {
    const best = [...m.photo].sort((a, b) => b.width * b.height - a.width * a.height)[0];
    out.push({ fileId: best.file_id, mime: 'image/jpeg', kind: 'image', caption, size: best.file_size });
  }
  if (m.document) {
    const mime = m.document.mime_type ?? 'application/octet-stream';
    const kind: MediaKind = READABLE_IMAGE.test(mime) ? 'image' : mime.startsWith('audio/') ? audioKind(mime) : 'document';
    out.push({ fileId: m.document.file_id, mime, kind, filename: m.document.file_name, caption, size: m.document.file_size });
  }
  if (m.video) out.push({ fileId: m.video.file_id, mime: m.video.mime_type ?? 'video/mp4', kind: 'video', durationMs: (m.video.duration ?? 0) * 1000, caption, size: m.video.file_size });
  if (m.video_note) out.push({ fileId: m.video_note.file_id, mime: 'video/mp4', kind: 'video', durationMs: (m.video_note.duration ?? 0) * 1000, size: m.video_note.file_size });
  return out;
}

/** Per chat (kept in memory; a restart only means asking again): the shared number waiting for its code, and the
 *  wrong codes of the last hour. `phone` is empty once the wait has expired but the wrong codes still count. */
export type Pending = Map<string, { phone: string; contactUserId: string; at: number; tries?: number; triesSince?: number; locked?: boolean }>;

/** An error from our own site that is not about this message — down, unreachable, or refusing our signature (a wrong
 *  secret or clock, which a fix on the server mends): try the message again later. */
export const siteUnavailable = (e: unknown) => {
  const err = e as { site?: boolean; status?: number; timeout?: boolean };
  return err?.site === true && !err.timeout && (!err.status || [401, 502, 503, 504].includes(err.status));
};

// photos sent together (an album) get one «received» reply, not one each
const albumsAnswered = new Map<string, number>();

export async function handleUpdate(u: TgUpdate, api: BotApi, core: Core, pending: Pending, now = Date.now()): Promise<void> {
  if (u.edited_message) {
    const e = u.edited_message;
    if (e.from && e.chat.type === 'private' && (await core.linked(String(e.from.id)))) await api.send(e.chat.id, MSG.edited, undefined, e.message_id);
    return;
  }
  const m = u.message;
  if (!m?.from) return;
  const text = toLatinDigits(m.text?.trim() ?? '');
  if (m.chat.type !== 'private') { // groups are not read; a /start there gets one pointer to the private chat
    if (/^\/start(@\w+)?$/.test(text)) await api.send(m.chat.id, MSG.privateOnly);
    return;
  }
  const chat = String(m.chat.id), user = String(m.from.id);
  for (const [k, v] of pending) if (now - v.at > PENDING_MS && (!v.triesSince || now - v.triesSince > LOCK_MS)) pending.delete(k);
  const p = pending.get(chat);
  const locked = !!p?.locked && !!p.triesSince && now - p.triesSince <= LOCK_MS;

  if (text === '/start') {
    if (await core.linked(user)) { await api.send(chat, `${MSG.alreadyLinked}\n\n${MSG.help}`, 'remove'); return; }
    if (locked) { await api.send(chat, MSG.tooManyTries, 'remove'); return; }
    await api.send(chat, MSG.welcome, 'contact');
    return;
  }
  if (text === '/help') {
    await api.send(chat, (await core.linked(user)) ? MSG.help : `${MSG.help}\n\n${MSG.helpUnlinked}`);
    return;
  }

  if (m.contact) {
    if (await core.linked(user)) { await api.send(chat, MSG.alreadyLinked, 'remove'); return; }
    if (locked) { await api.send(chat, MSG.tooManyTries, 'remove'); return; }
    if (String(m.contact.user_id ?? '') !== user) { await api.send(chat, MSG.notYours, 'contact'); return; }
    // wrong codes of the last hour still count when the number is shared again
    const keep = p?.triesSince && now - p.triesSince <= LOCK_MS ? { tries: p.tries, triesSince: p.triesSince } : {};
    pending.set(chat, { phone: m.contact.phone_number, contactUserId: user, at: now, ...keep });
    await api.send(chat, MSG.askCode, 'remove');
    return;
  }

  const code = text.replace(/[\s-]/g, '');
  if (/^\d+$/.test(code) && !(await core.linked(user))) {
    if (locked) { await api.send(chat, MSG.tooManyTries); return; }
    if (!p?.phone) { await api.send(chat, MSG.codeFirst, 'contact'); return; }
    if (now - p.at > PENDING_MS) { p.phone = ''; await api.send(chat, MSG.expired, 'contact'); return; }
    if (code.length !== 6) { await api.send(chat, MSG.codeShape); return; }
    try {
      await core.link({ senderId: user, contactUserId: p.contactUserId, phone: p.phone, code });
    } catch (e) {
      if (siteUnavailable(e)) throw e;
      const msg = (e as Error).message;
      if (/own number/.test(msg)) { p.phone = ''; await api.send(chat, MSG.notYours, 'contact'); return; }
      if (/not the one/.test(msg)) { p.phone = ''; await api.send(chat, MSG.notTheOne, 'remove'); return; }
      if (/wrong or expired/.test(msg)) {
        if (!p.triesSince || now - p.triesSince > LOCK_MS) { p.tries = 0; p.triesSince = now; }
        p.tries = (p.tries ?? 0) + 1;
        const left = CODE_TRIES - p.tries;
        if (left <= 0) { p.locked = true; p.triesSince = now; p.phone = ''; await api.send(chat, MSG.tooManyTries); return; } // locked for an hour from now
        await api.send(chat, MSG.wrongCode(left));
        return;
      }
      await api.send(chat, MSG.linkOther);
      return;
    }
    pending.delete(chat);
    // linked: a failed «linked» message must not make the loop run this update again (the code would then be filed)
    await api.send(chat, MSG.linked).catch(() => undefined);
    return;
  }

  if (!(await core.linked(user))) {
    await api.send(chat, p?.phone ? MSG.waitingCode : MSG.notLinked, p?.phone ? undefined : 'contact');
    return;
  }
  const files = filesOf(m);
  const body = m.text?.trim() || undefined;
  if (!files.length && !body) { await api.send(chat, MSG.empty, undefined, m.message_id); return; }
  if (files.some((f) => (f.size ?? 0) > BOT_FILE_MAX)) { await api.send(chat, MSG.tooBig, undefined, m.message_id); return; }
  try {
    const bytes: Uint8Array[] = [];
    for (const f of files) bytes.push(await api.download(f.fileId));
    await core.ingest({
      externalUser: user, chat, message: String(m.message_id), text: body, album: m.media_group_id, // a caption travels with its file
      sentAt: m.date ? new Date(m.date * 1000).toISOString() : undefined,
      files: files.map((f) => ({ mime: f.mime, kind: f.kind, filename: f.filename, durationMs: f.durationMs, caption: f.caption })),
    }, bytes);
  } catch (e) {
    const err = e as Error & { site?: boolean };
    // the site down, or the messenger failing to hand over a file: the bot loop tries this message again
    // not the site's (the messenger), the site down, or a fault at the site (500): the bot loop tries again; a refusal
    // about this message (4xx) is answered
    if (!err.site || siteUnavailable(e) || (e as { timeout?: boolean }).timeout || ((e as { status?: number }).status ?? 0) >= 500) throw e;
    await api.send(chat, /no project/.test(err.message) ? MSG.noProject : MSG.failed, undefined, m.message_id);
    return;
  }
  for (const [k, t] of albumsAnswered) if (now - t > 2 * 60 * 1000) albumsAnswered.delete(k);
  if (m.media_group_id && albumsAnswered.has(`${chat}:${m.media_group_id}`)) return;
  if (m.media_group_id) albumsAnswered.set(`${chat}:${m.media_group_id}`, now);
  const hasVideo = files.some((f) => f.kind === 'video');
  // nothing the AI can read (as the site decides too): archived only, and no «result» will follow
  const readable = !!body || files.some((f) => ['voice', 'image', 'document'].includes(f.kind) || !!f.caption?.trim());
  const odd = files.some((f) => f.kind === 'other');
  const note = (hasVideo ? `\n${MSG.video}` : '') + (odd ? `\n${m.voice && files[0]?.kind === 'other' ? MSG.voiceFormat : files.some((f) => f.mime.startsWith('audio/') && f.kind === 'other') ? MSG.audioFormat : MSG.archived}` : '');
  const reply = readable ? MSG.received + note : note.trim();
  // the message is stored; a failed reply is not worth running the whole message again
  await api.send(chat, reply, undefined, m.message_id).catch(() => undefined);
}
