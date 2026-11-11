import { describe, expect, it } from 'vitest';
import { sampleBook, SAMPLE_IDS } from '@/data/sample';
import { accountBalance, addStage, CardError, confirmInbox, editTransaction, interLedgerOwed, personOwed, projectSpent, setTransactionVoided, spendBetween, stageSpent, undoInbox } from './book';
import { parseMarked, transcriptText } from './transcript';

const M = 10_000_000n;
const { L, P, A, S } = SAMPLE_IDS;
const ABAN = ['2026-10-23', '2026-11-21'] as const;
const MEHR = ['2026-09-23', '2026-10-22'] as const;

describe('sample books add up', () => {
  const b = sampleBook();
  it('accounts end where the dashboard says', () => {
    expect(accountBalance(b, A.bank)).toBe(8624n * M / 10n);
    expect(accountBalance(b, A.cash)).toBe(216n * M / 10n);
    expect(accountBalance(b, A.personal)).toBe(356n * M);
  });
  it('month and stage totals agree with the chart and the stage list', () => {
    expect(spendBetween(b, L.project, ...ABAN)).toBe(30189n * M / 100n);
    expect(spendBetween(b, L.project, ...MEHR)).toBe(594n * M);
    expect(stageSpent(b, L.project, S('frame'))).toBe(980n * M);
    expect(projectSpent(b, L.project)).toBe(238589n * M / 100n);
  });
  it('debts: contractors are owed, the concrete supplier was prepaid', () => {
    expect(personOwed(b, L.project, P.rezaei)).toBe(18n * M);
    expect(personOwed(b, L.project, P.pars)).toBe(-6n * M);
    expect(personOwed(b, L.project, P.crew)).toBe(0n);
  });
});

describe('confirming and undoing (same results as the database tests)', () => {
  it('voice note: wages owed, old debt paid, note and awaiting document', () => {
    const b0 = sampleBook();
    const b1 = confirmInbox(b0, 'ib-1', ['d-1', 'd-2', 'd-3', 'd-4']);
    expect(accountBalance(b1, A.bank)).toBe(accountBalance(b0, A.bank) - 12n * M);
    expect(personOwed(b1, L.project, P.rezaei)).toBe(6n * M);
    expect(personOwed(b1, L.project, P.crew)).toBe(6n * M);
    expect(stageSpent(b1, L.project, S('frame'))).toBe(986n * M);
    expect(b1.documents[0]).toMatchObject({ title: 'نامهٔ تمدید پروانهٔ ساخت', status: 'awaiting_file' });
    expect(b1.inbox.find((i) => i.id === 'ib-1')!.status).toBe('confirmed');

    const b2 = undoInbox(b1, 'ib-1');
    expect(accountBalance(b2, A.bank)).toBe(accountBalance(b0, A.bank));
    expect(personOwed(b2, L.project, P.crew)).toBe(0n);
    expect(stageSpent(b2, L.project, S('frame'))).toBe(980n * M);
    expect(b2.inbox.find((i) => i.id === 'ib-1')!.drafts.every((d) => d.status === 'pending')).toBe(true);
  });

  it('dropped cards are not recorded; edits win; invalid edits are refused per card', () => {
    const b0 = sampleBook();
    const b1 = confirmInbox(b0, 'ib-1', ['d-2'], { 'd-2': { amount_rial: (10n * M).toString() } });
    expect(personOwed(b1, L.project, P.rezaei)).toBe(8n * M);
    expect(b1.inbox[0].drafts.filter((d) => d.status === 'dropped')).toHaveLength(3);
    expect(() => confirmInbox(b0, 'ib-1', ['d-2'], { 'd-2': { amount_rial: '0' } })).toThrow(CardError);
  });

  it('editing or removing a transaction keeps balances and history in step', () => {
    const b0 = sampleBook();
    const t = b0.transactions.find((x) => x.description === 'کرایهٔ جرثقیل')!;
    const b1 = editTransaction(b0, t.id, { amountRial: 5n * M });
    expect(accountBalance(b1, A.cash)).toBe(accountBalance(b0, A.cash) - 5n * M / 10n);
    expect(b1.transactions.find((x) => x.id === t.id)!.history.at(-1)).toMatch(/ویرایش: مبلغ/);
    const b2 = setTransactionVoided(b1, t.id, true);
    expect(accountBalance(b2, A.cash)).toBe(accountBalance(b0, A.cash) + 45n * M / 10n);
    const personalTx = b0.transactions.find((x) => x.accountId === A.personal)!;
    const b3 = editTransaction(b0, personalTx.id, { amountRial: 2n * M });
    expect(b3.interLedger[0].amountRial).toBe(2n * M);
  });
});

describe('same rules as the database after review', () => {
  const b0 = sampleBook();
  const legs = (b: typeof b0) => b.transactions.filter((t) => t.transferId === 'tr-1');

  it('a transfer is edited and deleted as a whole: money is never made or lost', () => {
    const total = (b: typeof b0) => accountBalance(b, A.bank) + accountBalance(b, A.cash);
    const leg = legs(b0)[0];
    const b1 = editTransaction(b0, leg.id, { amountRial: 50n * M });
    expect(legs(b1).map((t) => t.amountRial).sort()).toEqual([-50n * M, 50n * M].sort());
    expect(total(b1)).toBe(total(b0));
    const b2 = setTransactionVoided(b1, leg.id, true);
    expect(legs(b2).every((t) => t.voided)).toBe(true);
    expect(total(b2)).toBe(total(b0));
    expect(() => editTransaction(b0, leg.id, { accountId: legs(b0)[1].accountId })).toThrow();
  });

  it('moving a payment to the personal account makes the project owe the owner; moving it back clears it', () => {
    const t = b0.transactions.find((x) => x.description.startsWith('سیمان تیپ ۲'))!;
    const before = interLedgerOwed(b0, L.project, L.personal);
    const b1 = editTransaction(b0, t.id, { accountId: A.personal });
    expect(interLedgerOwed(b1, L.project, L.personal)).toBe(before + 63n * M / 10n);
    const b2 = editTransaction(b1, t.id, { accountId: A.bank });
    expect(interLedgerOwed(b2, L.project, L.personal)).toBe(before);
  });

  it('wages paid from the personal account count as the project owing the owner', () => {
    const b1 = confirmInbox(b0, 'ib-1', ['d-1'], { 'd-1': { paid: true, account_id: A.personal } });
    expect(interLedgerOwed(b1, L.project, L.personal)).toBe(interLedgerOwed(b0, L.project, L.personal) + 60n * M / 10n);
  });

  it('settling a debt needs the person', () => {
    expect(() => confirmInbox(b0, 'ib-1', ['d-2'], { 'd-2': { person_id: undefined } })).toThrow(CardError);
  });

  it('a new stage sits after the last stage of its phase and stages are renumbered', () => {
    const b1 = addStage(b0, L.project, { name: 'دیوار حائل', phase: 'build', budgetRial: 0n });
    const own = b1.stages.filter((s) => s.ledgerId === L.project);
    const i = own.findIndex((s) => s.name === 'دیوار حائل');
    expect(own[i - 1].name).toBe('محوطه و مشاعات');
    expect(own[i + 1].phase).toBe('finish');
    expect(own.map((s) => s.ord)).toEqual(own.map((_, k) => k + 1));
    expect(() => addStage(b0, L.project, { name: '  ', phase: 'build', budgetRial: 0n })).toThrow();
  });

  it('a transcript is text with highlights, never HTML', () => {
    const parts = parseMarked('یک <mark>دو</mark> <img src=x onerror=alert(1)>');
    expect(parts).toEqual(['یک ', { hl: 'دو' }, ' <img src=x onerror=alert(1)>']);
    expect(transcriptText(parts)).toBe('یک دو <img src=x onerror=alert(1)>');
  });
});
