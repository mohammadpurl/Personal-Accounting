// A small client for Telegram-style bot APIs. Bale's bot API follows Telegram's (base https://tapi.bale.ai), so one
// client serves both: Bale from the Iranian server, Telegram (https://api.telegram.org) from the relay abroad.
export interface TgFile { file_id: string; file_size?: number; mime_type?: string; file_name?: string; duration?: number }
export interface TgPhoto { file_id: string; width: number; height: number; file_size?: number }
export interface TgMessage {
  message_id: number;
  date?: number; // unix seconds, when it was sent
  from?: { id: number; first_name?: string };
  chat: { id: number; type: string };
  text?: string; caption?: string; media_group_id?: string;
  voice?: TgFile; audio?: TgFile; document?: TgFile; video?: TgFile; video_note?: TgFile; photo?: TgPhoto[];
  contact?: { phone_number: string; user_id?: number };
}
export interface TgUpdate { update_id: number; message?: TgMessage; edited_message?: TgMessage }

export type Keyboard = 'contact' | 'remove';
export interface BotApi {
  getUpdates(offset: number, timeoutSec: number): Promise<TgUpdate[]>;
  download(fileId: string): Promise<Uint8Array>;
  /** `replyTo`: the message this answers, shown quoted above the answer (sent anyway if that message is gone). */
  send(chatId: number | string, text: string, keyboard?: Keyboard, replyTo?: number | string): Promise<void>;
}

/** An error of the messenger itself (Bale / Telegram), as opposed to our site. */
export class BotApiError extends Error {}

export function botApi(base: string, token: string, fetchImpl: typeof fetch = fetch): BotApi {
  const call = async <T,>(method: string, params: Record<string, unknown>, timeoutMs = 30_000): Promise<T> => {
    const r = await fetchImpl(`${base}/bot${token}/${method}`, {
      method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify(params), signal: AbortSignal.timeout(timeoutMs),
    }).catch((e: Error) => { throw new BotApiError(`${method}: ${e.message}`); });
    const data = (await r.json().catch(() => ({ ok: false }))) as { ok: boolean; result?: T; description?: string };
    if (!data.ok) throw new BotApiError(`${method}: ${data.description ?? r.status}`);
    return data.result as T;
  };
  return {
    getUpdates: (offset, timeoutSec) => call<TgUpdate[]>('getUpdates', { offset, timeout: timeoutSec, allowed_updates: ['message', 'edited_message'] }, (timeoutSec + 15) * 1000),
    async download(fileId) {
      const f = await call<{ file_path: string }>('getFile', { file_id: fileId });
      const r = await fetchImpl(`${base}/file/bot${token}/${f.file_path}`, { signal: AbortSignal.timeout(120_000) })
        .catch((e: Error) => { throw new BotApiError(`download: ${e.message}`); });
      if (!r.ok) throw new BotApiError(`download failed: ${r.status}`);
      return new Uint8Array(await r.arrayBuffer());
    },
    async send(chatId, text, keyboard, replyTo) {
      const reply_markup = keyboard === 'contact'
        ? { keyboard: [[{ text: 'ارسال شمارهٔ خودم', request_contact: true }]], resize_keyboard: true, one_time_keyboard: true }
        : keyboard === 'remove' ? { remove_keyboard: true } : undefined;
      // reply_to_message_id + allow_sending_without_reply: understood by Telegram and by Bale's Telegram-style API
      const reply = replyTo !== undefined && /^\d+$/.test(String(replyTo)) ? { reply_to_message_id: Number(replyTo), allow_sending_without_reply: true } : {};
      await call('sendMessage', { chat_id: chatId, text, ...(reply_markup ? { reply_markup } : {}), ...reply });
    },
  };
}
