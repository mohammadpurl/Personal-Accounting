'use client';
// The books for the open project, with the actions the screens use. Today it runs on the sample data;
// the Supabase data source will implement the same actions with the database functions (confirm_inbox, undo_inbox,
// set_cheque_status …). Every action also writes a line to the activity feed the dashboard shows.
import { createContext, useCallback, useContext, useMemo, useRef, useState, type ReactNode } from 'react';
import {
  addStage, confirmInbox, editTransaction, rejectInbox, setChequeStatus, setTransactionVoided, undoInbox, newId,
  accountBalance, personOwed, stageSpent, type Activity, type Book, type Cheque, type InboxItem,
} from '@/lib/book';
import type { EffectContext } from '@/lib/drafts';
import { sampleBook, SAMPLE_IDS } from '@/data/sample';
import { parseMarked } from '@/lib/transcript';
import { parseDemoMany } from '@/lib/demo-parse';
import { templateOf } from '@/lib/templates';
import { formatShortToman, toPersianDigits } from '@/lib/money';

export type CaptureKind = 'voice' | 'receipt' | 'invoice' | 'cheque' | 'text';

interface BookApi {
  book: Book;
  projectId: string;
  confirm: (inboxId: string, accept: string[], edits: Record<string, Record<string, unknown>>) => void;
  undo: (inboxId: string) => void;
  reject: (inboxId: string) => void;
  editTx: (id: string, patch: Parameters<typeof editTransaction>[2]) => void;
  voidTx: (id: string, voided: boolean) => void;
  addStage: (s: Parameters<typeof addStage>[2]) => void;
  setCheque: (id: string, status: Cheque['status'], accountId?: string) => void;
  capture: (kind: CaptureKind, text?: string) => string;
  effectContext: EffectContext;
}

const Ctx = createContext<BookApi | null>(null);

export function useBook(): BookApi {
  const v = useContext(Ctx);
  if (!v) throw new Error('useBook outside BookProvider');
  return v;
}

const now = () => {
  const d = new Date();
  return `امروز ${toPersianDigits(d.getHours())}:${toPersianDigits(String(d.getMinutes()).padStart(2, '0'))}`;
};
const log = (b: Book, text: string, href?: string, tone: Activity['tone'] = 'info'): Book =>
  ({ ...b, activity: [{ id: newId('ac'), at: now(), text, href, tone }, ...b.activity].slice(0, 60) });

/** One short line per confirmed card, for the feed: «پرداخت ۱۲ میلیون به حسین رضایی». */
export function cardHeadline(b: Book, kind: string, f: Record<string, unknown>): string {
  const t = templateOf(kind);
  const who = (id: unknown) => b.people.find((p) => p.id === id)?.fullName;
  const amt = f.amount_rial ? `${formatShortToman(BigInt(f.amount_rial as string))} تومان` : '';
  switch (kind) {
    case 'work_log': return `کارکرد ${toPersianDigits(Number(f.headcount) || 0)} نفر`;
    case 'stage_progress': return `پیشرفت ${b.stages.find((s) => s.id === f.stage_id)?.name ?? 'مرحله'}${f.progress_pct !== undefined ? ` ${toPersianDigits(Number(f.progress_pct))}٪` : ''}`;
    case 'daily_note': { const s = String(f.body ?? '').trim(); return s ? `«${s.length > 40 ? `${s.slice(0, 40)}…` : s}»` : 'یادداشت'; }
    case 'document': return `سند «${String(f.title ?? '')}»`;
    case 'cheque': return `چک ${f.direction === 'received' ? 'دریافتی' : 'صادره'} ${amt}${who(f.person_id) ? ` ${f.direction === 'received' ? 'از' : 'به'} ${who(f.person_id)}` : ''}`;
    default: return `${t?.label ?? ''} ${amt}${who(f.person_id) ? ` ${kind === 'receipt' ? 'از' : 'به'} ${who(f.person_id)}` : ''}`.trim();
  }
}

export function BookProvider({ children }: { children: ReactNode }) {
  const [book, setBook] = useState<Book>(sampleBook);
  const projectId = SAMPLE_IDS.L.project;
  // Every change goes through apply(): the next book is computed here, outside React's state updater,
  // so a refused card throws to the button that asked (and is shown there) instead of breaking the page.
  const latest = useRef<Book>(book);
  const apply = useCallback((fn: (b: Book) => Book) => {
    const next = fn(latest.current);
    latest.current = next;
    setBook(next);
  }, []);

  const confirm = useCallback<BookApi['confirm']>((inboxId, accept, edits) => apply((b) => {
    let next = confirmInbox(b, inboxId, accept, edits);
    const ib = next.inbox.find((i) => i.id === inboxId)!;
    for (const d of [...ib.drafts].reverse().filter((x) => x.status === 'accepted')) {
      const t = templateOf(d.kind);
      next = log(next, `${cardHeadline(next, d.kind, d.fields)} در «${t?.page ?? ''}» ثبت شد`, t?.href, 'pos');
    }
    return next;
  }), [apply]);
  const undo = useCallback((inboxId: string) => apply((b) => log(undoInbox(b, inboxId), 'یک ثبت برگردانده شد و به «منتظر تأیید» برگشت', '/inbox', 'warn')), [apply]);
  const reject = useCallback((inboxId: string) => apply((b) => log(rejectInbox(b, inboxId), 'یک ورودی رد شد؛ فایل اصلی در بایگانی ماند', '/archive', 'neg')), [apply]);
  const editTx = useCallback<BookApi['editTx']>((id, patch) => apply((b) => log(editTransaction(b, id, patch), 'یک تراکنش ویرایش شد', '/transactions')), [apply]);
  const voidTx = useCallback((id: string, voided: boolean) => apply((b) => log(setTransactionVoided(b, id, voided), voided ? 'یک تراکنش حذف شد' : 'تراکنش حذف‌شده برگردانده شد', '/transactions', voided ? 'neg' : 'info')), [apply]);
  const addStageFn = useCallback<BookApi['addStage']>((s) => apply((b) => log(addStage(b, projectId, s), `مرحلهٔ «${s.name.trim()}» اضافه شد`, '/stages', 'accent')), [apply, projectId]);
  const setCheque = useCallback<BookApi['setCheque']>((id, status, accountId) => apply((b) => {
    const c = b.cheques.find((x) => x.id === id);
    const who = b.people.find((p) => p.id === c?.personId)?.fullName ?? '';
    const word = { pending: 'به «در جریان» برگشت', cleared: c?.direction === 'issued' ? 'پاس شد' : 'وصول شد', bounced: 'برگشت خورد', cancelled: 'باطل شد' }[status];
    return log(setChequeStatus(b, id, status, accountId), `چک ${c ? formatShortToman(c.amountRial) : ''} تومانی ${c?.direction === 'issued' ? 'به' : 'از'} ${who} ${word}`, '/cheques', status === 'bounced' ? 'neg' : status === 'cleared' ? 'pos' : 'info');
  }), [apply]);

  // Sample only: what a new voice, photo or typed message looks like while it is being understood, then ready.
  const capture = useCallback((kind: CaptureKind, text?: string) => {
    const id = newId('ib');
    const TITLE: Record<CaptureKind, string> = { voice: 'ویس', receipt: 'عکس رسید', invoice: 'عکس فاکتور', cheque: 'عکس چک', text: 'پیام نوشتاری' };
    const processing: InboxItem = {
      id, ledgerId: projectId, kind, channel: 'web', title: TITLE[kind], receivedLabel: 'همین الان',
      status: 'processing', chips: [], drafts: [], text,
    };
    // the feed gets one line, when it is understood; «being understood» shows in the conversation itself
    apply((b) => ({ ...b, inbox: [processing, ...b.inbox] }));
    setTimeout(() => apply((b) => {
      const ready = (i: InboxItem): InboxItem => {
        if (kind === 'text') {
          const cards = parseDemoMany(text ?? '', b, projectId);
          return { ...i, status: 'ready', drafts: cards, chips: cards.map((c) => templateOf(c.kind)?.label ?? '') };
        }
        if (kind === 'cheque') {
          return { ...i, status: 'ready', chips: ['چک صادره ۴۲ میلیون'], ocr: 'چک صیادی · بانک ملت · مبلغ چهارصد و بیست میلیون ریال · در وجه: جرثقیل‌رانی ساحل · تاریخ ۱۴۰۵/۰۹/۱۰',
            drafts: [{ id: newId('d'), kind: 'cheque', status: 'pending', guess: { stage_id: 'از نام گیرنده حدس زده شد' },
              fields: { direction: 'issued', amount_rial: '420000000', person_id: SAMPLE_IDS.P.sahel, due_date: '2026-12-01', account_id: SAMPLE_IDS.A.bank, bank: 'ملت', stage_id: SAMPLE_IDS.S('frame'), description: 'کرایهٔ جرثقیل' } }] };
        }
        return {
          ...i, status: 'ready',
          durationLabel: kind === 'voice' ? '۰:۱۲' : undefined,
          transcript: kind === 'voice' ? parseMarked('<mark>بیست کیسه سیمان</mark> از مصالح‌فروشی امید گرفتم، <mark>سه میلیون</mark> نقد دادم از <mark>تنخواه</mark>.') : undefined,
          ocr: kind === 'receipt' ? 'رسید پایا · مبلغ ۴۲٬۰۰۰٬۰۰۰ ریال · مقصد: جرثقیل‌رانی ساحل'
            : kind === 'invoice' ? 'فاکتور · جرثقیل‌رانی ساحل · کرایهٔ جرثقیل · جمع ۴۲٬۰۰۰٬۰۰۰ ریال' : undefined,
          chips: [kind === 'voice' ? 'خرید نقدی ۳ میلیون' : 'پرداخت ۴٫۲ میلیون'],
          drafts: [kind === 'voice'
            ? { id: newId('d'), kind: 'payment', status: 'pending', guess: {},
                fields: { amount_rial: '30000000', account_id: SAMPLE_IDS.A.cash, person_id: SAMPLE_IDS.P.omid, stage_id: SAMPLE_IDS.S('frame'), description: '۲۰ کیسه سیمان تیپ ۲', occurred_on: b.today } }
            : { id: newId('d'), kind: 'payment', status: 'pending', guess: { stage_id: 'از نام گیرنده حدس زده شد' },
                fields: { amount_rial: '42000000', account_id: SAMPLE_IDS.A.bank, person_id: SAMPLE_IDS.P.sahel, stage_id: SAMPLE_IDS.S('frame'), description: 'کرایهٔ جرثقیل', method: 'پایا', occurred_on: b.today } }],
        };
      };
      const next = { ...b, inbox: b.inbox.map((i) => (i.id === id ? ready(i) : i)) };
      return log(next, `${TITLE[kind]} فهمیده شد؛ منتظر تأیید شماست`, '/inbox', 'accent');
    }), 2200);
    return id;
  }, [projectId, apply]);

  const effectContext = useMemo<EffectContext>(() => ({
    accounts: Object.fromEntries(book.accounts.map((a) => [a.id, { name: a.name, ledgerKind: book.ledgers.find((l) => l.id === a.ledgerId)!.kind }])),
    people: Object.fromEntries(book.people.map((p) => [p.id, { name: p.fullName, owedRial: personOwed(book, projectId, p.id) }])),
    stages: Object.fromEntries(book.stages.map((s) => [s.id, { name: s.name }])),
    today: book.today,
  }), [book, projectId]);

  const api = useMemo(() => ({ book, projectId, confirm, undo, reject, editTx, voidTx, addStage: addStageFn, setCheque, capture, effectContext }),
    [book, projectId, confirm, undo, reject, editTx, voidTx, addStageFn, setCheque, capture, effectContext]);
  return <Ctx.Provider value={api}>{children}</Ctx.Provider>;
}

export { accountBalance, personOwed, stageSpent };
