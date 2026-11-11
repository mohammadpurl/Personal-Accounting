// The cards the AI proposes from a voice note or photo: the fields each kind needs (same rules as the
// database's confirm_inbox) and the «اثر» line that tells the owner what confirming will change.
import { z } from 'zod';
import { formatJalali } from './jalali';
import { formatShortToman } from './money';

export const DOC_CATEGORIES = {
  property: 'مدارک ملکی و حقوقی',
  municipality: 'شهرداری',
  drawings: 'نقشه‌ها',
  supervision: 'نظام مهندسی و نظارت',
  tests: 'آزمایش‌ها و کنترل کیفیت',
  utilities: 'انشعابات',
  insurance: 'بیمه',
  contracts: 'قراردادها و صورت‌وضعیت پیمانکاران',
  progress_photos: 'عکس‌های پیشرفت کار',
  completion: 'گواهی‌های پایان کار',
  loan_presale: 'وام و پیش‌فروش',
} as const;
export type DocCategory = keyof typeof DOC_CATEGORIES;

// Ids are checked as real UUIDs by the database; here we only need "something was chosen".
// Every message says what to do and names the field, so the owner knows where to look.
const pick = (what: string) => z.string({ error: `${what} را انتخاب کنید` }).trim().min(1, { error: `${what} را انتخاب کنید` });
const uuid = pick('یک گزینه');
const isoDate = z.iso.date({ error: 'تاریخ را از تقویم انتخاب کنید' });
const rial = z
  .string({ error: 'مبلغ را بنویسید' })
  .regex(/^\d+$/, { error: 'مبلغ را بنویسید' })
  .refine((s) => BigInt(s) > 0n, { error: 'مبلغ باید بیشتر از صفر باشد' });
const rialOrZero = z.string({ error: 'دستمزد را بنویسید' }).regex(/^\d+$/, { error: 'دستمزد را بنویسید' });
const text = (what: string) => z.string({ error: `${what} را بنویسید` }).trim().min(1, { error: `${what} را بنویسید` });

export const draftFields = {
  payment: z.object({
    amount_rial: rial,
    account_id: pick('حساب'),
    person_id: uuid.optional(),
    stage_id: uuid.optional(),
    occurred_on: isoDate.optional(),
    method: z.string().optional(),
    tracking_no: z.string().optional(),
    description: z.string().optional(),
    settles: z.boolean().optional(), // paying a debt already owed: not a new cost
  }).refine((f) => !f.settles || !!f.person_id, { error: 'بدهی به چه کسی تسویه شد؟', path: ['person_id'] }),
  receipt: z.object({
    amount_rial: rial,
    account_id: pick('حساب'),
    person_id: uuid.optional(),
    occurred_on: isoDate.optional(),
    method: z.string().optional(),
    tracking_no: z.string().optional(),
    description: z.string().optional(),
  }),
  transfer: z
    .object({
      amount_rial: rial,
      from_account_id: pick('حساب مبدأ'),
      to_account_id: pick('حساب مقصد'),
      occurred_on: isoDate.optional(),
      description: z.string().optional(),
    })
    .refine((f) => f.from_account_id !== f.to_account_id, { error: 'مبدأ و مقصد یکی است', path: ['to_account_id'] }),
  work_log: z
    .object({
      headcount: z.number({ error: 'تعداد را بنویسید' }).int().positive({ error: 'تعداد را بنویسید' }).max(500, { error: 'تعداد بیش از ۵۰۰ نفر است؛ دوباره نگاه کنید' }),
      wage_rial: rialOrZero,
      stage_id: uuid.optional(),
      crew_person_id: uuid.optional(),
      work_date: isoDate.optional(),
      description: z.string().optional(),
      paid: z.boolean(),
      account_id: uuid.optional(),
    })
    .superRefine((f, ctx) => {
      const owesMoney = BigInt(f.wage_rial) > 0n;
      if (owesMoney && f.paid && !f.account_id) ctx.addIssue({ code: 'custom', path: ['account_id'], message: 'از کدام حساب پرداخت شد؟' });
      if (owesMoney && !f.paid && !f.crew_person_id) ctx.addIssue({ code: 'custom', path: ['crew_person_id'], message: 'طلب به چه کسی است؟' });
    }),
  stage_progress: z.object({
    stage_id: pick('مرحله'),
    progress_pct: z.number({ error: 'درصد را بنویسید' }).int().min(0, { error: 'درصد بین ۰ تا ۱۰۰ است' }).max(100, { error: 'درصد بین ۰ تا ۱۰۰ است' }).optional(),
    status: z.enum(['todo', 'in_progress', 'done', 'skipped']).optional(),
  }).refine((f) => f.progress_pct !== undefined || f.status !== undefined, { error: 'درصد پیشرفت را بنویسید', path: ['progress_pct'] }),
  daily_note: z.object({ body: text('متن یادداشت'), note_date: isoDate.optional(), stage_id: uuid.optional() }),
  document: z.object({
    title: text('عنوان سند'),
    category_code: z.enum(Object.keys(DOC_CATEGORIES) as [DocCategory, ...DocCategory[]], { error: 'دستهٔ سند را انتخاب کنید' }),
    discipline_code: z.string().optional(),
    status: z.enum(['draft', 'approved', 'executive', 'as_built']).optional(),
    is_financial: z.boolean().optional(),
    stage_id: uuid.optional(),
    issued_by_person_id: uuid.optional(),
    issued_on: isoDate.optional(),
    valid_until: isoDate.optional(),
    media_ids: z.array(uuid).optional(),
  }),
} as const;

export type DraftKind = keyof typeof draftFields;
export type DraftFieldsOf<K extends DraftKind> = z.infer<(typeof draftFields)[K]>;

export type Validation<K extends DraftKind> =
  | { ok: true; fields: DraftFieldsOf<K> }
  | { ok: false; errors: Record<string, string> };

export function validateDraft<K extends DraftKind>(kind: K, fields: unknown): Validation<K> {
  const r = draftFields[kind].safeParse(fields);
  if (r.success) return { ok: true, fields: r.data as DraftFieldsOf<K> };
  const errors: Record<string, string> = {};
  for (const issue of r.error.issues) {
    const key = issue.path.join('.') || '_';
    errors[key] ??= issue.message;
  }
  return { ok: false, errors };
}

// ---------- the «اثر» line ----------

export interface EffectContext {
  accounts: Record<string, { name: string; ledgerKind: 'project' | 'company' | 'personal' }>;
  people: Record<string, { name: string; owedRial: bigint }>; // what we owe them now (> 0) or prepaid (< 0)
  stages: Record<string, { name: string }>;
  today: string; // ISO date in Tehran
}

const accountPhrase = (ctx: EffectContext, id: string) => ctx.accounts[id]?.name ?? 'حساب انتخاب‌شده';
const stagePhrase = (ctx: EffectContext, id?: string) => (id && ctx.stages[id] ? `مرحلهٔ «${ctx.stages[id].name}»` : 'هزینه‌های عمومی پروژه');

/** One plain sentence (or two) saying exactly what confirming this card changes. */
export function describeEffect<K extends DraftKind>(kind: K, f: DraftFieldsOf<K>, ctx: EffectContext): string {
  switch (kind) {
    case 'payment': {
      const p = f as DraftFieldsOf<'payment'>;
      const amt = BigInt(p.amount_rial);
      const acc = ctx.accounts[p.account_id];
      const parts: string[] = [];
      if (acc?.ledgerKind === 'personal') parts.push(`از حساب شخصی شما می‌رود و پروژه ${formatShortToman(amt)} تومان به شما بدهکار می‌شود.`);
      else parts.push(`موجودی ${accountPhrase(ctx, p.account_id)} ${formatShortToman(amt)} تومان کم می‌شود.`);
      const person = p.person_id ? ctx.people[p.person_id] : undefined;
      if (p.settles && person) {
        const left = person.owedRial - amt;
        parts.push(left >= 0n
          ? `طلب ${person.name} از ${formatShortToman(person.owedRial)} به ${formatShortToman(left)} تومان می‌رسد.`
          : `بیشتر از طلب ${person.name} است؛ ${formatShortToman(-left)} تومان پیش‌پرداخت ثبت می‌شود.`);
      } else if (!p.settles) {
        parts.push(`به خرج ${stagePhrase(ctx, p.stage_id)} اضافه می‌شود.`);
      }
      return parts.join(' ');
    }
    case 'receipt': {
      const r = f as DraftFieldsOf<'receipt'>;
      return `موجودی ${accountPhrase(ctx, r.account_id)} ${formatShortToman(BigInt(r.amount_rial))} تومان بیشتر می‌شود.`;
    }
    case 'transfer': {
      const t = f as DraftFieldsOf<'transfer'>;
      return `${formatShortToman(BigInt(t.amount_rial))} تومان از ${accountPhrase(ctx, t.from_account_id)} به ${accountPhrase(ctx, t.to_account_id)} می‌رود. خرج حساب نمی‌شود.`;
    }
    case 'work_log': {
      const w = f as DraftFieldsOf<'work_log'>;
      const total = BigInt(w.wage_rial) * BigInt(w.headcount);
      const when = formatJalali(w.work_date ?? ctx.today, { withYear: false });
      const who = w.crew_person_id ? ctx.people[w.crew_person_id]?.name ?? 'کارگرها' : 'کارگرها';
      const money = total === 0n ? ''
        : w.paid ? `${formatShortToman(total)} تومان به خرج ${stagePhrase(ctx, w.stage_id)} اضافه و از ${accountPhrase(ctx, w.account_id ?? '')} کم می‌شود. `
        : `${formatShortToman(total)} تومان به خرج ${stagePhrase(ctx, w.stage_id)} اضافه می‌شود و ${who} همین مبلغ را طلب می‌کنند. `;
      return `${money}${w.headcount.toLocaleString('fa-IR')} نفر در کارکرد ${when} ثبت می‌شوند.`;
    }
    case 'stage_progress': {
      const s = f as DraftFieldsOf<'stage_progress'>;
      const name = stagePhrase(ctx, s.stage_id);
      if (s.status === 'done') return `${name} انجام‌شده علامت می‌خورد.`;
      if (s.progress_pct !== undefined) return `پیشرفت ${name} ${s.progress_pct.toLocaleString('fa-IR')}٪ ثبت می‌شود.`;
      return `وضعیت ${name} به‌روز می‌شود.`;
    }
    case 'daily_note': {
      const n = f as DraftFieldsOf<'daily_note'>;
      return `در دفتر روزانهٔ ${formatJalali(n.note_date ?? ctx.today, { withYear: false })} ثبت می‌شود.`;
    }
    case 'document': {
      const d = f as DraftFieldsOf<'document'>;
      const where = `در «اسناد و نقشه‌ها»، دستهٔ «${DOC_CATEGORIES[d.category_code]}»`;
      return d.media_ids?.length ? `${where} ثبت می‌شود.` : `${where} با برچسب «منتظر فایل» ثبت می‌شود.`;
    }
    default:
      return '';
  }
}
