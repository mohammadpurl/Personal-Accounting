'use client';
// How any component opens a shared window. Kept apart from the host (sheets.tsx) so the windows can use it
// without importing the host that renders them.
import { createContext, useContext } from 'react';
import type { Transaction } from '@/lib/book';

export interface SheetsApi {
  openReview: (inboxId: string) => void;
  openTx: (tx: Transaction) => void;
  openCheque: (id: string) => void;
  openPerson: (id: string) => void;
  openArchive: (inboxId: string) => void;
  openAssistant: (text?: string) => void;
}
export const SheetsCtx = createContext<SheetsApi | null>(null);
export const useSheets = () => {
  const v = useContext(SheetsCtx);
  if (!v) throw new Error('useSheets outside SheetsProvider');
  return v;
};
