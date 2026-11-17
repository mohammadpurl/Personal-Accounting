// The loops a bot process runs: messages in (long polling), replies out (notify jobs from the site). A failing call
// waits and tries again, so a short network cut between Iran and abroad only delays things.
import type { BotApi, TgUpdate } from '../src/lib/bots/tgapi';
import type { CoreClient } from '../src/lib/bots/core-client';
import { MSG, siteUnavailable } from '../src/lib/bots/conversation';

export const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));
const log = (who: string, ...a: unknown[]) => console.log(new Date().toISOString(), who, ...a);

// one stop flag per process: on SIGTERM/SIGINT every loop finishes its current step and ends
let stop = false;
process.once('SIGTERM', () => { stop = true; });
process.once('SIGINT', () => { stop = true; });
export const stopping = () => stop;

const UPDATE_TRIES = 5;
const MAX_WAIT_MS = 20 * 60 * 60 * 1000; // the messengers keep unanswered updates about a day; give up before they do

/** One update, tried until it is handled. While the site is down the same update waits (the messenger keeps the
 *  updates that are not yet acknowledged for about a day), so nothing is dropped during a deploy or a network cut.
 *  Any other failure (e.g. the messenger not handing over a file) is tried a few times, then the sender is told. */
export async function handleWithRetry(name: string, u: TgUpdate, api: BotApi, onUpdate: (u: TgUpdate) => Promise<void>, wait = sleep, now = () => Date.now()) {
  let tries = 0, siteWait = 2000;
  const sent = (u.message?.date ?? u.edited_message?.date ?? now() / 1000) * 1000;
  while (!stop) {
    try { await onUpdate(u); return; } catch (e) {
      if (siteUnavailable(e) && now() - sent < MAX_WAIT_MS) {
        log(name, `the site is unavailable; update ${u.update_id} waits`, (e as Error).message);
        await wait(siteWait); siteWait = Math.min(siteWait * 2, 60_000);
        continue;
      }
      tries++;
      log(name, `update ${u.update_id} failed (try ${tries})`, (e as Error).message);
      if (tries >= UPDATE_TRIES) {
        const m = u.message;
        if (m) await api.send(m.chat.id, MSG.failed, undefined, m.message_id).catch(() => undefined);
        return;
      }
      await wait(2000 * 2 ** tries);
    }
  }
}

export function runBot(name: string, api: BotApi, core: CoreClient, onUpdate: (u: TgUpdate) => Promise<void>) {
  (async () => {
    let offset = 0, wait = 1000;
    while (!stop) {
      try {
        const updates = await api.getUpdates(offset, 25);
        for (const u of updates) {
          await handleWithRetry(name, u, api, onUpdate);
          if (stop) break; // not acknowledged: the messenger hands it over again after the restart
          offset = u.update_id + 1;
        }
        wait = 1000;
      } catch (e) {
        log(name, 'polling failed; retrying', (e as Error).message);
        await sleep(wait); wait = Math.min(wait * 2, 60_000);
      }
    }
  })();

  (async () => {
    while (!stop) {
      try {
        const { job } = await core.post<{ job: { id: number; lease: string; chat_id: string; text: string; reply_to?: string } | null }>('notify-claim');
        if (!job) { await sleep(3000); continue; }
        try {
          await api.send(job.chat_id, job.text, undefined, job.reply_to);
          await core.post('notify-done', { job: job.id, lease: job.lease, ok: true });
        } catch (e) {
          await core.post('notify-done', { job: job.id, lease: job.lease, ok: false, error: (e as Error).message });
        }
      } catch (e) {
        log(name, 'replies failed; retrying', (e as Error).message);
        await sleep(10_000);
      }
    }
  })();
  log(name, 'running');
}
