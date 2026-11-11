// The project's books in memory: the same rules as the database (supabase/migrations), used by the
// sample data source until the real server exists. Balances, inter-ledger debt and transfer rules mirror the
// SQL views and triggers; src/lib/book.test.ts checks the cases that matter.
import { validateDraft, type DraftKind } from './drafts';
import { formatJalali } from './jalali';
import type { TranscriptPart } from './transcript';
import { normFa } from './text';

export type LedgerKind = 'project' | 'company' | 'personal';
export type Source = 'voice' | 'receipt' | 'invoice' | 'manual';

export interface Ledger { id: string; kind: LedgerKind; name: string }
export interface Account { id: string; ledgerId: string; kind: 'bank' | 'cash' | 'other'; name: string; detail: string; openingRial: bigint }
export interface Person { id: string; kind: string; fullName: string; roleTitle: string; initials: string }
export interface Stage {
  id: string; ledgerId: string; ord: number; phase: 'pre' | 'build' | 'finish'; name: string;
  status: 'todo' | 'in_progress' | 'done' | 'skipped'; progressPct: number; budgetRial: bigint;
}
export interface Transaction {
  id: string; ledgerId: string; accountId: string; occurredOn: string; amountRial: bigint; isCost: boolean;
  transferId?: string; personId?: string; stageId?: string; description: string; method?: string;
  source: Source; draftId?: string; voided: boolean; history: string[];
}
export interface Obligation {
  id: string; ledgerId: string; personId: string; stageId?: string; occurredOn: string; amountRial: bigint;
  kind: 'work' | 'invoice' | 'contract' | 'opening' | 'other'; description: string; draftId?: string; voided: boolean;
}
export interface WorkLog {
  id: string; ledgerId: string; stageId?: string; workDate: string; headcount: number; wageRial: bigint;
  crewPersonId?: string; paid: boolean; description: string; draftId?: string; voided: boolean;
}
export interface DocumentRec {
  id: string; ledgerId: string; category: string; discipline?: string; title: string;
  status: 'awaiting_file' | 'draft' | 'approved' | 'executive' | 'as_built' | 'expired';
  meta: string; draftId?: string; hidden: boolean;
}
export interface DailyNote { id: string; ledgerId: string; noteDate: string; body: string; stageId?: string; draftId?: string; voided: boolean }
export interface Inspection { id: string; who: string; initials: string; meta: string; open: boolean; text: string; source: string }
export interface InterLedger { id: string; debtorLedgerId: string; creditorLedgerId: string; amountRial: bigint; transactionId: string; voided: boolean }

export interface DraftCard {
  id: string; kind: DraftKind; fields: Record<string, unknown>;
  guess: Record<string, string>; // field → why it was guessed («مطمئن نیستم»)
  status: 'pending' | 'accepted' | 'dropped';
  created?: { table: string; id: string }[]; stagePrev?: Pick<Stage, 'status' | 'progressPct'>;
}
export interface InboxItem {
  id: string; ledgerId: string; kind: 'voice' | 'receipt' | 'invoice'; channel: 'bale' | 'telegram' | 'web';
  title: string; receivedLabel: string; durationLabel?: string; transcript?: TranscriptPart[]; ocr?: string;
  status: 'processing' | 'ready' | 'confirmed' | 'rejected'; chips: string[]; drafts: DraftCard[];
}

export interface Book {
  workspaceName: string;
  ownerName: string;
  projectHint: string; // e.g. «۴ طبقه، تهران»
  today: string;
  ledgers: Ledger[]; accounts: Account[]; people: Person[]; stages: Stage[];
  transactions: Transaction[]; obligations: Obligation[]; workLogs: WorkLog[]; documents: DocumentRec[];
  dailyNotes: DailyNote[]; inspections: Inspection[]; interLedger: InterLedger[]; inbox: InboxItem[];
}

let seq = 0;
export const newId = (p = 'id') => `${p}-${Date.now().toString(36)}-${(seq++).toString(36)}`;

// ---------- balances (same as the SQL views) ----------

export function accountBalance(b: Book, accountId: string): bigint {
  const a = b.accounts.find((x) => x.id === accountId);
  if (!a) return 0n;
  return b.transactions.filter((t) => t.accountId === accountId && !t.voided).reduce((s, t) => s + t.amountRial, a.openingRial);
}

/** > 0 we owe them, < 0 we prepaid. */
export function personOwed(b: Book, ledgerId: string, personId: string): bigint {
  const ob = b.obligations.filter((o) => o.ledgerId === ledgerId && o.personId === personId && !o.voided).reduce((s, o) => s + o.amountRial, 0n);
  const tx = b.transactions
    .filter((t) => t.ledgerId === ledgerId && t.personId === personId && !t.isCost && !t.transferId && !t.voided)
    .reduce((s, t) => s + t.amountRial, 0n);
  return ob + tx;
}

interface CostEntry { stageId?: string; on: string; amount: bigint }
function costEntries(b: Book, ledgerId: string): CostEntry[] {
  return [
    ...b.transactions.filter((t) => t.ledgerId === ledgerId && t.isCost && !t.voided).map((t) => ({ stageId: t.stageId, on: t.occurredOn, amount: -t.amountRial })),
    ...b.obligations.filter((o) => o.ledgerId === ledgerId && !o.voided).map((o) => ({ stageId: o.stageId, on: o.occurredOn, amount: o.amountRial })),
  ];
}

export const stageSpent = (b: Book, ledgerId: string, stageId: string) =>
  costEntries(b, ledgerId).filter((c) => c.stageId === stageId).reduce((s, c) => s + c.amount, 0n);

export const spendBetween = (b: Book, ledgerId: string, from: string, to: string) =>
  costEntries(b, ledgerId).filter((c) => c.on >= from && c.on <= to).reduce((s, c) => s + c.amount, 0n);

export const projectSpent = (b: Book, ledgerId: string) => costEntries(b, ledgerId).reduce((s, c) => s + c.amount, 0n);

// ---------- confirming an inbox item (same as confirm_inbox) ----------

export class CardError extends Error {
  constructor(public draftId: string, public errors: Record<string, string>) { super('card is not valid'); }
}

/** What `debtor` owes `creditor` in all (the net of both directions), like the SQL. */
export function interLedgerOwed(b: Book, debtor: string, creditor: string): bigint {
  return b.interLedger.filter((x) => !x.voided).reduce((s, x) =>
    x.debtorLedgerId === debtor && x.creditorLedgerId === creditor ? s + x.amountRial
      : x.debtorLedgerId === creditor && x.creditorLedgerId === debtor ? s - x.amountRial : s, 0n);
}

/** Same as the tg_transaction_inter_ledger trigger: money moved in another ledger's account makes the two ledgers owe each other. */
function syncInterLedger(next: Book, t: Transaction) {
  const accLedger = next.accounts.find((a) => a.id === t.accountId)?.ledgerId;
  const row = next.interLedger.find((x) => x.transactionId === t.id);
  if (accLedger && accLedger !== t.ledgerId && !t.voided) {
    const out = t.amountRial < 0n;
    const v = { debtorLedgerId: out ? t.ledgerId : accLedger, creditorLedgerId: out ? accLedger : t.ledgerId, amountRial: out ? -t.amountRial : t.amountRial, voided: false };
    if (row) Object.assign(row, v);
    else next.interLedger.push({ id: newId('il'), transactionId: t.id, ...v });
  } else if (row) row.voided = true;
}

export function confirmInbox(b: Book, inboxId: string, accept: string[], edits: Record<string, Record<string, unknown>> = {}): Book {
  const item = b.inbox.find((i) => i.id === inboxId);
  if (!item || item.status !== 'ready') throw new Error('این مورد دیگر منتظر تأیید نیست');
  const next: Book = structuredClone(b);
  const ib = next.inbox.find((i) => i.id === inboxId)!;
  const source: Source = ib.kind;
  const day = formatJalali(b.today, { withYear: false });
  const hist = [`${day} · ساخته‌شده از ${ib.title}`, `${day} · تأیید شد`];
  const who = (id: unknown) => next.people.find((p) => p.id === id)?.fullName;

  for (const d of ib.drafts) {
    if (d.status !== 'pending') continue;
    if (!accept.includes(d.id)) { d.status = 'dropped'; continue; }
    const v = validateDraft(d.kind, { ...d.fields, ...(edits[d.id] ?? {}) });
    if (!v.ok) throw new CardError(d.id, v.errors);
    const f = v.fields as Record<string, unknown>;
    d.fields = f;
    const created: { table: string; id: string }[] = [];
    const L = ib.ledgerId;

    if (d.kind === 'payment') {
      const amt = BigInt(f.amount_rial as string);
      const t: Transaction = {
        id: newId('tx'), ledgerId: L, accountId: f.account_id as string, occurredOn: (f.occurred_on as string) ?? b.today,
        amountRial: -amt, isCost: !f.settles, personId: f.person_id as string | undefined, stageId: f.stage_id as string | undefined,
        description: (f.description as string) || (who(f.person_id) ? `پرداخت به ${who(f.person_id)}` : 'پرداخت'), method: f.method as string | undefined, source, draftId: d.id, voided: false, history: hist,
      };
      next.transactions.unshift(t); created.push({ table: 'transactions', id: t.id });
    } else if (d.kind === 'receipt') {
      const t: Transaction = {
        id: newId('tx'), ledgerId: L, accountId: f.account_id as string, occurredOn: (f.occurred_on as string) ?? b.today,
        amountRial: BigInt(f.amount_rial as string), isCost: false, personId: f.person_id as string | undefined,
        description: (f.description as string) || (who(f.person_id) ? `دریافت از ${who(f.person_id)}` : 'دریافت'), source, draftId: d.id, voided: false, history: hist,
      };
      next.transactions.unshift(t); created.push({ table: 'transactions', id: t.id });
    } else if (d.kind === 'transfer') {
      const amt = BigInt(f.amount_rial as string), tr = newId('tr'), on = (f.occurred_on as string) ?? b.today;
      for (const [acc, sign] of [[f.from_account_id, -1n], [f.to_account_id, 1n]] as const) {
        const t: Transaction = { id: newId('tx'), ledgerId: L, accountId: acc as string, occurredOn: on, amountRial: sign * amt, isCost: false, transferId: tr,
          description: (f.description as string) || 'انتقال بین حساب‌ها', source, draftId: d.id, voided: false, history: hist };
        next.transactions.unshift(t); created.push({ table: 'transactions', id: t.id });
      }
    } else if (d.kind === 'work_log') {
      const total = BigInt(f.wage_rial as string) * BigInt(f.headcount as number);
      const on = (f.work_date as string) ?? b.today;
      const desc = (f.description as string) || 'دستمزد کارگران';
      if (total > 0n && f.paid) {
        const t: Transaction = { id: newId('tx'), ledgerId: L, accountId: f.account_id as string, occurredOn: on, amountRial: -total, isCost: true,
          personId: f.crew_person_id as string | undefined, stageId: f.stage_id as string | undefined, description: desc, source, draftId: d.id, voided: false, history: hist };
        next.transactions.unshift(t); created.push({ table: 'transactions', id: t.id });
      } else if (total > 0n) {
        const o: Obligation = { id: newId('ob'), ledgerId: L, personId: f.crew_person_id as string, stageId: f.stage_id as string | undefined, occurredOn: on,
          amountRial: total, kind: 'work', description: desc, draftId: d.id, voided: false };
        next.obligations.unshift(o); created.push({ table: 'obligations', id: o.id });
      }
      const w: WorkLog = { id: newId('wl'), ledgerId: L, stageId: f.stage_id as string | undefined, workDate: on, headcount: f.headcount as number,
        wageRial: BigInt(f.wage_rial as string), crewPersonId: f.crew_person_id as string | undefined, paid: Boolean(f.paid) && total > 0n, description: desc, draftId: d.id, voided: false };
      next.workLogs.unshift(w); created.push({ table: 'work_logs', id: w.id });
    } else if (d.kind === 'stage_progress') {
      const s = next.stages.find((x) => x.id === f.stage_id)!;
      d.stagePrev = { status: s.status, progressPct: s.progressPct };
      if (f.progress_pct !== undefined) s.progressPct = f.progress_pct as number;
      if (f.status) s.status = f.status as Stage['status'];
    } else if (d.kind === 'daily_note') {
      const n: DailyNote = { id: newId('dn'), ledgerId: L, noteDate: (f.note_date as string) ?? b.today, body: f.body as string, stageId: f.stage_id as string | undefined, draftId: d.id, voided: false };
      next.dailyNotes.unshift(n); created.push({ table: 'daily_notes', id: n.id });
    } else if (d.kind === 'document') {
      const hasFile = Array.isArray(f.media_ids) && f.media_ids.length > 0;
      const doc: DocumentRec = { id: newId('doc'), ledgerId: L, category: f.category_code as string, discipline: f.discipline_code as string | undefined,
        title: f.title as string, status: hasFile ? ((f.status as DocumentRec['status']) ?? 'approved') : 'awaiting_file', meta: 'از ویس امروز', draftId: d.id, hidden: false };
      next.documents.unshift(doc); created.push({ table: 'documents', id: doc.id });
    }
    for (const c of created) {
      const t = c.table === 'transactions' && next.transactions.find((x) => x.id === c.id);
      if (t) syncInterLedger(next, t);
    }
    d.status = 'accepted';
    d.created = created;
  }
  ib.status = 'confirmed';
  return next;
}

export function undoInbox(b: Book, inboxId: string): Book {
  const next: Book = structuredClone(b);
  const ib = next.inbox.find((i) => i.id === inboxId);
  if (!ib) throw new Error('این مورد پیدا نشد');
  if (ib.status === 'rejected') { ib.status = 'ready'; return next; }
  if (ib.status !== 'confirmed') throw new Error('چیزی برای برگرداندن نیست');
  // like undo_inbox: newest card first; a stage is put back only if nothing changed it since
  for (const d of [...ib.drafts].reverse()) {
    if (d.kind === 'stage_progress' && d.stagePrev) {
      const s = next.stages.find((x) => x.id === d.fields.stage_id);
      if (s && ((d.fields.progress_pct !== undefined && s.progressPct !== d.fields.progress_pct) || (d.fields.status && s.status !== d.fields.status))) {
        throw new Error('این مرحله بعد از این مورد دوباره تغییر کرده؛ به‌جای برگرداندن، خود مرحله را ویرایش کنید');
      }
    }
    for (const c of d.created ?? []) {
      if (c.table === 'transactions') {
        const t = next.transactions.find((x) => x.id === c.id);
        if (t) { t.voided = true; syncInterLedger(next, t); }
      }
      if (c.table === 'obligations') { const o = next.obligations.find((x) => x.id === c.id); if (o) o.voided = true; }
      if (c.table === 'work_logs') { const w = next.workLogs.find((x) => x.id === c.id); if (w) w.voided = true; }
      if (c.table === 'daily_notes') { const n = next.dailyNotes.find((x) => x.id === c.id); if (n) n.voided = true; }
      if (c.table === 'documents') { const doc = next.documents.find((x) => x.id === c.id); if (doc) doc.hidden = true; }
    }
    if (d.kind === 'stage_progress' && d.stagePrev) {
      const s = next.stages.find((x) => x.id === d.fields.stage_id);
      if (s) { s.status = d.stagePrev.status; s.progressPct = d.stagePrev.progressPct; }
    }
    d.status = 'pending'; d.created = undefined; d.stagePrev = undefined;
  }
  ib.status = 'ready';
  return next;
}

export function rejectInbox(b: Book, inboxId: string): Book {
  const next: Book = structuredClone(b);
  const ib = next.inbox.find((i) => i.id === inboxId);
  if (!ib || ib.status !== 'ready') throw new Error('این مورد دیگر منتظر تأیید نیست');
  ib.status = 'rejected';
  return next;
}

/** A stage the owner adds (e.g. «دیوار حائل»): placed after the last stage of its phase; stages are renumbered. */
export function addStage(b: Book, ledgerId: string, s: { name: string; phase: Stage['phase']; budgetRial: bigint }): Book {
  const name = s.name.trim();
  if (!name) throw new Error('نام مرحله را بنویسید');
  const next: Book = structuredClone(b);
  const order: Stage['phase'][] = ['pre', 'build', 'finish'];
  const own = next.stages.filter((x) => x.ledgerId === ledgerId).sort((x, y) => x.ord - y.ord);
  if (own.some((x) => normFa(x.name) === normFa(name))) throw new Error('مرحله‌ای با همین نام هست');
  const at = own.filter((x) => order.indexOf(x.phase) <= order.indexOf(s.phase)).length;
  own.splice(at, 0, { id: newId('st'), ledgerId, ord: 0, phase: s.phase, name, status: 'todo', progressPct: 0, budgetRial: s.budgetRial });
  own.forEach((x, i) => { x.ord = i + 1; });
  next.stages = [...next.stages.filter((x) => x.ledgerId !== ledgerId), ...own];
  return next;
}

/** Both legs of a transfer change together (the database refuses a transfer whose legs do not sum to zero). */
const legsOf = (b: Book, t: Transaction) => (t.transferId ? b.transactions.filter((x) => x.transferId === t.transferId) : [t]);

/** Edit a transaction (amount in Rial, positive); history records what changed. Inter-ledger debt follows. */
export function editTransaction(b: Book, id: string, patch: { description?: string; amountRial?: bigint; stageId?: string; accountId?: string; personId?: string; occurredOn?: string; method?: string }): Book {
  const next: Book = structuredClone(b);
  const t = next.transactions.find((x) => x.id === id);
  if (!t) throw new Error('این تراکنش پیدا نشد');
  if (t.voided) throw new Error('تراکنش حذف‌شده را نمی‌شود ویرایش کرد');
  const legs = legsOf(next, t);
  if (patch.accountId !== undefined && legs.some((x) => x !== t && x.accountId === patch.accountId)) throw new Error('مبدأ و مقصد انتقال نمی‌تواند یک حساب باشد');
  const changes: string[] = [];
  if (patch.description !== undefined && patch.description !== t.description) { changes.push('شرح'); legs.forEach((x) => { x.description = patch.description!; }); }
  if (patch.amountRial !== undefined && patch.amountRial > 0n && patch.amountRial !== (t.amountRial < 0n ? -t.amountRial : t.amountRial)) {
    changes.push('مبلغ');
    legs.forEach((x) => { x.amountRial = x.amountRial < 0n ? -patch.amountRial! : patch.amountRial!; });
  }
  if (patch.method !== undefined && patch.method !== (t.method ?? '') && !t.transferId) { changes.push('روش پرداخت'); t.method = patch.method || undefined; }
  if (patch.occurredOn !== undefined && patch.occurredOn !== t.occurredOn) { changes.push('تاریخ'); legs.forEach((x) => { x.occurredOn = patch.occurredOn!; }); }
  if (patch.stageId !== undefined && (patch.stageId || undefined) !== t.stageId && !t.transferId) { changes.push('مرحله'); t.stageId = patch.stageId || undefined; }
  if (patch.accountId !== undefined && patch.accountId !== t.accountId) { changes.push('حساب'); t.accountId = patch.accountId; }
  if (patch.personId !== undefined && (patch.personId || undefined) !== t.personId && !t.transferId) { changes.push('طرف حساب'); t.personId = patch.personId || undefined; }
  if (changes.length) {
    const line = `${formatJalali(b.today, { withYear: false })} · ویرایش: ${changes.join('، ')}`;
    legs.forEach((x) => { x.history = [...x.history, line]; syncInterLedger(next, x); });
  }
  return next;
}

export function setTransactionVoided(b: Book, id: string, voided: boolean): Book {
  const next: Book = structuredClone(b);
  const t = next.transactions.find((x) => x.id === id);
  if (!t) throw new Error('این تراکنش پیدا نشد');
  const line = `${formatJalali(b.today, { withYear: false })} · ${voided ? 'حذف شد' : 'برگردانده شد'}`;
  for (const x of legsOf(next, t)) {
    x.voided = voided;
    x.history = [...x.history, line];
    syncInterLedger(next, x);
  }
  return next;
}
