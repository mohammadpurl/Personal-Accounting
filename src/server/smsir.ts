// SMS.ir: send a login code with a verify template (the template text, e.g. «کد ورود دفتر ساختمان: #CODE#», is
// approved in the SMS.ir panel; its id is SMSIR_TEMPLATE_ID and its parameter name SMSIR_PARAM, default CODE).
export interface SmsResult { ok: boolean; message: string }

/** +989121234567 / 989121234567 / 09121234567 → 09121234567; anything else is refused. */
export function iranMobile(phone: string): string | null {
  const d = phone.replace(/[۰-۹]/g, (c) => String('۰۱۲۳۴۵۶۷۸۹'.indexOf(c))).replace(/[^\d]/g, '');
  const m = d.match(/^(?:0098|98|0)?(9\d{9})$/);
  return m ? `0${m[1]}` : null;
}

export async function sendLoginCode(phone: string, code: string, fetchImpl: typeof fetch = fetch): Promise<SmsResult> {
  const key = process.env.SMSIR_API_KEY, template = Number(process.env.SMSIR_TEMPLATE_ID);
  if (!key || !template) return { ok: false, message: 'SMS.ir is not configured' };
  const mobile = iranMobile(phone);
  if (!mobile) return { ok: false, message: 'not an Iranian mobile number' };
  if (!/^\d{4,8}$/.test(code)) return { ok: false, message: 'bad code' };
  const r = await fetchImpl('https://api.sms.ir/v1/send/verify', {
    method: 'POST',
    headers: { 'content-type': 'application/json', accept: 'application/json', 'x-api-key': key },
    body: JSON.stringify({ mobile, templateId: template, parameters: [{ name: process.env.SMSIR_PARAM || 'CODE', value: code }] }),
    signal: AbortSignal.timeout(10_000),
  });
  const data = (await r.json().catch(() => ({}))) as { status?: number; message?: string };
  return r.ok && data.status === 1 ? { ok: true, message: 'sent' } : { ok: false, message: data.message ?? `SMS.ir answered ${r.status}` };
}
