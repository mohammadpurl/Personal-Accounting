// Requests between our own processes (the relay abroad, the Bale bot on the Iranian server) and the site are signed
// with a shared secret: HMAC-SHA256 over time, a random nonce, method, path and the body's hash. A request older than
// five minutes (or more than 30 seconds in the future), or a nonce seen before, is refused — so a captured request
// cannot be replayed and a stranger cannot pretend to be the relay. The nonce memory is per process: run the site as
// a single instance (see docs/deploy.md).
import { createHash, createHmac, randomBytes, timingSafeEqual } from 'node:crypto';

const PAST_MS = 5 * 60 * 1000, FUTURE_MS = 30 * 1000;
const sha256 = (b: Uint8Array | string) => createHash('sha256').update(b).digest('hex');
const mac = (secret: string, ts: string, nonce: string, method: string, path: string, body: Uint8Array | string) =>
  createHmac('sha256', secret).update(`${ts}.${nonce}.${method.toUpperCase()}.${path}.${sha256(body)}`);

export function sign(secret: string, method: string, path: string, body: Uint8Array | string, now = Date.now()) {
  const ts = String(Math.floor(now / 1000));
  const nonce = randomBytes(16).toString('hex');
  return { 'x-sig-timestamp': ts, 'x-sig-nonce': nonce, 'x-sig': mac(secret, ts, nonce, method, path, body).digest('hex') };
}

/** Cheap checks on the headers alone, before the body is read. */
export function plausible(headers: Headers, now = Date.now()): boolean {
  const ts = headers.get('x-sig-timestamp') ?? '', nonce = headers.get('x-sig-nonce') ?? '', sig = headers.get('x-sig') ?? '';
  if (!/^\d{10}$/.test(ts) || !/^[0-9a-f]{32}$/.test(nonce) || !/^[0-9a-f]{64}$/.test(sig)) return false;
  const t = Number(ts) * 1000;
  return now - t <= PAST_MS && t - now <= FUTURE_MS;
}

const seen = new Map<string, number>(); // nonce → when it stops mattering

/** Does this secret sign the request? (No side effects: call `remember` once the caller is known.) */
export function matches(secret: string | undefined, method: string, path: string, body: Uint8Array | string, headers: Headers, now = Date.now()): boolean {
  if (!secret || secret.length < 32 || !plausible(headers, now)) return false;
  const ts = headers.get('x-sig-timestamp')!, nonce = headers.get('x-sig-nonce')!;
  const want = mac(secret, ts, nonce, method, path, body).digest();
  const got = Buffer.from(headers.get('x-sig')!, 'hex');
  return got.length === want.length && timingSafeEqual(got, want);
}

/** Accept a nonce once; false when it was already used. */
export function remember(headers: Headers, now = Date.now()): boolean {
  const nonce = headers.get('x-sig-nonce') ?? '';
  for (const [k, until] of seen) if (until < now) seen.delete(k);
  if (seen.has(nonce)) return false;
  seen.set(nonce, Number(headers.get('x-sig-timestamp')) * 1000 + PAST_MS + FUTURE_MS);
  return true;
}

/** matches + remember, for a single expected secret. */
export function verify(secret: string | undefined, method: string, path: string, body: Uint8Array | string, headers: Headers, now = Date.now()): boolean {
  return matches(secret, method, path, body, headers, now) && remember(headers, now);
}

export { sha256 };
