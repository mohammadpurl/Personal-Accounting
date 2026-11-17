'use client';
// The windows any page can open: review an inbox item, edit a transaction, a cheque, a person, an archived item,
// and the assistant. One host for all pages, so a window opened from the dashboard and from its page is the same.
import { useCallback, useMemo, useState, type ReactNode } from 'react';
import { ReviewSheet, TxSheet } from './review';
import { ArchiveSheet, ChequeSheet, PersonSheet } from './details';
import { AssistantSheet } from './assistant';
import { useBook } from '@/state/book';
import type { Transaction } from '@/lib/book';
import { SheetsCtx } from './sheets-context';

export { useSheets } from './sheets-context';

export function SheetsProvider({ children }: { children: ReactNode }) {
  const { book } = useBook();
  const [review, setReview] = useState<string | null>(null);
  const [tx, setTx] = useState<Transaction | null>(null);
  const [cheque, setCheque] = useState<string | null>(null);
  const [person, setPerson] = useState<string | null>(null);
  const [archive, setArchive] = useState<string | null>(null);
  const [assistant, setAssistant] = useState<{ open: boolean; text: string; n: number }>({ open: false, text: '', n: 0 });

  const openReview = useCallback((id: string) => setReview(id), []);
  const openTx = useCallback((t: Transaction) => setTx(t), []);
  const openCheque = useCallback((id: string) => setCheque(id), []);
  const openPerson = useCallback((id: string) => setPerson(id), []);
  const openArchive = useCallback((id: string) => setArchive(id), []);
  const openAssistant = useCallback((text = '') => setAssistant((a) => ({ open: true, text, n: a.n + 1 })), []);
  const api = useMemo(() => ({ openReview, openTx, openCheque, openPerson, openArchive, openAssistant }),
    [openReview, openTx, openCheque, openPerson, openArchive, openAssistant]);

  const reviewItem = book.inbox.find((i) => i.id === review && i.status === 'ready') ?? null;
  const chequeRec = book.cheques.find((c) => c.id === cheque && !c.voided) ?? null;
  const personRec = book.people.find((p) => p.id === person) ?? null;
  const archiveItem = book.inbox.find((i) => i.id === archive) ?? null;

  return (
    <SheetsCtx.Provider value={api}>
      {children}
      <ReviewSheet item={reviewItem} onClose={() => setReview(null)} />
      <TxSheet tx={tx} onClose={() => setTx(null)} />
      <ChequeSheet cheque={chequeRec} onClose={() => setCheque(null)} />
      <PersonSheet person={personRec} onClose={() => setPerson(null)} />
      <ArchiveSheet item={archiveItem} onClose={() => setArchive(null)} onReview={(id) => { setArchive(null); setReview(id); }} />
      <AssistantSheet open={assistant.open} initialText={assistant.text} round={assistant.n} onClose={() => setAssistant((a) => ({ ...a, open: false }))} />
    </SheetsCtx.Provider>
  );
}
