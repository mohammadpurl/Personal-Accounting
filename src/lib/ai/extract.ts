// What the AI is asked and how its answer becomes draft cards. Pure code (no network): the prompt is built from the
// record templates and the project's own people, accounts and stages; the answer is checked field by field, ids the
// model made up are dropped, and anything guessed is marked «مطمئن نیستم» so the owner checks it before confirming.
import { z } from 'zod';
import type { DraftCard } from '../book';
import { DOC_CATEGORIES, type DraftKind } from '../drafts';
import { TEMPLATES } from '../templates';
import { formatJalali, isoToJalali, jalaliToIso, monthLength } from '../jalali';

export interface ExtractContext {
  today: string; // ISO date in Tehran
  people: { id: string; name: string; role?: string; aliases?: string[] }[];
  accounts: { id: string; name: string; ledgerKind: 'project' | 'company' | 'personal' }[];
  stages: { id: string; name: string; inProgress?: boolean }[];
}

const KINDS = ['payment', 'receipt', 'transfer', 'work_log', 'stage_progress', 'daily_note', 'document', 'cheque', 'unknown'] as const;
const nul = <T extends z.ZodTypeAny>(t: T) => t.nullable();
const Money = z.object({ value: z.number(), unit: z.enum(['toman', 'rial']) });

/** Strict structured output: every key present, «null» when not said. */
export const ExtractionSchema = z.object({
  highlights: z.array(z.string()).describe('exact phrases copied from the text that the cards were built from'),
  chips: z.array(z.string()).describe('one very short Persian label per card, e.g. «کارکرد ۵ نفر»'),
  cards: z.array(z.object({
    kind: z.enum(KINDS),
    amount: nul(Money),
    wage_per_person: nul(Money),
    headcount: nul(z.number().int()),
    paid: nul(z.boolean()),
    settles: nul(z.boolean()),
    direction: nul(z.enum(['issued', 'received'])),
    person_id: nul(z.string()),
    account_id: nul(z.string()),
    from_account_id: nul(z.string()),
    to_account_id: nul(z.string()),
    stage_id: nul(z.string()),
    date: nul(z.string()).describe('Jalali yyyy/mm/dd (e.g. 1405/08/26) when another day than today was said, else null'),
    due_date: nul(z.string()).describe('Jalali yyyy/mm/dd'),
    progress_pct: nul(z.number().int()),
    stage_status: nul(z.enum(['in_progress', 'done'])),
    method: nul(z.string()),
    tracking_no: nul(z.string()),
    bank: nul(z.string()),
    sayad_no: nul(z.string()),
    title: nul(z.string()),
    category_code: nul(z.enum(Object.keys(DOC_CATEGORIES) as [string, ...string[]])),
    body: nul(z.string()),
    description: nul(z.string()),
    guesses: z.array(z.object({ field: z.string(), reason: z.string() })).describe('fields filled by inference, each with a short Persian reason'),
  })),
});
export type Extraction = z.infer<typeof ExtractionSchema>;

export const PROMPT_VERSION = 'extract-2026-11-17';

/** Instructions for the model: the templates, the project's lists, and the rules that keep money safe. */
export function buildInstructions(ctx: ExtractContext): string {
  const tpl = TEMPLATES.filter((t) => !t.soon).map((t) =>
    `- ${t.key} («${t.label}»): required: ${t.required.join('، ')}; optional: ${t.optional.join('، ')}; e.g. «${t.examples[0]}»`).join('\n');
  const list = <T,>(xs: T[], f: (x: T) => string) => xs.map(f).join('\n') || '(none)';
  return [
    'You read what a building-site owner or foreman in Iran said (Persian voice transcript, typed text, or a photo of a receipt, invoice or cheque) and turn it into draft records for the owner to confirm. Nothing you return is recorded until the owner confirms it.',
    `Today in Tehran is ${jalaliSlash(ctx.today)} (Jalali; ${formatJalali(ctx.today, { withYear: true, weekday: true })}). «دیروز» is the day before. Return every date in Jalali as yyyy/mm/dd with Latin digits — never convert to Gregorian; a day + month said without a year is in the current Jalali year unless that would be far in the future.`,
    'Record kinds (one card per job; one message can hold several jobs):', tpl,
    'Rules:',
    '- Amounts: people speak in Toman unless they say «ریال». Persian number words count («دوازده میلیون» = 12,000,000; «یک میلیون و دویست» said for a wage = 1,200,000). Receipts and cheques are usually printed in Rial — read the unit from the document.',
    '- «دادم / پرداخت کردم / کارت به کارت کردم» is money going out; «گرفتم» about goods is not money coming in. «ندادم / هنوز نداده‌ام» means nothing was paid.',
    '- In speech «X تومن» without «هزار» or «میلیون» is ambiguous (people often mean thousand, sometimes million Toman): pick the value that is plausible for a building site and add a guess for amount explaining it.',
    '- Wages: paid=false unless the speaker says they were paid. If the wage was not said, return null (do not guess a wage).',
    '- A cheque being cleared, bounced or cashed is not a new cheque: return kind «unknown» with a description; the owner changes its status on the cheques page.',
    '- Use only ids from the lists below. If the person, account or stage is not clearly one of them, return null and add a guess saying what was heard. Never invent an id.',
    '- When you infer a value that was not said plainly, add it to guesses with a short Persian reason. When unsure, prefer null.',
    '- If something does not fit any kind, return kind «unknown» with the words in description. Never return a payment that was not said.',
    '- highlights: the exact phrases from the text you used, copied character for character.',
    '- All labels, descriptions and reasons in Persian.',
    'People (id — name — role — other names):', list(ctx.people, (p) => `${p.id} — ${p.name}${p.role ? ` — ${p.role}` : ''}${p.aliases?.length ? ` — ${p.aliases.join('، ')}` : ''}`),
    'Accounts (id — name — ledger):', list(ctx.accounts, (a) => `${a.id} — ${a.name} — ${a.ledgerKind}`),
    'Stages (id — name):', list(ctx.stages, (s) => `${s.id} — ${s.name}${s.inProgress ? ' (in progress)' : ''}`),
  ].join('\n');
}

// Amounts above a thousand billion Toman are not a building site's; anything that is not a safe whole number is dropped.
const MAX_RIAL = 10_000_000_000_000; // 1,000 billion Toman
const toRial = (m: { value: number; unit: 'toman' | 'rial' } | null) => {
  if (!m || !Number.isFinite(m.value) || m.value <= 0) return undefined;
  const r = Math.round(m.value) * (m.unit === 'rial' ? 1 : 10);
  return r > 0 && r <= MAX_RIAL && Number.isSafeInteger(r) ? String(r) : undefined;
};
const inRange = (n: number | null, lo: number, hi: number) => (n !== null && Number.isInteger(n) && n >= lo && n <= hi ? n : undefined);

const DAY = 86_400_000;
const jalaliSlash = (iso: string) => { const j = isoToJalali(iso); return `${j.jy}/${String(j.jm).padStart(2, '0')}/${String(j.jd).padStart(2, '0')}`; };

/** A real calendar day (Jalali yyyy/mm/dd as the model is asked for, or ISO) → ISO; within `back`..`ahead` days of
 *  today, else undefined. */
export function isoDate(s: string | null, today: string, back = 2 * 366, ahead = 2 * 366): string | undefined {
  if (!s) return undefined;
  let iso: string | undefined;
  const j = s.trim().match(/^(1[34]\d\d)[/-](\d{1,2})[/-](\d{1,2})$/);
  if (j) {
    const [jy, jm, jd] = [Number(j[1]), Number(j[2]), Number(j[3])];
    if (jm >= 1 && jm <= 12 && jd >= 1 && jd <= monthLength(jy, jm)) iso = jalaliToIso({ jy, jm, jd });
  } else if (/^\d{4}-\d{2}-\d{2}$/.test(s)) {
    const d = new Date(`${s}T00:00:00Z`);
    if (!Number.isNaN(d.getTime()) && d.toISOString().slice(0, 10) === s) iso = s;
  }
  if (!iso) return undefined;
  const diff = (new Date(`${iso}T00:00:00Z`).getTime() - new Date(`${today}T00:00:00Z`).getTime()) / DAY;
  return diff >= -back && diff <= ahead ? iso : undefined;
}

export interface ExtractedItem { cards: DraftCard[]; chips: string[] }

// the field that holds the day of each kind of record
const kindDayField: Partial<Record<Extraction['cards'][number]['kind'], string>> = {
  payment: 'occurred_on', receipt: 'occurred_on', transfer: 'occurred_on', work_log: 'work_date', daily_note: 'note_date', unknown: 'note_date',
};

/** The model's answer → draft cards the review sheet understands. Unknown ids are dropped and flagged; a card without
 *  a stated day gets the day the message arrived, so a late confirmation never shifts it. */
export function toDrafts(out: Extraction, ctx: ExtractContext, idPrefix = 'd'): ExtractedItem {
  const ids = {
    person: new Set(ctx.people.map((p) => p.id)), account: new Set(ctx.accounts.map((a) => a.id)), stage: new Set(ctx.stages.map((s) => s.id)),
  };
  const cards: DraftCard[] = out.cards.map((c, i) => {
    // the model names its guesses after its own fields; the review sheet looks them up by the card's field names
    const dayField = kindDayField[c.kind];
    const cardField = (f: string) => ({ amount: 'amount_rial', wage_per_person: 'wage_rial', date: dayField ?? 'date', stage_status: 'status' } as Record<string, string>)[f] ?? f;
    const guess: Record<string, string> = Object.fromEntries(c.guesses.map((g) => [cardField(g.field), g.reason]));
    const pick = (v: string | null, set: Set<string>, field: string) => {
      if (!v) return undefined;
      if (set.has(v)) return v;
      guess[field] = 'نامی که گفته شد در فهرست نبود؛ انتخاب کنید';
      return undefined;
    };
    const f: Record<string, unknown> = {};
    const put = (k: string, v: unknown) => { if (v !== undefined && v !== null && v !== '') f[k] = v; };
    // something that happened: up to two years back, at most tomorrow; a day that cannot be is replaced by the day of the
    // message and flagged
    const said = isoDate(c.date, ctx.today, 2 * 366, 1);
    const day = said ?? ctx.today;
    if (c.date && !said && dayField) guess[dayField] = 'تاریخ گفته‌شده درست فهمیده نشد؛ روز پیام گذاشته شد. بررسی کنید.';
    const person = pick(c.person_id, ids.person, 'person_id');
    const account = pick(c.account_id, ids.account, 'account_id');
    const stage = pick(c.stage_id, ids.stage, 'stage_id');
    let kind: DraftKind = c.kind === 'unknown' ? 'daily_note' : c.kind;
    switch (kind) {
      case 'payment': case 'receipt':
        put('amount_rial', toRial(c.amount)); put('account_id', account); put('person_id', person); put('occurred_on', day);
        put('method', c.method); put('tracking_no', c.tracking_no); put('description', c.description);
        if (kind === 'payment') { put('stage_id', stage); if (c.settles) put('settles', true); }
        break;
      case 'transfer':
        put('amount_rial', toRial(c.amount)); put('from_account_id', pick(c.from_account_id, ids.account, 'from_account_id'));
        put('to_account_id', pick(c.to_account_id, ids.account, 'to_account_id')); put('occurred_on', day); put('description', c.description);
        break;
      case 'work_log':
        put('headcount', inRange(c.headcount, 1, 500)); put('wage_rial', toRial(c.wage_per_person) ?? '0');
        if (!toRial(c.wage_per_person)) guess.wage_rial = 'دستمزد را نگفتید؛ وارد کنید.'; put('paid', c.paid === true);
        put('stage_id', stage); put('work_date', day); put('description', c.description);
        if (c.paid) put('account_id', account); else put('crew_person_id', person);
        break;
      case 'stage_progress':
        put('stage_id', stage); put('progress_pct', inRange(c.progress_pct, 0, 100)); put('status', c.stage_status ?? undefined);
        break;
      case 'cheque':
        put('direction', c.direction ?? undefined); put('amount_rial', toRial(c.amount)); put('person_id', person); put('due_date', isoDate(c.due_date, ctx.today));
        if (c.due_date && !isoDate(c.due_date, ctx.today)) guess.due_date = 'سررسید درست فهمیده نشد؛ وارد کنید.';
        put('account_id', account); put('bank', c.bank); put('sayad_no', c.sayad_no && /^\d{16}$/.test(c.sayad_no) ? c.sayad_no : undefined);
        put('stage_id', stage); if (c.settles) put('settles', true); put('description', c.description);
        break;
      case 'document':
        put('title', c.title ?? c.description); put('category_code', c.category_code ?? undefined); put('stage_id', stage);
        break;
      default:
        kind = 'daily_note';
    }
    if (kind === 'daily_note') {
      put('body', c.body ?? c.description); put('stage_id', stage); put('note_date', day);
      if (c.kind === 'unknown') guess.body = 'متوجه نشدم این چه ثبتی است؛ فعلاً یادداشت می‌شود. اگر پرداخت یا دریافت است، اصلاحش کنید.';
    }
    return { id: `${idPrefix}-${i + 1}`, kind, fields: f, guess, status: 'pending' as const };
  });
  return { cards, chips: out.chips.slice(0, cards.length) };
}
