// Sample books shown until the real server is connected (labelled «دادهٔ نمونه» in the app).
// Numbers agree with each other: month totals, stage totals, balances and debts all come from the same rows.
import type { Account, Book, DailyNote, DocumentRec, Ledger, Obligation, Person, Stage, Transaction } from '@/lib/book';
import { parseMarked } from '@/lib/transcript';
import { formatJalali } from '@/lib/jalali';

const M = 10_000_000n; // one million Toman, in Rial
const m = (millions: number) => (BigInt(Math.round(millions * 100)) * M) / 100n;

const L = { project: 'led-bahar', company: 'led-company', personal: 'led-personal' };

const ledgers: Ledger[] = [
  { id: L.project, kind: 'project', name: 'ساختمان بهار' },
  { id: L.company, kind: 'company', name: 'دفتر شرکت' },
  { id: L.personal, kind: 'personal', name: 'دفتر شخصی' },
];

const P = {
  nouri: 'p-nouri', moradi: 'p-moradi', rezaei: 'p-rezaei', crew: 'p-crew', pars: 'p-pars', ahmadi: 'p-ahmadi',
  tavakoli: 'p-tavakoli', omid: 'p-omid', salehi: 'p-salehi', sahel: 'p-sahel', novin: 'p-novin', karimi: 'p-karimi',
  municipality: 'p-municipality', power: 'p-power',
};
const people: Person[] = [
  { id: P.nouri, kind: 'contractor', fullName: 'استاد کاظم نوری', roleTitle: 'پیمانکار اسکلت', initials: 'ک‌ن' },
  { id: P.moradi, kind: 'contractor', fullName: 'استاد علی مرادی', roleTitle: 'قالب‌بند', initials: 'ع‌م' },
  { id: P.rezaei, kind: 'contractor', fullName: 'حسین رضایی', roleTitle: 'آرماتوربند', initials: 'ح‌ر' },
  { id: P.crew, kind: 'crew', fullName: 'کارگران روزمزد', roleTitle: 'با سرکارگر، رحیم', initials: 'ک‌ر' },
  { id: P.pars, kind: 'supplier', fullName: 'بتن آمادهٔ پارس', roleTitle: 'فروشنده', initials: 'ب‌پ' },
  { id: P.ahmadi, kind: 'supervisor', fullName: 'مهندس سارا احمدی', roleTitle: 'ناظر سازه', initials: 'س‌ا' },
  { id: P.tavakoli, kind: 'supervisor', fullName: 'مهندس رضا توکلی', roleTitle: 'ناظر معماری', initials: 'ر‌ت' },
  { id: P.omid, kind: 'supplier', fullName: 'مصالح‌فروشی امید', roleTitle: 'فروشنده', initials: 'م‌ا' },
  { id: P.salehi, kind: 'supplier', fullName: 'آهن‌آلات صالحی', roleTitle: 'فروشنده', initials: 'آ‌ص' },
  { id: P.sahel, kind: 'supplier', fullName: 'جرثقیل‌رانی ساحل', roleTitle: 'خدمات', initials: 'ج‌س' },
  { id: P.novin, kind: 'supplier', fullName: 'قالب‌بندی نوین', roleTitle: 'اجارهٔ قالب', initials: 'ق‌ن' },
  { id: P.karimi, kind: 'partner', fullName: 'مهدی کریمی', roleTitle: 'صاحب‌کار', initials: 'م‌ک' },
  { id: P.municipality, kind: 'office', fullName: 'شهرداری منطقهٔ ۲', roleTitle: 'اداره', initials: 'ش' },
  { id: P.power, kind: 'office', fullName: 'توزیع برق', roleTitle: 'اداره', initials: 'ب' },
];

// The 25 stages from the database template (stage_templates), with sample budgets in million Toman.
const STAGE_ROWS: [string, Stage['phase'], string, number][] = [
  ['property', 'pre', 'مدارک ملک', 0], ['municipality_file', 'pre', 'تشکیل پرونده در شهرداری', 60], ['design', 'pre', 'طراحی', 90],
  ['drawing_approval', 'pre', 'کنترل و تأیید نقشه‌ها', 0], ['supervisors', 'pre', 'ناظران و مجری', 50], ['fees_insurance', 'pre', 'عوارض، بیمه و تعهدات', 170],
  ['permit', 'pre', 'پروانهٔ ساخت', 30], ['start', 'pre', 'شروع عملیات', 0], ['site_setup', 'build', 'تجهیز کارگاه', 0],
  ['demolition', 'build', 'تخریب', 70], ['excavation', 'build', 'گودبرداری و پایدارسازی', 130], ['foundation', 'build', 'فونداسیون', 650],
  ['frame', 'build', 'اسکلت', 1500], ['rough_work', 'build', 'سفت‌کاری', 700], ['mechanical', 'build', 'تأسیسات مکانیکی', 400],
  ['electrical', 'build', 'تأسیسات برقی', 250], ['elevator', 'build', 'آسانسور', 0], ['finishing', 'build', 'نازک‌کاری', 1100],
  ['facade', 'build', 'نما', 450], ['common_areas', 'build', 'محوطه و مشاعات', 0], ['utilities_permanent', 'finish', 'انشعابات دائم', 0],
  ['certificates', 'finish', 'گواهی‌ها', 0], ['supervisors_completion', 'finish', 'پایان‌کار ناظران', 0],
  ['municipality_completion', 'finish', 'پایان‌کار شهرداری', 150], ['subdivision_deed', 'finish', 'تفکیک و سند', 0],
];
const DONE_UP_TO = 12; // stages 1–12 done, 13 (frame) in progress
const stages: Stage[] = STAGE_ROWS.map(([code, phase, name, budget], i) => ({
  id: `st-${code}`, ledgerId: L.project, ord: i + 1, phase, name,
  status: i + 1 <= DONE_UP_TO ? 'done' : i + 1 === 13 ? 'in_progress' : 'todo',
  progressPct: i + 1 <= DONE_UP_TO ? 100 : i + 1 === 13 ? 65 : 0,
  budgetRial: m(budget),
}));
const S = (code: string) => `st-${code}`;

const A = { bank: 'acc-mellat', cash: 'acc-cash', personal: 'acc-pasargad' };

let n = 0;
const tx = (on: string, accountId: string, millions: number, t: Partial<Transaction> & { description: string }): Transaction => ({
  id: `tx-${++n}`, ledgerId: L.project, accountId, occurredOn: on, amountRial: m(millions), isCost: false, source: 'manual',
  voided: false, history: [`${formatJalali(on, { withYear: false })} · ثبت شد`], ...t,
});

// Earlier months: one main purchase or payment per stage per month, so the chart and stage totals agree.
const history: [string, string | undefined, number, string][] = [
  ['2026-05-06', S('municipality_file'), 60, 'تشکیل پرونده و دستور نقشه'], ['2026-05-12', S('design'), 90, 'حق‌الزحمهٔ طراحی نقشه‌ها'], ['2026-05-18', S('supervisors'), 30, 'قرارداد ناظران، قسط اول'],
  ['2026-06-04', S('supervisors'), 20, 'قرارداد ناظران، قسط دوم'], ['2026-06-08', S('fees_insurance'), 115, 'عوارض پروانه و بیمهٔ کارگران'], ['2026-06-12', S('permit'), 30, 'هزینهٔ صدور پروانه'], ['2026-06-16', S('demolition'), 80, 'تخریب و حمل نخاله'], ['2026-06-20', undefined, 15, 'نگهبان و آب و برق کارگاه، خرداد'],
  ['2026-07-05', S('excavation'), 130, 'گودبرداری و نیلینگ'], ['2026-07-14', S('foundation'), 180, 'میلگرد و قالب فونداسیون'], ['2026-07-20', undefined, 30, 'نگهبان و آب و برق کارگاه، تیر'],
  ['2026-08-06', S('foundation'), 260, 'بتن‌ریزی فونداسیون'], ['2026-08-18', undefined, 30, 'نگهبان و آب و برق کارگاه، مرداد'],
  ['2026-09-04', S('foundation'), 180, 'عایق و پی‌کنی آخر فونداسیون'], ['2026-09-12', S('frame'), 200, 'میلگرد ستون‌ها و سقف اول'], ['2026-09-18', undefined, 40, 'نگهبان و آب و برق کارگاه، شهریور'],
  ['2026-10-05', S('frame'), 438.2, 'بتن و قالب‌بندی سقف اول و دوم'], ['2026-10-12', undefined, 63.8, 'نگهبان، آب و برق و ایاب‌وذهاب، مهر'],
];
const deposits: [string, number][] = [
  ['2026-04-25', 400], ['2026-05-25', 150], ['2026-06-25', 380], ['2026-07-25', 300], ['2026-08-25', 450], ['2026-09-25', 520],
];

const transactions: Transaction[] = [
  // Aban 1405 (the current month), newest first
  tx('2026-11-09', A.bank, -24.8, { description: 'بتن آماده، ۸ متر مکعب', personId: P.pars, stageId: S('frame'), isCost: true, source: 'receipt' }),
  tx('2026-11-09', A.cash, -7.2, { description: 'دستمزد ۶ کارگر', personId: P.crew, stageId: S('frame'), isCost: true, source: 'voice',
    history: ['۱۸ آبان · ساخته‌شده از ویس (ربات بله)', '۱۸ آبان · تأیید شد', '۱۸ آبان · ویرایش: دستمزد هر نفر'] }),
  tx('2026-11-08', A.bank, 200, { description: 'آوردهٔ صاحب‌کار', personId: P.karimi }),
  tx('2026-11-07', A.bank, -35, { description: 'عوارض شهرداری، قسط سوم', personId: P.municipality, stageId: S('fees_insurance'), isCost: true, source: 'receipt' }),
  tx('2026-11-06', A.bank, -198, { description: 'میلگرد ۱۶ آجدار، ۶ تن', personId: P.salehi, stageId: S('frame'), isCost: true, source: 'invoice' }),
  tx('2026-11-05', A.bank, -15, { description: 'حق‌الزحمهٔ نظارت', personId: P.ahmadi, isCost: true, source: 'voice' }),
  tx('2026-11-04', A.cash, -4.5, { description: 'کرایهٔ جرثقیل', personId: P.sahel, stageId: S('frame'), isCost: true, source: 'voice' }),
  tx('2026-11-03', A.cash, -0.85, { description: 'ناهار کارگرها', isCost: true, source: 'voice' }),
  tx('2026-11-02', A.bank, -30, { description: 'شارژ تنخواه', transferId: 'tr-1' }),
  tx('2026-11-02', A.cash, 30, { description: 'شارژ تنخواه', transferId: 'tr-1' }),
  tx('2026-11-01', A.bank, -6.3, { description: 'سیمان تیپ ۲، ۴۲ کیسه', personId: P.omid, stageId: S('frame'), isCost: true, source: 'invoice' }),
  tx('2026-10-31', A.bank, -9, { description: 'اجارهٔ قالب فلزی', personId: P.novin, stageId: S('frame'), isCost: true, source: 'receipt' }),
  tx('2026-10-30', A.personal, -1.24, { description: 'قبض برق کارگاه', personId: P.power, isCost: true, source: 'receipt',
    history: ['۸ آبان · ساخته‌شده از عکس رسید (ربات بله)', '۸ آبان · از حساب شخصی پرداخت شد؛ پروژه به شما بدهکار شد'] }),
  // a prepayment in Mehr (not a cost: no debt existed yet)
  tx('2026-10-14', A.bank, -6, { description: 'پیش‌پرداخت بتن', personId: P.pars }),
  ...history.map(([on, stageId, mil, description]) => tx(on, A.bank, -mil, { description, stageId, isCost: true })),
  ...deposits.map(([on, mil]) => tx(on, A.bank, mil, { description: 'آوردهٔ صاحب‌کار', personId: P.karimi })),
];

const obligations: Obligation[] = [
  { id: 'ob-1', ledgerId: L.project, personId: P.nouri, stageId: S('frame'), occurredOn: '2026-10-20', amountRial: m(42.5), kind: 'contract', description: 'صورت‌وضعیت اسکلت', voided: false },
  { id: 'ob-2', ledgerId: L.project, personId: P.moradi, stageId: S('frame'), occurredOn: '2026-10-20', amountRial: m(31.5), kind: 'contract', description: 'قالب‌بندی سقف اول', voided: false },
  { id: 'ob-3', ledgerId: L.project, personId: P.rezaei, stageId: S('frame'), occurredOn: '2026-10-20', amountRial: m(18), kind: 'work', description: 'آرماتوربندی سقف اول', voided: false },
];

// Opening balances so the accounts end where the sample says.
function opening(accountId: string, target: number): bigint {
  return m(target) - transactions.filter((t) => t.accountId === accountId).reduce((s, t) => s + t.amountRial, 0n);
}
const accounts: Account[] = [
  { id: A.bank, ledgerId: L.project, kind: 'bank', name: 'بانک ملت', detail: 'حساب پروژه', openingRial: opening(A.bank, 862.4) },
  { id: A.cash, ledgerId: L.project, kind: 'cash', name: 'تنخواه کارگاه', detail: 'نقدی، دست سرکارگر', openingRial: opening(A.cash, 21.6) },
  { id: A.personal, ledgerId: L.personal, kind: 'bank', name: 'پاسارگاد', detail: 'جدا از پروژه، در جمع نیست', openingRial: opening(A.personal, 356) },
];

const documents: DocumentRec[] = [
  { id: 'doc-1', ledgerId: L.project, category: 'municipality', title: 'پروانهٔ ساخت', status: 'approved', meta: 'منطقهٔ ۲ · ۲۸ فروردین', hidden: false },
  { id: 'doc-2', ledgerId: L.project, category: 'drawings', discipline: 'structural', title: 'نقشه‌های سازه، ۱۲ برگ', status: 'executive', meta: 'مهندس طراح · ۲ شهریور', hidden: false },
  { id: 'doc-3', ledgerId: L.project, category: 'drawings', discipline: 'water_sewage', title: 'نقشه‌های آب و فاضلاب', status: 'executive', meta: 'طراح تأسیسات · ۲ شهریور', hidden: false },
  { id: 'doc-4', ledgerId: L.project, category: 'contracts', title: 'قرارداد پیمانکار اسکلت', status: 'approved', meta: 'استاد کاظم نوری · ۲ شهریور', hidden: false },
  { id: 'doc-5', ledgerId: L.project, category: 'supervision', title: 'صورت‌جلسهٔ بتن‌ریزی فونداسیون', status: 'approved', meta: 'از ربات بله · ۱۲ مهر', hidden: false },
];

const dailyNotes: DailyNote[] = [
  { id: 'dn-1', ledgerId: L.project, noteDate: '2026-11-07', body: 'مهندس احمدی گفت کاور میلگرد ستون‌های محور B کافی نیست؛ پیش از بتن‌ریزی سقف دوم اصلاح شود.', stageId: S('frame'), voided: false },
  { id: 'dn-2', ledgerId: L.project, noteDate: '2026-10-24', body: 'مهندس توکلی تراز فونداسیون را تأیید کرد و گزارش مرحله را به نظام مهندسی فرستاد.', stageId: S('foundation'), voided: false },
];

export function sampleBook(): Book {
  return {
    workspaceName: 'شرکت ساختمانی کریمی',
    ownerName: 'مهدی کریمی',
    projectHint: '۴ طبقه، تهران',
    today: '2026-11-10',
    ledgers, accounts, people, stages, transactions, obligations,
    workLogs: [], documents, dailyNotes, inspections: [],
    interLedger: [{ id: 'il-1', debtorLedgerId: L.project, creditorLedgerId: L.personal, amountRial: m(1.24), transactionId: transactions.find((t) => t.accountId === A.personal)!.id, voided: false }],
    inbox: [
      {
        id: 'ib-1', ledgerId: L.project, kind: 'voice', channel: 'bale', title: 'ویس', receivedLabel: 'امروز ۱۰:۲۴', durationLabel: '۱:۱۲', status: 'ready',
        chips: ['کارکرد ۵ نفر', 'پرداخت ۱۲ میلیون', 'یادداشت روزانه', 'نامهٔ شهرداری'],
        transcript: parseMarked('امروز <mark>پنج تا کارگر</mark> داشتیم؛ سه نفر <mark>قالب‌بندی سقف طبقهٔ دوم</mark>، دو نفر آرماتوربندی. <mark>دوازده میلیون</mark> هم به <mark>آقای رضایی</mark> کارت به کارت کردم. <mark>مهندس احمدی</mark> اومد، گفت <mark>آرماتورهای سقف اوکیه</mark>، فقط قبل بتن‌ریزی صورت‌جلسه رو امضا کنیم. <mark>نامهٔ تمدید پروانه</mark> رو هم از <mark>شهرداری</mark> گرفتم.'),
        drafts: [
          { id: 'd-1', kind: 'work_log', status: 'pending',
            fields: { headcount: 5, wage_rial: m(1.2).toString(), stage_id: S('frame'), crew_person_id: P.crew, work_date: '2026-11-10', paid: false, description: '۳ نفر قالب‌بندی سقف، ۲ نفر آرماتوربندی' },
            guess: { wage_rial: 'در ویس نگفتید؛ از نرخ هفتهٔ قبل', paid: 'در ویس نگفتید پرداخت شده یا نه' } },
          { id: 'd-2', kind: 'payment', status: 'pending',
            fields: { amount_rial: m(12).toString(), account_id: A.bank, person_id: P.rezaei, settles: true, method: 'کارت به کارت', occurred_on: '2026-11-10' },
            guess: { person_id: 'در ویس فقط «آقای رضایی» آمد؛ از فهرست اشخاص پیدا شد', account_id: 'روش را گفتید، حساب را نه؛ حساب همیشگی کارت به کارت شما', settles: 'رضایی از قبل ۱۸ میلیون طلب داشت؛ برای همین تسویهٔ بدهی فرض شد' } },
          { id: 'd-3', kind: 'daily_note', status: 'pending',
            fields: { body: 'مهندس احمدی: آرماتورهای سقف طبقهٔ دوم تأیید شد؛ پیش از بتن‌ریزی صورت‌جلسه امضا شود.', stage_id: S('frame'), note_date: '2026-11-10' },
            guess: {} },
          { id: 'd-4', kind: 'document', status: 'pending',
            fields: { title: 'نامهٔ تمدید پروانهٔ ساخت', category_code: 'municipality' },
            guess: {} },
        ],
      },
      {
        id: 'ib-2', ledgerId: L.project, kind: 'receipt', channel: 'bale', title: 'عکس رسید', receivedLabel: 'دیروز ۱۸:۰۲', status: 'ready',
        chips: ['پرداخت ۸٫۵ میلیون', 'مصالح‌فروشی امید'],
        ocr: 'رسید کارت به کارت · مبلغ ۸۵٬۰۰۰٬۰۰۰ ریال · مقصد: مصالح‌فروشی امید · پیگیری ۴۸۲۱۹۰',
        drafts: [
          { id: 'd-5', kind: 'payment', status: 'pending',
            fields: { amount_rial: m(8.5).toString(), account_id: A.bank, person_id: P.omid, stage_id: S('frame'), method: 'کارت به کارت', occurred_on: '2026-11-09' },
            guess: { stage_id: 'از روی خریدهای قبلی همین فروشنده حدس زده شد' } },
        ],
      },
      {
        id: 'ib-3', ledgerId: L.project, kind: 'voice', channel: 'bale', title: 'ویس سرکارگر', receivedLabel: 'دیروز ۱۴:۴۰', durationLabel: '۰:۱۸', status: 'ready',
        chips: ['خرید نقدی ۲ میلیون', 'پیشرفت اسکلت ۷۵٪'],
        transcript: parseMarked('<mark>دو میلیون</mark> از <mark>تنخواه</mark> دادم برای <mark>ناهار و آب</mark> کارگرها. <mark>قالب‌بندی سقف دوم</mark> هم <mark>تموم شد</mark>.'),
        drafts: [
          { id: 'd-6', kind: 'payment', status: 'pending',
            fields: { amount_rial: m(2).toString(), account_id: A.cash, description: 'ناهار و آب کارگرها', occurred_on: '2026-11-09' },
            guess: { amount_rial: '«دو میلیون» گفته شد؛ اگر منظور دو میلیون تومان نیست اصلاح کنید' } },
          { id: 'd-7', kind: 'stage_progress', status: 'pending',
            fields: { stage_id: S('frame'), progress_pct: 75, status: 'in_progress' },
            guess: { progress_pct: 'از «قالب‌بندی سقف دوم تموم شد» حدس زده شد؛ درصد دقیق را بنویسید' } },
        ],
      },
    ],
  };
}

export const SAMPLE_IDS = { L, P, A, S };
