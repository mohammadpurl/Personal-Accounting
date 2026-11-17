'use client';
// Detail windows: a cheque (clear, bounce, cancel, reopen), a person (their account with us), an archived item.
import { useState } from 'react';
import { Dropdown, Icon, Sheet, SheetHead, useToast } from './ui';
import { CHANNEL, Field, KIND_ICON, useOptions } from './review';
import { useBook, cardHeadline } from '@/state/book';
import { personOwed, type Cheque, type InboxItem, type Person } from '@/lib/book';
import { templateOf } from '@/lib/templates';
import { transcriptText } from '@/lib/transcript';
import { formatToman, toPersianDigits } from '@/lib/money';
import { daysBetween, formatJalali } from '@/lib/jalali';

/** «۴ روز دیگر»، «امروز»، «۳ روز گذشته» */
export function dueLabel(due: string, today: string) {
  const d = daysBetween(today, due);
  return d === 0 ? 'امروز' : d > 0 ? `${toPersianDigits(d)} روز دیگر` : `${toPersianDigits(-d)} روز گذشته`;
}
export const CHEQUE_STATUS: Record<Cheque['status'], { label: (c: Cheque) => string; tone: string }> = {
  pending: { label: () => 'در جریان', tone: 'accent' },
  cleared: { label: (c) => (c.direction === 'issued' ? 'پاس شد' : 'وصول شد'), tone: 'pos' },
  bounced: { label: () => 'برگشت خورد', tone: 'neg' },
  cancelled: { label: () => 'باطل', tone: 'info' },
};

// keeps the last record while the window animates out
function useLast<T>(v: T | null) {
  const [last, setLast] = useState(v);
  if (v && v !== last) setLast(v);
  return last;
}

// ---------- cheque ----------

export function ChequeSheet({ cheque, onClose }: { cheque: Cheque | null; onClose: () => void }) {
  const last = useLast(cheque);
  return <Sheet open={!!cheque} onClose={onClose} returnFocus="#pageTitle">{last && <ChequeBody key={last.id} c={last} onClose={onClose} />}</Sheet>;
}

function ChequeBody({ c, onClose }: { c: Cheque; onClose: () => void }) {
  const { book, setCheque } = useBook();
  const toast = useToast();
  const o = useOptions();
  const [account, setAccount] = useState(c.accountId ?? '');
  const who = book.people.find((p) => p.id === c.personId)?.fullName ?? '—';
  const st = CHEQUE_STATUS[c.status];
  const change = (status: Cheque['status']) => {
    const before = c.status;
    try {
      setCheque(c.id, status, status === 'cleared' ? account || undefined : undefined);
      onClose();
      toast(status === 'cleared' ? (c.direction === 'issued' ? 'چک پاس شد و از حساب کم شد' : 'چک وصول شد و به حساب آمد') : 'وضعیت چک عوض شد',
        { label: 'برگرداندن', run: () => { try { setCheque(c.id, before); } catch (e) { toast((e as Error).message, undefined, 'error'); } } });
    } catch (e) { toast((e as Error).message, undefined, 'error'); }
  };
  return (
    <>
      <SheetHead icon="receipt" kind="receipt" title={`چک ${c.direction === 'issued' ? 'صادره' : 'دریافتی'}`} sub={`${c.direction === 'issued' ? 'در وجه' : 'از'} ${who}`} onClose={onClose} />
      <div className="sheet-body">
        <div className="pcard">
          <div className="kv">
            <div><span>مبلغ</span><b className="num">{formatToman(c.amountRial)}</b></div>
            <div><span>وضعیت</span><span className={`pill ${st.tone}`}>{st.label(c)}</span></div>
            <div><span>سررسید</span><b>{formatJalali(c.dueDate)} <span className="muted small">({dueLabel(c.dueDate, book.today)})</span></b></div>
            <div><span>بانک</span><b>{c.bank ?? '—'}</b></div>
            <div><span>شمارهٔ صیادی</span><b className="num ltr">{c.sayadNo ?? '—'}</b></div>
            <div><span>بابت</span><b>{c.description || '—'}</b></div>
          </div>
        </div>
        {c.status === 'pending' && (
          <div className="pcard"><div className="fields">
            <Field label={c.direction === 'issued' ? 'از حساب' : 'واریز به حساب'} wide>{(id) => <Dropdown labelledBy={id} options={o.accounts} value={account} onChange={setAccount} placeholder="حساب را انتخاب کنید" />}</Field>
          </div>
            <p className="why">{c.direction === 'issued'
              ? `وقتی «پاس شد» را بزنید، ${formatToman(c.amountRial)} از این حساب کم می‌شود${c.settles ? ' و از طلب طرف کم می‌شود' : ' و خرج مرحله حساب می‌شود'}.`
              : `وقتی «وصول شد» را بزنید، ${formatToman(c.amountRial)} به این حساب اضافه می‌شود.`}</p>
          </div>
        )}
        <div className="sec-title"><Icon name="clip" size="sm" />تاریخچه</div>
        <ol className="hist">{c.history.map((h, i) => <li key={i}>{h}</li>)}</ol>
      </div>
      <div className="sheet-foot">
        {c.status === 'pending' ? (
          <>
            <button className="btn primary" type="button" disabled={!account} onClick={() => change('cleared')}><Icon name="check" />{c.direction === 'issued' ? 'پاس شد' : 'وصول شد'}</button>
            <button className="btn" type="button" onClick={() => change('bounced')}>برگشت خورد</button>
            <span className="grow" />
            <button className="btn ghost danger" type="button" onClick={() => change('cancelled')}>باطل شد</button>
          </>
        ) : (
          <>
            <button className="btn" type="button" onClick={() => change('pending')}>برگرداندن به «در جریان»</button>
            <span className="grow" />
            <button className="btn ghost" type="button" onClick={onClose}>بستن</button>
          </>
        )}
      </div>
    </>
  );
}

// ---------- person ----------

export function PersonSheet({ person, onClose }: { person: Person | null; onClose: () => void }) {
  const last = useLast(person);
  return <Sheet open={!!person} onClose={onClose} returnFocus="#pageTitle">{last && <PersonBody key={last.id} p={last} onClose={onClose} />}</Sheet>;
}

function PersonBody({ p, onClose }: { p: Person; onClose: () => void }) {
  const { book, projectId } = useBook();
  const owed = personOwed(book, projectId, p.id);
  const rows = [
    ...book.obligations.filter((o) => o.personId === p.id && o.ledgerId === projectId && !o.voided)
      .map((o) => ({ id: o.id, on: o.occurredOn, text: o.description || 'طلب', amt: o.amountRial, kind: 'طلب' })),
    ...book.transactions.filter((t) => t.personId === p.id && t.ledgerId === projectId && !t.voided && !t.transferId)
      .map((t) => ({ id: t.id, on: t.occurredOn, text: t.description, amt: t.amountRial, kind: t.amountRial < 0n ? (t.isCost ? 'خرید/خرج' : 'پرداخت') : 'دریافت' })),
    // a cleared cheque already shows as its transaction above
    ...book.cheques.filter((c) => c.personId === p.id && c.ledgerId === projectId && !c.voided && c.status !== 'cleared')
      .map((c) => ({ id: c.id, on: c.dueDate, text: `چک ${c.direction === 'issued' ? 'صادره' : 'دریافتی'}، ${CHEQUE_STATUS[c.status].label(c)}`, amt: c.direction === 'issued' ? -c.amountRial : c.amountRial, kind: 'چک' })),
  ].sort((a, b) => (a.on < b.on ? 1 : -1));
  return (
    <>
      <SheetHead icon="users" kind="voice" title={p.fullName} sub={p.roleTitle} onClose={onClose} />
      <div className="sheet-body">
        <div className={`effect${owed > 0n ? ' warn' : ''}`}>
          <span>{owed > 0n ? `${formatToman(owed)} از پروژه طلب دارد.` : owed < 0n ? `${formatToman(-owed)} پیش‌پرداخت به او داده‌ایم.` : 'حسابش تسویه است.'}</span>
        </div>
        <div className="sec-title"><Icon name="clip" size="sm" />گردش حساب ({toPersianDigits(rows.length)} ردیف)</div>
        {rows.length === 0 ? <p className="muted">هنوز با این شخص حسابی نداریم.</p> : (
          <ol className="hist ledger-hist">
            {rows.map((r) => (
              <li key={r.id}><span className="muted small">{formatJalali(r.on, { withYear: false })}</span><span>{r.text} <span className="muted small">· {r.kind}</span></span>
                <b className={`num ${r.amt < 0n ? 'neg-t' : 'pos-t'}`}><span className="ltr">{formatToman(r.amt < 0n ? -r.amt : r.amt, { unit: false })}</span></b></li>
            ))}
          </ol>
        )}
      </div>
      <div className="sheet-foot"><button className="btn" type="button" onClick={onClose}>بستن</button></div>
    </>
  );
}

// ---------- archived item ----------

const STATUS: Record<InboxItem['status'], { label: string; tone: string }> = {
  processing: { label: 'در حال بررسی', tone: 'info' }, ready: { label: 'منتظر تأیید', tone: 'accent' },
  confirmed: { label: 'تأیید شد', tone: 'pos' }, rejected: { label: 'رد شد', tone: 'neg' },
};
export const inboxStatus = STATUS;

export function ArchiveSheet({ item, onClose, onReview }: { item: InboxItem | null; onClose: () => void; onReview: (id: string) => void }) {
  const last = useLast(item);
  return <Sheet open={!!item} onClose={onClose} returnFocus="#pageTitle">{last && <ArchiveBody key={last.id} i={last} onClose={onClose} onReview={onReview} />}</Sheet>;
}

function ArchiveBody({ i, onClose, onReview }: { i: InboxItem; onClose: () => void; onReview: (id: string) => void }) {
  const { book } = useBook();
  const said = i.text ?? (i.transcript ? transcriptText(i.transcript) : i.ocr) ?? '';
  return (
    <>
      <SheetHead icon={KIND_ICON[i.kind]} kind={i.kind === 'text' ? 'voice' : i.kind === 'cheque' ? 'receipt' : i.kind} title={i.title} sub={`${CHANNEL[i.channel]} · ${i.receivedLabel}`} onClose={onClose} />
      <div className="sheet-body">
        <div className="kv-line"><span className={`pill ${STATUS[i.status].tone}`}>{STATUS[i.status].label}</span><span className="muted small">فایل اصلی برای همیشه نگه داشته می‌شود و هرگز تغییر نمی‌کند.</span></div>
        {said && <><div className="sec-title"><Icon name="msg" size="sm" />{i.kind === 'voice' ? 'متن ویس' : i.kind === 'text' ? 'پیام' : 'متن خوانده‌شده'}</div><div className="transcript">{said}</div></>}
        {i.drafts.length > 0 && (
          <>
            <div className="sec-title"><Icon name="check-board" size="sm" />موارد</div>
            <ul className="card-lines">
              {i.drafts.map((d) => {
                const t = templateOf(d.kind);
                return (
                  <li key={d.id}><span className={`pill ${t?.tone ?? 'info'}`}>{t?.label}</span><span className="headline">{cardHeadline(book, d.kind, d.fields)}</span>
                    <span className="muted small">{d.status === 'accepted' ? `ثبت شد در «${t?.page}»` : d.status === 'dropped' ? 'ثبت نشد' : 'منتظر تأیید'}</span></li>
                );
              })}
            </ul>
          </>
        )}
      </div>
      <div className="sheet-foot">
        {i.status === 'ready' && <button className="btn primary" type="button" onClick={() => onReview(i.id)}><Icon name="check" />بررسی و تأیید</button>}
        <button className="btn" type="button" onClick={onClose}>بستن</button>
      </div>
    </>
  );
}
