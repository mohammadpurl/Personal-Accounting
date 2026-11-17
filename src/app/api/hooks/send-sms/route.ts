// Supabase Auth «Send SMS» hook: Auth asks us to deliver a login code; we check the hook's signature (Standard
// Webhooks, secret SEND_SMS_HOOK_SECRET = «v1,whsec_…») and send it through SMS.ir. The code itself is never logged.
import { Webhook } from 'standardwebhooks';
import { sendLoginCode } from '@/server/smsir';

const fail = (http_code: number, message: string) =>
  Response.json({ error: { http_code, message } }, { status: http_code });

const MAX_BODY = 16 * 1024; // a hook call is a small JSON

/** The body, at most `limit` bytes; null when larger. */
async function readCapped(req: Request, limit: number): Promise<string | null> {
  if (Number(req.headers.get('content-length') ?? 0) > limit) return null;
  if (!req.body) return '';
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
  return Buffer.concat(parts).toString('utf8');
}

export async function POST(req: Request) {
  const secrets = (process.env.SEND_SMS_HOOK_SECRET ?? '').split('|').map((s) => s.trim().replace(/^v1,whsec_/, '')).filter(Boolean);
  if (!secrets.length) return fail(500, 'hook secret is not set');
  // unsigned calls are turned away before their body is read
  if (!req.headers.get('webhook-id') || !req.headers.get('webhook-timestamp') || !req.headers.get('webhook-signature')) return fail(401, 'bad signature');
  const payload = await readCapped(req, MAX_BODY);
  if (payload === null) return fail(413, 'too large');
  const headers = Object.fromEntries(req.headers);
  type Hook = { user?: { phone?: string }; sms?: { otp?: string } };
  const verified = (): Hook | null => {
    for (const s of secrets) {
      try { return new Webhook(s).verify(payload, headers) as Hook; } catch { /* try the next secret (rotation) */ }
    }
    return null;
  };
  const body = verified();
  if (!body) return fail(401, 'bad signature');
  const phone = body.user?.phone ?? '', otp = body.sms?.otp ?? '';
  const r = await sendLoginCode(phone, otp);
  return r.ok ? Response.json({}) : fail(502, `could not send the code: ${r.message}`);
}
