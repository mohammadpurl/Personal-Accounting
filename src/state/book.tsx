'use client';
// The books for the open project, with the actions the screens use. Today it runs on the sample data;
// the Supabase data source will implement the same actions with the database functions (confirm_inbox, undo_inbox …).
import { createContext, useCallback, useContext, useMemo, useRef, useState, type ReactNode } from 'react';
import {
  addStage, confirmInbox, editTransaction, rejectInbox, setTransactionVoided, undoInbox, newId,
  accountBalance, personOwed, stageSpent, type Book, type InboxItem,
} from '@/lib/book';
import type { EffectContext } from '@/lib/drafts';
import { sampleBook, SAMPLE_IDS } from '@/data/sample';
import { parseMarked } from '@/lib/transcript';

interface BookApi {
  book: Book;
  projectId: string;
  confirm: (inboxId: string, accept: string[], edits: Record<string, Record<string, unknown>>) => void;
  undo: (inboxId: string) => void;
  reject: (inboxId: string) => void;
  editTx: (id: string, patch: Parameters<typeof editTransaction>[2]) => void;
  voidTx: (id: string, voided: boolean) => void;
  addStage: (s: Parameters<typeof addStage>[2]) => void;
  capture: (kind: 'voice' | 'receipt' | 'invoice') => string;
  effectContext: EffectContext;
}

const Ctx = createContext<BookApi | null>(null);

export function useBook(): BookApi {
  const v = useContext(Ctx);
  if (!v) throw new Error('useBook outside BookProvider');
  return v;
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

  const confirm = useCallback<BookApi['confirm']>((inboxId, accept, edits) => apply((b) => confirmInbox(b, inboxId, accept, edits)), [apply]);
  const undo = useCallback((inboxId: string) => apply((b) => undoInbox(b, inboxId)), [apply]);
  const reject = useCallback((inboxId: string) => apply((b) => rejectInbox(b, inboxId)), [apply]);
  const editTx = useCallback<BookApi['editTx']>((id, patch) => apply((b) => editTransaction(b, id, patch)), [apply]);
  const voidTx = useCallback((id: string, voided: boolean) => apply((b) => setTransactionVoided(b, id, voided)), [apply]);
  const addStageFn = useCallback<BookApi['addStage']>((s) => apply((b) => addStage(b, projectId, s)), [apply, projectId]);

  // Sample only: what a new voice or photo looks like while it is being understood, then ready.
  const capture = useCallback((kind: 'voice' | 'receipt' | 'invoice') => {
    const id = newId('ib');
    const processing: InboxItem = {
      id, ledgerId: projectId, kind, channel: 'web', title: kind === 'voice' ? 'ویس' : kind === 'receipt' ? 'عکس رسید' : 'عکس فاکتور', receivedLabel: 'همین الان',
      status: 'processing', chips: [], drafts: [],
    };
    apply((b) => ({ ...b, inbox: [processing, ...b.inbox] }));
    setTimeout(() => apply((b) => ({
      ...b,
      inbox: b.inbox.map((i) => i.id !== id ? i : {
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
      }),
    })), 2200);
    return id;
  }, [projectId, apply]);

  const effectContext = useMemo<EffectContext>(() => ({
    accounts: Object.fromEntries(book.accounts.map((a) => [a.id, { name: a.name, ledgerKind: book.ledgers.find((l) => l.id === a.ledgerId)!.kind }])),
    people: Object.fromEntries(book.people.map((p) => [p.id, { name: p.fullName, owedRial: personOwed(book, projectId, p.id) }])),
    stages: Object.fromEntries(book.stages.map((s) => [s.id, { name: s.name }])),
    today: book.today,
  }), [book, projectId]);

  const api = useMemo(() => ({ book, projectId, confirm, undo, reject, editTx, voidTx, addStage: addStageFn, capture, effectContext }),
    [book, projectId, confirm, undo, reject, editTx, voidTx, addStageFn, capture, effectContext]);
  return <Ctx.Provider value={api}>{children}</Ctx.Provider>;
}

export { accountBalance, personOwed, stageSpent };
