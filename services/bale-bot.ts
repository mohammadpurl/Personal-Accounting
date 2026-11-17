// Bale bot — runs on the Iranian server next to the site (Bale is reachable from inside Iran).
// Receives messages by long polling, hands them to the site, and sends back the «understood» replies.
//   BALE_BOT_TOKEN   token from @botfather in Bale
//   CORE_URL         the site, e.g. http://127.0.0.1:3000
//   BALE_BOT_SECRET  signing secret shared with the site (≥ 32 characters)
// Run: npm run bale-bot
import { botApi } from '../src/lib/bots/tgapi';
import { handleUpdate, type Pending } from '../src/lib/bots/conversation';
import { coreClient } from '../src/lib/bots/core-client';
import { runBot } from './run-bot';

const need = (k: string) => { const v = process.env[k]; if (!v) throw new Error(`${k} is not set`); return v; };
const api = botApi('https://tapi.bale.ai', need('BALE_BOT_TOKEN'));
const core = coreClient(need('CORE_URL'), need('BALE_BOT_SECRET'));
const pending: Pending = new Map();

runBot('bale', api, core, (u) => handleUpdate(u, api, core, pending));
