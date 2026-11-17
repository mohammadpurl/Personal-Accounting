// Demo only: until the AI relay is connected, the assistant understands typed Persian with a few simple rules,
// enough to show how one sentence becomes a card on the right page. The real system uses the AI with the
// templates in ./templates. Everything it fills in is marked «مطمئن نیستم» so the owner checks it.
import type { Book, DraftCard } from './book';
import type { DraftKind } from './drafts';
import { addDays, jalaliToIso, isoToJalali, JALALI_MONTHS } from './jalali';
import { normFa } from './text';

const UNITS: Record<string, number> = {
  یک: 1, دو: 2, سه: 3, چهار: 4, پنج: 5, شش: 6, شیش: 6, هفت: 7, هشت: 8, نه: 9, ده: 10, یازده: 11, دوازده: 12, سیزده: 13,
  چهارده: 14, پانزده: 15, پونزده: 15, شانزده: 16, شونزده: 16, هفده: 17, هیفده: 17, هجده: 18, هیجده: 18, نوزده: 19,
  بیست: 20, سی: 30, چهل: 40, پنجاه: 50, شصت: 60, هفتاد: 70, هشتاد: 80, نود: 90,
  صد: 100, یکصد: 100, دویست: 200, سیصد: 300, چهارصد: 400, پانصد: 500, ششصد: 600, هفتصد: 700, هشتصد: 800, نهصد: 900,
};
const SCALE: Record<string, number> = { هزار: 1e3, هزاری: 1e3, میلیون: 1e6, ملیون: 1e6, میلیونی: 1e6, میلیارد: 1e9, میلیاردی: 1e9 };

/** Persian number words and digits → numbers, in reading order: «دوازده میلیون و پانصد هزار» → [12500000]. */
// punctuation is kept as «|» so a comma ends a number: «واحد دو، صد و پنجاه میلیون» is 2 and 150 000 000
// thousands separators between digits go («۱۲٬۰۰۰٬۰۰۰», «12,000,000»); a dot between digits stays a decimal point
const tokens = (text: string) => normFa(text).replace(/٫/g, '.').replace(/(\d)[/٬](\d{1,2})(?!\d)/g, '$1.$2').replace(/(\d)[,٬](?=\d{3})/g, '$1')
  .replace(/[،,؛:!؟?«»"()]|\.(?!\d)|(?<!\d)\./g, ' | ').split(/\s+/).filter(Boolean);

export function readNumbers(text: string): { value: number; at: number; scaled: boolean }[] {
  const words = tokens(text);
  const out: { value: number; at: number; scaled: boolean }[] = [];
  let total = 0, chunk = 0, inNum = false, start = 0, scaled = false, lastScale = 0;
  const flush = () => {
    // spoken shorthand: «یک میلیون و دویست» means 1 200 000 (the «هزار» is left out)
    if (lastScale >= 1e6 && chunk > 0 && chunk < 1000) chunk *= lastScale / 1000;
    if (inNum) out.push({ value: total + chunk, at: start, scaled });
    total = 0; chunk = 0; inNum = false; scaled = false; lastScale = 0;
  };
  let lastType: 'digit' | 'word' | null = null, afterAnd = false;
  words.forEach((w, i) => {
    const d = /^\d+(\.\d+)?$/.test(w) ? Number(w) : undefined;
    const type = d !== undefined ? 'digit' : w in UNITS ? 'word' : null;
    // «واحد ۴ سیصد میلیون»: a digit next to a number word (with no «و») starts a new number
    if (type && inNum && lastType && type !== lastType && !afterAnd && chunk > 0) flush();
    if (type) { lastType = type; afterAnd = false; }
    if (d !== undefined) { if (!inNum) { inNum = true; start = i; } chunk += d; return; }
    if (w in UNITS) { if (!inNum) { inNum = true; start = i; } chunk += UNITS[w]; return; }
    if (w in SCALE && inNum) { total += (chunk || 1) * SCALE[w]; chunk = 0; scaled = true; lastScale = SCALE[w]; return; }
    if (w === 'و' && inNum) { afterAnd = true; return; }
    if (w === 'نیم' && inNum) { chunk += 0.5; return; }
    flush(); lastType = null;
  });
  flush();
  return out;
}

const has = (t: string, re: RegExp) => re.test(t);
const CHEQUE_STATUS_SAID = /پاس شد|برگشت خورد|وصول شد|برگشتی شد/;

// patterns are written for normalised text: normFa turns half-spaces into spaces («صورت‌جلسه» → «صورت جلسه»)
const MONEY_WORD = /میلیون|هزار|تومان|ریال|\d{4,}/;
const PAID = /(?<!ن)دادم|پرداخت کردم|پرداخت شد|کارت به کارت کردم|ریختم برای|حساب کردم/;
const GOT = /واریز|آورده|زد به|به .{1,20} زد|پیش ?خرید|پیش ?فروش|خریدار|دریافت/;
const NOT_DONE = /ندادم|نداده|نگرفتم|نریختم|نزدم|نکردم/;

function guessKind(t: string): DraftKind {
  if (has(t, /یادداشت/)) return 'daily_note';
  if (has(t, /ناظر|بازدید|ایراد گرفت|صورت ?جلسه/) && !has(t, MONEY_WORD)) return 'daily_note';
  if (has(t, /چک/) && has(t, CHEQUE_STATUS_SAID)) return 'daily_note'; // a cheque's status is changed on its page, not by voice yet
  if (has(t, /چک/)) return 'cheque';
  if (has(t, /نقشه|سند|نامه|پروانه|قرارداد|مجوز/) && !has(t, MONEY_WORD)) return 'document';
  if (has(t, /کارگر|نفر(?:\s|ی|$)/)) return 'work_log'; // \b does not work between Persian letters
  if (has(t, /تموم|تمام شد|درصد|٪/)) return 'stage_progress';
  if (has(t, /ریختم به|منتقل|انتقال|شارژ/)) return 'transfer';
  // «طلب داره، هنوز ندادم»: nothing moved yet; kept as a note to look at, not a payment
  if (has(t, NOT_DONE) && !has(t, PAID)) return 'daily_note';
  if (has(t, GOT)) return 'receipt';
  // «سیمان از امید گرفتم، سه میلیون دادم» is a payment: «دادم» wins over «گرفتم»
  if (has(t, /گرفتم/) && !has(t, PAID)) return 'receipt';
  if (!has(t, MONEY_WORD) && !has(t, PAID)) return 'daily_note'; // not understood: kept as a note to check, never a guessed payment
  return 'payment';
}

function findDate(t: string, today: string): string | undefined {
  const nums = readNumbers(t);
  for (const [mi, name] of JALALI_MONTHS.entries()) {
    const at = tokens(t).indexOf(name);
    if (at < 0) continue;
    const day = nums.filter((n) => n.at < at && !n.scaled && n.value >= 1 && n.value <= 31).pop();
    if (!day) continue;
    const ty = isoToJalali(today);
    let jy = ty.jy;
    if (mi + 1 < ty.jm - 1) jy += 1; // a month well before now means next year
    return jalaliToIso({ jy, jm: mi + 1, jd: day.value });
  }
  return undefined;
}

/** One message, several jobs: split on sentence ends, and on «و» when a new amount with «هم» follows
 *  («پنج کارگر داشتیم و دوازده میلیون هم به رضایی دادم» → two parts). */
export function splitClauses(text: string): string[] {
  return text
    .split(/(?<!\d)\.(?!\d)|[؛\n]+|\s+و\s+(?=(?:\S+\s+){0,3}هم\s)/)
    .map((s) => s.trim())
    .filter((s) => s.length > 2);
}

export function parseDemo(text: string, book: Book, projectId: string, n = 0): { kind: DraftKind; card: DraftCard; chips: string[] } {
  const t = normFa(text);
  const kind = guessKind(t);
  const guess: Record<string, string> = {};
  const fields: Record<string, unknown> = {};
  const nums = readNumbers(text);
  const money = nums.filter((x) => x.scaled).sort((a, b) => b.value - a.value)[0] ?? nums.find((x) => x.value >= 10000);
  const unit = has(t, /ریال/) ? 1 : 10; // people say Toman unless they say «ریال»
  const people = book.people.filter((p) => p.kind !== 'partner');
  const person = people.find((p) => p.fullName.split(/\s+/).some((w) => w.length > 2 && !/^(آقای|خانم|استاد|مهندس)$/.test(w) && t.includes(normFa(w))));
  // «ملت» finds «بانک ملت»; «تنخواه» finds «تنخواه کارگاه»
  const accWords = (name: string) => normFa(name).split(/\s+/).filter((w) => w.length > 2 && !['بانک', 'حساب'].includes(w));
  const said = tokens(text);
  const accountsSaid = book.accounts.filter((a) => accWords(a.name).some((w) => said.includes(w)))
    .sort((a, b) => said.findIndex((w) => accWords(a.name).includes(w)) - said.findIndex((w) => accWords(b.name).includes(w)));
  const acc = accountsSaid[0] ?? (t.includes('نقد') ? book.accounts.find((a) => a.kind === 'cash') : undefined);
  const stage = book.stages.filter((s) => s.ledgerId === projectId).find((s) => t.includes(normFa(s.name)))
    ?? (t.includes('سقف') || t.includes('ستون') ? book.stages.find((s) => s.ledgerId === projectId && s.status === 'in_progress') : undefined);
  const rel = has(t, /پریروز/) ? addDays(book.today, -2) : has(t, /دیروز/) ? addDays(book.today, -1) : undefined;
  const relWhy = has(t, /پریروز/) ? 'از «پریروز» برداشت شد' : 'از «دیروز» برداشت شد';
  const why = 'از متن شما برداشت شد؛ بررسی کنید';
  if (money) fields.amount_rial = String(Math.round(money.value) * unit);
  if (person) { fields.person_id = person.id; guess.person_id = `«${person.fullName}» از متن پیدا شد`; }
  if (acc) fields.account_id = acc.id;
  if (stage) { fields.stage_id = stage.id; if (!t.includes(normFa(stage.name))) guess.stage_id = 'مرحلهٔ در جریان فرض شد'; }
  fields.description = text.trim().slice(0, 80);
  const drop = (...ks: string[]) => ks.forEach((k) => delete fields[k]);
  const dated = (k: string) => { if (rel) { fields[k] = rel; guess[k] = relWhy; } };

  switch (kind) {
    case 'cheque': {
      // «صادر کردم / دادم / کشیدم» is ours going out; «گرفتم / دریافت» is coming in; «از ملت» names an account, not a payer
      fields.direction = has(t, /صادر|دادم|کشیدم/) ? 'issued' : has(t, /گرفتم|دریافت/) ? 'received' : 'issued';
      const due = findDate(text, book.today);
      if (due) fields.due_date = due;
      if (has(t, /بابت طلب|بدهی|طلبش/)) fields.settles = true;
      guess.direction = why;
      break;
    }
    case 'work_log': {
      const head = nums.find((x) => !x.scaled && x.value > 0 && x.value < 200);
      if (head) fields.headcount = head.value;
      const wage = nums.find((x) => x.scaled && x.value >= 100000);
      fields.wage_rial = wage ? String(Math.round(wage.value) * unit) : '0';
      if (!wage) guess.wage_rial = 'دستمزد را نگفتید';
      // not said = not paid: an unpaid wage must never leave an account by accident
      fields.paid = has(t, /دادم|پرداخت شد|حساب کردم/) && !has(t, /ندادم|نداده|طلب|بعدا/);
      guess.paid = why;
      const crew = book.people.find((p) => p.kind === 'crew');
      if (!fields.paid && crew) { fields.crew_person_id = crew.id; guess.crew_person_id = `طلب به نام «${crew.fullName}» فرض شد`; }
      // the description is the part about the work, not the numbers: «سقف دوم»
      fields.description = text.split(/[،,]/).map((s) => s.trim())
        .filter((s) => s && readNumbers(s).length === 0 && !/امروز|دیروز|پریروز|دادم|ندادم|پرداخت|طلب/.test(normFa(s))).join('، ') || 'دستمزد کارگران';
      drop('amount_rial', 'person_id');
      dated('work_date');
      break;
    }
    case 'stage_progress': {
      const pct = nums.find((x) => !x.scaled && x.value <= 100);
      fields.progress_pct = has(t, /تموم|تمام شد/) && !pct ? 100 : pct?.value;
      if (has(t, /تموم|تمام شد/)) guess.progress_pct = 'از «تمام شد» برداشت شد؛ اگر کل مرحله تمام نشده، درصد را بنویسید';
      drop('amount_rial', 'person_id', 'account_id', 'description');
      break;
    }
    case 'daily_note':
      fields.body = text.replace(/^\s*یادداشت\s*(کن)?\s*[:：]?\s*/, '').trim();
      if (has(t, /چک/) && has(t, CHEQUE_STATUS_SAID)) guess.body = 'پاس شدن یا برگشت چک را در صفحهٔ «چک‌ها» روی همان چک بزنید؛ اینجا فقط یادداشت می‌شود';
      else if (!has(t, /یادداشت|ناظر|بازدید|صورت ?جلسه/)) guess.body = 'متوجه نشدم این چه ثبتی است؛ اگر پرداخت یا دریافت است، مبلغ و طرف را بگویید. فعلاً یادداشت می‌شود.';
      drop('amount_rial', 'person_id', 'account_id', 'description');
      dated('note_date');
      break;
    case 'document':
      fields.title = text.trim().slice(0, 80);
      fields.category_code = has(t, /شهرداری|پروانه/) ? 'municipality' : has(t, /نقشه/) ? 'drawings' : has(t, /قرارداد/) ? 'contracts' : undefined;
      if (fields.category_code) guess.category_code = why;
      drop('amount_rial', 'account_id', 'description', 'person_id');
      break;
    case 'transfer': {
      const accs = accountsSaid;
      if (accs[0]) fields.from_account_id = accs[0].id;
      if (accs[1]) fields.to_account_id = accs[1].id;
      drop('account_id', 'person_id');
      dated('occurred_on');
      break;
    }
    default:
      if (kind === 'payment' && has(t, /بابت طلب|بدهی|طلبش/)) fields.settles = true;
      dated('occurred_on');
  }
  if (money && fields.amount_rial) guess.amount_rial = `«${money.value.toLocaleString('fa-IR')} ${unit === 1 ? 'ریال' : 'تومان'}» برداشت شد`;
  const card: DraftCard = { id: `d-${Date.now().toString(36)}-${n}`, kind, fields, guess, status: 'pending' };
  return { kind, card, chips: [] };
}

/** Every job in one message, each as its own card. */
export function parseDemoMany(text: string, book: Book, projectId: string): DraftCard[] {
  const parts = splitClauses(text);
  return (parts.length ? parts : [text]).map((p, i) => parseDemo(p, book, projectId, i).card);
}

export const monthNames = JALALI_MONTHS;
