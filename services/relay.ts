// Relay — runs on a server outside Iran. It starts every connection itself (to the site in Iran, to OpenAI, to Telegram),
// so the Iranian server never has to reach abroad. It runs the Telegram bot and does the AI work for every message.
// It holds the OpenAI key and the relay's signing secret: treat this server as sensitive (see docs/deploy.md).
//   CORE_URL            the site in Iran, e.g. https://daftar.example.ir
//   RELAY_SECRET        signing secret shared with the site (≥ 32 characters)
//   OPENAI_API_KEY      for speech-to-text and reading
//   AI_MODEL, STT_MODEL optional model names (defaults in src/lib/ai/providers.ts)
//   TELEGRAM_BOT_TOKEN  optional; without it only the AI work runs
// Run: npm run relay
import OpenAI from 'openai';
import { coreClient } from '../src/lib/bots/core-client';
import { botApi } from '../src/lib/bots/tgapi';
import { handleUpdate, type Pending } from '../src/lib/bots/conversation';
import { extractWithOpenAI, openAiStt } from '../src/lib/ai/providers';
import { processJob, type Job } from '../src/lib/ai/worker';
import { runBot, sleep, stopping } from './run-bot';

const need = (k: string) => { const v = process.env[k]; if (!v) throw new Error(`${k} is not set`); return v; };
const core = coreClient(need('CORE_URL'), need('RELAY_SECRET'));
// one slow answer must not hold a worker forever; the SDK's own retries are kept to one (the job queue retries too)
const openai = new OpenAI({ apiKey: need('OPENAI_API_KEY'), timeout: 240_000, maxRetries: 1 });
const stt = openAiStt(openai);
const log = (...a: unknown[]) => console.log(new Date().toISOString(), 'relay', ...a);

const WORKERS = Math.max(1, Math.min(8, Number(process.env.RELAY_WORKERS) || 2));
for (let w = 0; w < WORKERS; w++) {
  (async () => {
    while (!stopping()) {
      try {
        const { context } = await core.post<{ context: Job | null }>('claim', { kinds: ['transcribe', 'extract'] });
        if (!context) { await sleep(2000); continue; }
        const r = await processJob(context, {
          file: (job, lease, media) => core.file(job, lease, media),
          heartbeat: (job, lease) => core.post('heartbeat', { job, lease }),
          stt,
          extract: (input) => extractWithOpenAI(openai, input),
          post: (action, body) => core.post(action, body),
        });
        log(`job ${context.job.id} ${context.job.kind}: ${r}`);
      } catch (e) {
        log('cannot reach the site; retrying', (e as Error).message);
        await sleep(10_000);
      }
    }
  })();
}

if (process.env.TELEGRAM_BOT_TOKEN) {
  const api = botApi('https://api.telegram.org', process.env.TELEGRAM_BOT_TOKEN);
  const pending: Pending = new Map();
  runBot('telegram', api, core, (u) => handleUpdate(u, api, core, pending));
}
log(`running with ${WORKERS} workers`);
