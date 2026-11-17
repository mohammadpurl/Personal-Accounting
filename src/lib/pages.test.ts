import { describe, expect, it } from 'vitest';
import { sampleBook, SAMPLE_IDS } from '@/data/sample';
import { accountBalance, confirmInbox, setChequeStatus, stageSpent, undoInbox } from './book';
import { parseDemo, parseDemoMany, readNumbers } from './demo-parse';
import { draftFields } from './drafts';
import { TEMPLATES } from './templates';

const M = 10_000_000n;
const { L, P, A, S } = SAMPLE_IDS;

describe('cheques (same rules as set_cheque_status)', () => {
  it('confirming a cheque card records it without moving money; clearing moves it; bouncing takes it back', () => {
    const b0 = sampleBook();
    const bank0 = accountBalance(b0, A.bank);
    const b1 = confirmInbox(b0, 'ib-4', ['d-8']);
    const c = b1.cheques.find((x) => x.draftId === 'd-8')!;
    expect(c.status).toBe('pending');
    expect(accountBalance(b1, A.bank)).toBe(bank0);
    const spent0 = stageSpent(b1, L.project, S('frame'));
    const b2 = setChequeStatus(b1, c.id, 'cleared');
    expect(accountBalance(b2, A.bank)).toBe(bank0 - 90n * M);
    expect(stageSpent(b2, L.project, S('frame'))).toBe(spent0 + 90n * M); // a new purchase: a cost of the stage
    expect(() => undoInbox(b2, 'ib-4')).toThrow(/در جریان نیست/);
    const b3 = setChequeStatus(b2, c.id, 'bounced');
    expect(accountBalance(b3, A.bank)).toBe(bank0);
    expect(b3.cheques.find((x) => x.id === c.id)!.history.at(-1)).toMatch(/برگشت خورد/);
  });
  it('a received cheque needs the account it was paid into', () => {
    const b = sampleBook();
    expect(() => setChequeStatus(b, 'chq-3', 'cleared')).toThrow(/حساب/);
    expect(accountBalance(setChequeStatus(b, 'chq-3', 'cleared', A.bank), A.bank)).toBe(accountBalance(b, A.bank) + 300n * M);
  });
});

describe('the demo assistant reads spoken Persian', () => {
  it('reads number words the way people say amounts', () => {
    expect(readNumbers('دوازده میلیون').map((n) => n.value)).toEqual([12_000_000]);
    expect(readNumbers('نفری یک میلیون و دویست').map((n) => n.value)).toEqual([1_200_000]);
    expect(readNumbers('صد و بیست میلیون').map((n) => n.value)).toEqual([120_000_000]);
    expect(readNumbers('۵ کارگر').map((n) => n.value)).toEqual([5]);
  });
  it('turns a sentence into a card for the right page, and asks for what is missing', () => {
    const b = sampleBook();
    const w = parseDemo('امروز پنج کارگر داشتیم، سقف دوم، نفری یک میلیون و دویست، هنوز ندادم', b, L.project);
    expect(w.kind).toBe('work_log');
    expect(w.card.fields).toMatchObject({ headcount: 5, wage_rial: '12000000', paid: false, crew_person_id: P.crew, stage_id: S('frame') });
    const c = parseDemo('یک چک صادر کردم به آهن‌آلات صالحی، صد و بیست میلیون، سررسید سی آبان، از حساب ملت', b, L.project);
    expect(c.kind).toBe('cheque');
    expect(c.card.fields).toMatchObject({ direction: 'issued', amount_rial: '1200000000', person_id: P.salehi, account_id: A.bank, due_date: '2026-11-21' });
    const p = parseDemo('سه میلیون به امید دادم', b, L.project);
    expect(p.kind).toBe('payment');
    expect(draftFields.payment.safeParse(p.card.fields).success).toBe(false); // no account said: the assistant asks
  });
});

describe('templates', () => {
  it('every kind of card has a template that says where it goes', () => {
    for (const k of Object.keys(draftFields)) {
      const t = TEMPLATES.find((x) => x.key === k);
      expect(t, k).toBeTruthy();
      expect(t!.href.startsWith('/')).toBe(true);
      expect(t!.required.length).toBeGreaterThan(0);
      expect(t!.examples.length).toBeGreaterThan(0);
    }
  });
});

describe('the guide teaches only what the assistant understands', () => {
  const b = sampleBook();
  it('every example of a ready template becomes a card of that template', () => {
    for (const t of TEMPLATES.filter((x) => !x.soon)) {
      for (const ex of t.examples) expect(parseDemo(ex, b, L.project).kind, ex).toBe(t.key);
    }
  });
  it('rial, yesterday, unpaid by default, several jobs in one message', () => {
    expect(parseDemo('پیش‌خریدار واحد دو، صد و پنجاه میلیون پایا به ملت زد', b, L.project).card.fields.amount_rial).toBe('1500000000');
    expect(parseDemo('دو میلیون ریال به امید دادم', b, L.project).card.fields.amount_rial).toBe('2000000');
    const w = parseDemo('دیروز سه نفر نظافت کارگاه، نفری نهصد هزار', b, L.project).card.fields;
    expect(w).toMatchObject({ headcount: 3, wage_rial: '9000000', paid: false, work_date: '2026-11-09' });
    const many = parseDemoMany('امروز پنج کارگر داشتیم و دوازده میلیون هم به رضایی دادم', b, L.project);
    expect(many.map((c) => c.kind)).toEqual(['work_log', 'payment']);
    expect(many[1].fields).toMatchObject({ amount_rial: '120000000', person_id: P.rezaei });
    expect(parseDemo('چک صالحی پاس شد', b, L.project).kind).toBe('daily_note');
  });
});

describe('QA sentences', () => {
  const b = sampleBook();
  const k = (s: string) => parseDemo(s, b, L.project);
  it('reads direction and amounts the way people mean them', () => {
    expect(k('بیست کیسه سیمان از مصالح‌فروشی امید گرفتم، سه میلیون نقد دادم از تنخواه').kind).toBe('payment');
    expect(k('پیش‌فروش واحد سه، دویست میلیون به ملت').kind).toBe('receipt');
    expect(k('صورت‌جلسه بتن امضا شد').kind).toBe('daily_note');
    expect(k('سلام').kind).toBe('daily_note');
    expect(k('از ملت یک چک صادر کردم به صالحی پنجاه میلیون').card.fields.direction).toBe('issued');
    expect(k('۱۲.۵ میلیون به رضایی دادم').card.fields.amount_rial).toBe('125000000');
    expect(k('12,000,000 تومان به رضایی دادم').card.fields.amount_rial).toBe('120000000');
    expect(k('۱۲٬۰۰۰٬۰۰۰ تومان به رضایی دادم').card.fields.amount_rial).toBe('120000000');
    expect(parseDemoMany('۱۲.۵ میلیون به رضایی دادم', b, L.project)).toHaveLength(1);
    expect(k('امروز پنج کارگر داشتیم، سقف دوم، نفری یک میلیون و دویست، هنوز ندادم').card.fields.description).toBe('سقف دوم');
  });
});

describe('a cheque owns its transaction', () => {
  it('the transaction made by clearing cannot be edited or deleted on its own', async () => {
    const { editTransaction, setTransactionVoided } = await import('./book');
    const b = setChequeStatus(sampleBook(), 'chq-1', 'cleared');
    const tx = b.cheques.find((c) => c.id === 'chq-1')!.transactionId!;
    expect(() => editTransaction(b, tx, { amountRial: 1n })).toThrow(/چک/);
    expect(() => setTransactionVoided(b, tx, true)).toThrow(/چک/);
  });
});

describe('QA round 2 sentences', () => {
  const b = sampleBook();
  const k = (s: string) => parseDemo(s, b, L.project);
  it('negatives, the Persian decimal sign, and digits next to number words', () => {
    expect(k('رضایی سه میلیون طلب داره، هنوز ندادم').kind).toBe('daily_note');
    expect(k('سه میلیون از رضایی نگرفتم').kind).toBe('daily_note');
    expect(k('۱۲٫۵ میلیون به رضایی دادم').card.fields.amount_rial).toBe('125000000');
    const r = k('پیش‌خرید واحد ۴ سیصد میلیون به ملت');
    expect(r.kind).toBe('receipt');
    expect(r.card.fields.amount_rial).toBe('3000000000');
  });
  it('a voided cheque transaction cannot be restored on its own', async () => {
    const { setTransactionVoided } = await import('./book');
    const b1 = setChequeStatus(sampleBook(), 'chq-1', 'cleared');
    const tx = b1.cheques.find((c) => c.id === 'chq-1')!.transactionId!;
    const b2 = setChequeStatus(b1, 'chq-1', 'pending');
    expect(() => setTransactionVoided(b2, tx, false)).toThrow(/چک/);
  });
});

describe('decimals typed on a Persian keyboard', () => {
  it('«۱۲/۵» and «۱۲٬۵» are 12.5; a paid sentence with a side «نگرفتم» stays a payment', () => {
    const b = sampleBook();
    expect(parseDemo('۱۲/۵ میلیون به امید دادم', b, L.project).card.fields.amount_rial).toBe('125000000');
    expect(parseDemo('۱۲٬۵ میلیون به امید دادم', b, L.project).card.fields.amount_rial).toBe('125000000');
    expect(parseDemo('سه میلیون به امید دادم، فاکتورش را نگرفتم', b, L.project).kind).toBe('payment');
  });
});
