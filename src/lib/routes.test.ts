import { beforeAll, describe, expect, it, vi } from 'vitest';
import { Webhook } from 'standardwebhooks';
import { sign } from '@/server/signing';

const calls: { fn: string; args: unknown }[] = [];
vi.mock('server-only', () => ({}));
vi.mock('@/server/db', () => ({
  serverDb: {
    rpc: async (fn: string, args: unknown) => {
      calls.push({ fn, args });
      if (fn === 'claim_job') return { id: null };
      if (fn === 'is_linked' && (args as { p_external_user: string }).p_external_user === 'boom') throw new Error('relation "secret_table" does not exist');
      if (fn === 'is_linked' && (args as { p_external_user: string }).p_external_user === 'down') throw new Error('TypeError: fetch failed');
      if (fn === 'sender_ledger') return '11111111-1111-4111-8111-111111111111';
      if (fn === 'ingest_message') return 'inbox-1';
      return null;
    },
    putFile: async () => undefined,
    getFile: async () => ({ bytes: new Uint8Array(), mime: 'x' }),
  },
}));

const RELAY = 'r'.repeat(40), BALE = 'b'.repeat(40);
beforeAll(() => { process.env.RELAY_SECRET = RELAY; process.env.BALE_BOT_SECRET = BALE; });

async function call(action: string, secret: string | null, body: unknown, reuse?: Record<string, string>) {
  const { POST } = await import('@/app/api/internal/[action]/route');
  const raw = typeof body === 'string' ? body : JSON.stringify(body);
  const path = `/api/internal/${action}`;
  const sig = reuse ?? (secret ? sign(secret, 'POST', path, raw) : {});
  const headers: Record<string, string> = { 'content-type': 'application/json', ...sig };
  const res = await POST(new Request(`http://site${path}`, { method: 'POST', body: raw, headers }), { params: Promise.resolve({ action }) });
  return Object.assign(res, { sig });
}

describe('the internal door', () => {
  it('refuses unsigned requests and lets each caller do only its own part', async () => {
    expect((await call('claim', null, {})).status).toBe(401);
    expect((await call('claim', 'z'.repeat(40), {})).status).toBe(401);
    expect((await call('claim', BALE, {})).status).toBe(403); // the Bale bot does not take AI jobs
    const r = await call('claim', RELAY, { kinds: ['extract'] });
    expect(r.status).toBe(200);
    expect(await r.json()).toEqual({ context: null });
  });
  it('a bot acts for its own channel only', async () => {
    calls.length = 0;
    await call('linked', BALE, { externalUser: '42' });
    expect(calls[0]).toEqual({ fn: 'is_linked', args: { p_channel: 'bale', p_external_user: '42' } });
    await call('linked', RELAY, { externalUser: '42' });
    expect(calls[1]).toEqual({ fn: 'is_linked', args: { p_channel: 'telegram', p_external_user: '42' } });
    await call('notify-done', BALE, { job: 9, lease: 'L', ok: true });
    expect(calls[2]).toEqual({ fn: 'finish_notify', args: { p_job: 9, p_lease: 'L', p_channel: 'bale', p_ok: true, p_error: null } });
  });
  it('two identical requests in the same second both pass; the same signed request twice does not', async () => {
    const a = await call('linked', BALE, { externalUser: '7' });
    const b = await call('linked', BALE, { externalUser: '7' });
    expect([a.status, b.status]).toEqual([200, 200]);
    expect((await call('linked', BALE, { externalUser: '7' }, a.sig)).status).toBe(401);
  });
  it('the relay passes its lease; a body over the limit is refused before it is read', async () => {
    calls.length = 0;
    await call('fail', RELAY, { job: 3, lease: 'L', error: 'x', permanent: true });
    expect(calls[0]).toEqual({ fn: 'fail_job', args: { p_job: 3, p_lease: 'L', p_error: 'x', p_permanent: true } });
    await call('heartbeat', RELAY, { job: 3, lease: 'L' });
    expect(calls[1]).toEqual({ fn: 'job_heartbeat', args: { p_job: 3, p_lease: 'L' } });
    expect((await call('claim', RELAY, 'x'.repeat(3 * 1024 * 1024))).status).toBe(413);
  });
  it('database errors are not passed on as they are; only a passing outage asks to try later', async () => {
    const spy = vi.spyOn(console, 'error').mockImplementation(() => undefined);
    const r = await call('linked', BALE, { externalUser: 'boom' });
    expect(r.status).toBe(500);
    expect(await r.json()).toEqual({ error: 'internal error' });
    const down = await call('linked', BALE, { externalUser: 'down' });
    expect(down.status).toBe(503);
    expect(await down.json()).toEqual({ error: 'temporarily unavailable' });
    spy.mockRestore();
  });
});

describe('the SMS hook', () => {
  it('accepts only Supabase’s signature', async () => {
    const secret = Buffer.from('s'.repeat(32)).toString('base64');
    process.env.SEND_SMS_HOOK_SECRET = `v1,whsec_${secret}`;
    process.env.SMSIR_API_KEY = 'k'; process.env.SMSIR_TEMPLATE_ID = '1';
    const { POST } = await import('@/app/api/hooks/send-sms/route');
    const payload = JSON.stringify({ user: { phone: '+989121234567' }, sms: { otp: '123456' } });
    expect((await POST(new Request('http://site/api/hooks/send-sms', { method: 'POST', body: payload }))).status).toBe(401);
    const wh = new Webhook(secret);
    const id = 'msg_1', ts = new Date();
    const headers = { 'webhook-id': id, 'webhook-timestamp': String(Math.floor(ts.getTime() / 1000)), 'webhook-signature': wh.sign(id, ts, payload) };
    const fetchSpy = vi.spyOn(globalThis, 'fetch').mockResolvedValue(new Response(JSON.stringify({ status: 1 }), { status: 200 }));
    const ok = await POST(new Request('http://site/api/hooks/send-sms', { method: 'POST', body: payload, headers }));
    expect(ok.status).toBe(200);
    expect(fetchSpy).toHaveBeenCalledWith('https://api.sms.ir/v1/send/verify', expect.anything());
    fetchSpy.mockRestore();
    // a large unsigned body is turned away without being read
    const big = await POST(new Request('http://site/api/hooks/send-sms', { method: 'POST', body: 'x'.repeat(100_000), headers: { ...headers, 'content-length': '100000' } }));
    expect(big.status).toBe(413);
  });
});
