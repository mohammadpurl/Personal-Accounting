'use client';
// Review-and-confirm window for an inbox item, the quick-capture window, and the transaction edit window.
import { useEffect, useId, useMemo, useState } from 'react';
import { useReducedMotion } from 'motion/react';
import { describeEffect, DOC_CATEGORIES, validateDraft, type DraftKind } from '@/lib/drafts';
import { accountBalance, CardError, type DraftCard, type InboxItem, type Transaction } from '@/lib/book';
import { formatShortToman, formatToman, parseWholeNumber, toPersianDigits, tomanToRial } from '@/lib/money';
import { formatJalali } from '@/lib/jalali';
import { DatePicker, Dropdown, Icon, Sheet, SheetHead, useConfirmTap, useToast, type Option } from './ui';
import { useBook } from '@/state/book';

const KIND_ICON: Record<InboxItem['kind'], string> = { voice: 'mic', receipt: 'camera', invoice: 'file' };
const CARD: Record<DraftKind, { label: string; tone: string }> = {
  payment: { label: 'پرداخت', tone: 'neg' }, receipt: { label: 'دریافت', tone: 'pos' }, transfer: { label: 'انتقال', tone: 'info' },
  work_log: { label: 'کارکرد کارگر', tone: 'accent' }, stage_progress: { label: 'پیشرفت مرحله', tone: 'pos' },
  daily_note: { label: 'یادداشت روزانه', tone: 'warn' }, document: { label: 'سند دریافتی', tone: 'info' },
};
const CHANNEL: Record<InboxItem['channel'], string> = { bale: 'ربات بله', telegram: 'ربات تلگرام', web: 'همین صفحه' };
const METHODS: Option[] = ['کارت به کارت', 'پایا', 'ساتنا', 'نقد', 'چک'].map((v) => ({ value: v, label: v }));

type Fields = Record<string, unknown>;

// ---------- field controls ----------

function Field({ label, guess, error, wide, children, id }: { label: string; guess?: string; error?: string; wide?: boolean; children: (labelId: string) => React.ReactNode; id?: string }) {
  const uid = useId();
  const labelId = id ?? `${uid}-l`;
  const errId = `${uid}-e`;
  return (
    <div className={`field${wide ? ' wide' : ''}`}>
      <span className="flabel" id={labelId}>{label}{guess && <span className="unsure"> · مطمئن نیستم</span>}</span>
      {/* the error is part of the control's name, so a screen reader says what to fix */}
      {children(error ? `${labelId} ${errId}` : labelId)}
      {error ? <span className="why err" id={errId}>{error}</span> : guess ? <span className="why">{guess}</span> : null}
    </div>
  );
}

function MoneyInput({ rial, onChange, labelledBy, warn, invalid }: { rial: string | undefined; onChange: (rial: string) => void; labelledBy: string; warn?: boolean; invalid?: boolean }) {
  const shown = rial ? formatToman(BigInt(rial), { unit: false }) : '';
  const [text, setText] = useState(shown);
  const [prevShown, setPrevShown] = useState(shown);
  if (shown !== prevShown) { setPrevShown(shown); setText(shown); } // the amount changed from outside
  return (
    <div className={`inp money-inp${warn ? ' warn' : ''}${invalid ? ' err' : ''}`}>
      <input aria-labelledby={labelledBy} inputMode="numeric" value={text} aria-invalid={invalid || undefined}
        onChange={(e) => { setText(e.target.value); const t = parseWholeNumber(e.target.value); onChange(t === null ? '' : tomanToRial(t).toString()); }}
        onBlur={() => setText(shown)} />
      <span className="u">تومان</span>
    </div>
  );
}

function TextInput({ value, onChange, labelledBy, area, warn, invalid, numeric }: { value: string; onChange: (v: string) => void; labelledBy: string; area?: number; warn?: boolean; invalid?: boolean; numeric?: boolean }) {
  const cls = `${warn ? ' warn' : ''}${invalid ? ' err' : ''}`;
  return area ? (
    <div className={`inp area${cls}`}><textarea rows={area} aria-labelledby={labelledBy} aria-invalid={invalid || undefined} value={value} onChange={(e) => onChange(e.target.value)} /></div>
  ) : (
    <div className={`inp${cls}`}><input aria-labelledby={labelledBy} aria-invalid={invalid || undefined} value={value} inputMode={numeric ? 'numeric' : undefined} onChange={(e) => onChange(e.target.value)} /></div>
  );
}

function useOptions() {
  const { book, projectId } = useBook();
  return useMemo(() => {
    const ledgerKind = (id: string) => book.ledgers.find((l) => l.id === id)?.kind;
    const accounts: Option[] = book.accounts.map((a) => ({ value: a.id, label: `${a.name}${ledgerKind(a.ledgerId) === 'personal' ? ' (شخصی)' : ' (پروژه)'}`, hint: ledgerKind(a.ledgerId) === 'personal' ? 'پروژه به شما بدهکار می‌شود' : undefined }));
    const people: Option[] = book.people.map((p) => ({ value: p.id, label: p.roleTitle ? `${p.fullName}، ${p.roleTitle}` : p.fullName }));
    const stages: Option[] = [{ value: '', label: 'هزینهٔ عمومی پروژه' }, ...book.stages.filter((s) => s.ledgerId === projectId).map((s) => ({ value: s.id, label: s.name }))];
    const categories: Option[] = Object.entries(DOC_CATEGORIES).map(([value, label]) => ({ value, label }));
    return { accounts, people, stages, categories };
  }, [book, projectId]);
}

function CardFields({ card, f, set, errors }: { card: DraftCard; f: Fields; set: (k: string, v: unknown) => void; errors: Record<string, string> }) {
  const { book } = useBook();
  const o = useOptions();
  const g = (k: string) => card.guess[k];
  const str = (k: string) => (f[k] as string | undefined) ?? '';
  const dd = (k: string, label: string, options: Option[], wide?: boolean) => (
    <Field key={k} label={label} guess={g(k)} error={errors[k]} wide={wide}>{(id) => <Dropdown labelledBy={id} options={options} value={str(k)} warn={!!g(k)} invalid={!!errors[k]} onChange={(v) => set(k, v || undefined)} />}</Field>
  );
  const money = (k: string, label: string) => (
    <Field key={k} label={label} guess={g(k)} error={errors[k]}>{(id) => <MoneyInput labelledBy={id} rial={str(k)} warn={!!g(k)} invalid={!!errors[k]} onChange={(v) => set(k, v)} />}</Field>
  );
  const date = (k: string, label: string) => (
    <Field key={k} label={label} guess={g(k)} error={errors[k]}>{(id) => <DatePicker labelledBy={id} title={label} today={book.today} value={str(k) || undefined} warn={!!g(k)} invalid={!!errors[k]} onChange={(v) => set(k, v)} />}</Field>
  );
  const text = (k: string, label: string, area?: number) => (
    <Field key={k} label={label} guess={g(k)} error={errors[k]} wide={!!area}>{(id) => <TextInput labelledBy={id} area={area} value={str(k)} warn={!!g(k)} invalid={!!errors[k]} onChange={(v) => set(k, v)} />}</Field>
  );

  switch (card.kind) {
    case 'work_log': {
      const total = (BigInt(str('wage_rial') || '0')) * BigInt(Number(f.headcount) || 0);
      return (
        <div className="fields">
          <Field label="تعداد" guess={g('headcount')} error={errors.headcount}>{(id) => (
            <div className={`inp${g('headcount') ? ' warn' : ''}${errors.headcount ? ' err' : ''}`}><input aria-labelledby={id} inputMode="numeric" aria-invalid={!!errors.headcount || undefined} value={f.headcount ? toPersianDigits(String(f.headcount)) : ''}
              onChange={(e) => { const n = parseWholeNumber(e.target.value); set('headcount', n === null ? 0 : Number(n)); }} /><span className="u">نفر</span></div>
          )}</Field>
          {dd('stage_id', 'مرحله', o.stages)}
          {text('description', 'شرح', 2)}
          {money('wage_rial', 'دستمزد هر نفر')}
          <Field label="جمع (خودکار)">{(id) => <output className="inp calc" aria-labelledby={id} aria-live="polite"><span className="calc-v num">{formatToman(total, { unit: false })}</span><span className="u">تومان</span></output>}</Field>
          <Field label="پرداخت دستمزد" guess={g('paid')} error={errors.paid}>{(id) => (
            <Dropdown labelledBy={id} warn={!!g('paid')} invalid={!!errors.paid} value={f.paid ? 'paid' : 'unpaid'} onChange={(v) => set('paid', v === 'paid')}
              options={[{ value: 'unpaid', label: 'هنوز پرداخت نشده', hint: 'طلب کارگرها' }, { value: 'paid', label: 'پرداخت شد' }]} />
          )}</Field>
          {f.paid ? dd('account_id', 'از حساب', o.accounts) : dd('crew_person_id', 'طلب به', o.people)}
          {date('work_date', 'تاریخ')}
        </div>
      );
    }
    case 'payment':
      return (
        <div className="fields">
          {money('amount_rial', 'مبلغ')}
          {dd('person_id', 'به', o.people)}
          {dd('account_id', 'از حساب', o.accounts)}
          {dd('method', 'روش', METHODS)}
          <Field label="نوع پرداخت" guess={g('settles')}>{(id) => (
            <Dropdown labelledBy={id} warn={!!g('settles')} value={f.settles ? 'settle' : 'cost'} onChange={(v) => set('settles', v === 'settle')}
              options={[{ value: 'cost', label: 'خرج تازه', hint: 'به خرج مرحله اضافه می‌شود' }, { value: 'settle', label: 'تسویهٔ بدهی قبلی', hint: 'فقط طلب طرف کم می‌شود' }]} />
          )}</Field>
          {!f.settles && dd('stage_id', 'مرحله', o.stages)}
          {date('occurred_on', 'تاریخ')}
          {text('description', 'شرح')}
        </div>
      );
    case 'receipt':
      return <div className="fields">{money('amount_rial', 'مبلغ')}{dd('person_id', 'از', o.people)}{dd('account_id', 'به حساب', o.accounts)}{date('occurred_on', 'تاریخ')}</div>;
    case 'transfer':
      return <div className="fields">{money('amount_rial', 'مبلغ')}{dd('from_account_id', 'از حساب', o.accounts)}{dd('to_account_id', 'به حساب', o.accounts)}{date('occurred_on', 'تاریخ')}</div>;
    case 'stage_progress':
      return (
        <div className="fields">
          {dd('stage_id', 'مرحله', o.stages)}
          <Field label="درصد پیشرفت" guess={g('progress_pct')} error={errors.progress_pct}>{(id) => (
            <div className={`inp${g('progress_pct') ? ' warn' : ''}${errors.progress_pct ? ' err' : ''}`}>
              <input aria-labelledby={id} inputMode="numeric" aria-invalid={!!errors.progress_pct || undefined}
                value={f.progress_pct === undefined ? '' : toPersianDigits(String(f.progress_pct))}
                onChange={(e) => { const n = parseWholeNumber(e.target.value); set('progress_pct', n === null ? undefined : Number(n)); }} />
              <span className="u">٪</span>
            </div>
          )}</Field>
        </div>
      );
    case 'daily_note':
      return <div className="fields">{text('body', 'یادداشت', 3)}{dd('stage_id', 'مرحله', o.stages)}{date('note_date', 'تاریخ')}</div>;
    case 'document':
      return (
        <div className="fields">
          {text('title', 'عنوان')}
          {dd('category_code', 'دسته', o.categories)}
          <div className="hint wide" style={{ gridColumn: '1 / -1' }}><Icon name="alert" size="sm" /><span>فایل این سند هنوز نرسیده. عکس یا PDF آن را در ربات «به‌صورت فایل» بفرستید تا کنار همین ثبت بنشیند.</span></div>
        </div>
      );
  }
}

const clip = (s: string, n = 40) => (s.length > n ? `${s.slice(0, n).trimEnd()}…` : s);

// ---------- review sheet ----------

/** Stays mounted while it closes, so the window animates out; the last item is kept for that moment. */
export function ReviewSheet({ item, onClose }: { item: InboxItem | null; onClose: () => void }) {
  const [last, setLast] = useState(item);
  if (item && item !== last) setLast(item);
  return (
    <Sheet open={!!item} onClose={onClose} returnFocus="#inboxTitle">
      {last && <ReviewBody key={last.id} item={last} onClose={onClose} />}
    </Sheet>
  );
}

function ReviewBody({ item, onClose }: { item: InboxItem; onClose: () => void }) {
  const { confirm, reject, undo, effectContext } = useBook();
  const toast = useToast();
  const reduce = useReducedMotion();
  const [edits, setEdits] = useState<Record<string, Fields>>({});
  const [dropped, setDropped] = useState<string[]>([]);
  const [errors, setErrors] = useState<Record<string, Record<string, string>>>({});
  const [rejectArmed, armReject] = useConfirmTap();
  const [playing, setPlaying] = useState(false);

  const cards = item.drafts.filter((d) => d.status === 'pending' && !dropped.includes(d.id));
  const fieldsOf = (d: DraftCard): Fields => ({ ...d.fields, ...(edits[d.id] ?? {}) });
  const set = (d: DraftCard, k: string, v: unknown) => {
    setEdits((e) => ({ ...e, [d.id]: { ...(e[d.id] ?? {}), [k]: v } }));
    setErrors((e) => ({ ...e, [d.id]: {} }));
  };
  // Every card is checked as it is edited; the button stays off until all are complete.
  const checks = cards.map((d) => validateDraft(d.kind, fieldsOf(d)));
  const errorsOf = (i: number) => { const v = checks[i]; return { ...(v.ok ? {} : v.errors), ...(errors[cards[i].id] ?? {}) }; };
  const bad = cards.map((_, i) => i).filter((i) => Object.keys(errorsOf(i)).length > 0);
  const firstBad = bad[0];
  const goToBad = () => {
    if (firstBad === undefined) return;
    const el = document.getElementById(`card-${cards[firstBad].id}`);
    el?.scrollIntoView({ block: 'center', behavior: reduce ? 'auto' : 'smooth' });
    el?.querySelector<HTMLElement>('[aria-invalid="true"], [data-invalid]')?.focus({ preventScroll: true });
  };
  const doConfirm = () => {
    if (bad.length) { goToBad(); return; }
    try {
      const names = cards.map((d) => CARD[d.kind].label).join('، ');
      confirm(item.id, cards.map((d) => d.id), edits);
      onClose();
      toast(`${toPersianDigits(cards.length)} مورد ثبت شد: ${names}`, { label: 'برگرداندن', run: () => { undo(item.id); toast('برگشت به «منتظر تأیید»'); } });
    } catch (e) {
      if (e instanceof CardError) setErrors({ [e.draftId]: e.errors });
      else toast((e as Error).message, undefined, 'error');
    }
  };
  const doReject = () => {
    if (!armReject()) return;
    reject(item.id);
    onClose();
    toast('رد شد؛ فایل اصلی در بایگانی می‌ماند', { label: 'برگرداندن', run: () => { undo(item.id); toast('برگشت به «منتظر تأیید»'); } });
  };

  return (
    <>
      <SheetHead icon={KIND_ICON[item.kind]} kind={item.kind} title={item.title} sub={`${CHANNEL[item.channel]} · ${item.receivedLabel}`} onClose={onClose} />
      <div className="sheet-body">
        {item.transcript ? (
          <>
            <div className="player">
              <button className="play" type="button" aria-label={playing ? 'توقف' : 'پخش ویس'} onClick={() => setPlaying((p) => !p)}><Icon name={playing ? 'pause' : 'play'} /></button>
              <div className="wave" aria-hidden="true">{Array.from({ length: 48 }, (_, i) => <i key={i} className={playing ? 'on' : undefined} style={{ height: `${18 + Math.round(Math.abs(Math.sin(i * 1.7) * 60 + Math.cos(i * 0.6) * 20))}%` }} />)}</div>
              <span className="muted num">{item.durationLabel}</span>
            </div>
            <div className="sec-title"><Icon name="msg" size="sm" />متن ویس</div>
            {/* plain text and highlights as parts: nothing said in a voice can run in the page */}
            <div className="transcript">{item.transcript.map((p, i) => (typeof p === 'string' ? p : <mark key={i}>{p.hl}</mark>))}</div>
          </>
        ) : (
          <div className="src-row">
            <button type="button" className="thumb" aria-label="بزرگ کردن عکس" aria-pressed={false} onClick={(e) => { const b = e.currentTarget.classList.toggle('big'); e.currentTarget.setAttribute('aria-pressed', String(b)); }}>
              <span className="paper" aria-hidden="true"><i /><i className="w" /><b>رسید</b><i /><i className="w" /><b>{item.chips[0]}</b><i className="w" /></span>
            </button>
            <div className="src-text">
              <div className="sec-title"><Icon name={KIND_ICON[item.kind]} size="sm" />متن خوانده‌شده از عکس</div>
              <div className="transcript small-t">{item.ocr}</div>
              <span className="why">عکس اصلی کنار ثبت نگه داشته می‌شود. روی عکس بزنید تا بزرگ شود.</span>
            </div>
          </div>
        )}
        <div className="sec-title"><Icon name="check-board" size="sm" />این‌ها را فهمیدم. هر چیزی را که درست نیست، همین‌جا اصلاح کنید.</div>
        <div className="parsed">
          {cards.map((d, i) => {
            const f = fieldsOf(d);
            const v = checks[i];
            const errs = errorsOf(i);
            return (
              <div className={`pcard${bad.includes(i) ? ' has-err' : ''}`} key={d.id} id={`card-${d.id}`}>
                <div className="pcard-head">
                  <span className={`pill ${CARD[d.kind].tone}`}>{CARD[d.kind].label}</span><b>مورد {toPersianDigits(i + 1)}</b>
                  <button className="btn sm ghost x" type="button" aria-label={`ثبت نکردن مورد ${toPersianDigits(i + 1)}`} onClick={() => setDropped((x) => [...x, d.id])}><Icon name="x" size="sm" />ثبت نکن</button>
                </div>
                <CardFields card={d} f={f} set={(k, val) => set(d, k, val)} errors={errs} />
                {v.ok && <div className="effect"><span><b>با تأیید:</b> {describeEffect(d.kind, v.fields, effectContext)}</span></div>}
                {errs._ && <div className="hint err"><Icon name="alert" size="sm" /><span>{errs._}</span></div>}
                {item.kind === 'receipt' && d.kind === 'payment' && <div className="hint ok"><Icon name="check" size="sm" /><span>مبلغ رسید به ریال بود و به تومان تبدیل شد.</span></div>}
              </div>
            );
          })}
          {item.drafts.filter((d) => d.status === 'pending' && dropped.includes(d.id)).map((d) => (
            <div className="pcard dropped" key={d.id}>
              <span className={`pill ${CARD[d.kind].tone}`}>{CARD[d.kind].label}</span>
              <span className="small"><b>{d.fields.amount_rial ? formatShortToman(BigInt(d.fields.amount_rial as string)) + ' تومان' : (clip(String(d.fields.title ?? d.fields.body ?? d.fields.description ?? '')) || `مورد ${toPersianDigits(item.drafts.indexOf(d) + 1)}`)}</b> <span className="muted nowrap">· ثبت نمی‌شود</span></span>
              <button className="btn sm ghost" type="button" onClick={() => setDropped((x) => x.filter((id) => id !== d.id))}>برگرداندن</button>
            </div>
          ))}
          {cards.length === 0 && <div className="empty"><Icon name="check" /><b>موردی برای ثبت نمانده</b><span>اگر همه اشتباه است، کل این ورودی را رد کنید.</span></div>}
        </div>
      </div>
      <div className="sheet-foot">
        {firstBad !== undefined && (
          <button type="button" className="foot-why" id="confirmWhy" onClick={goToBad}>
            <Icon name="alert" size="sm" />
            <span>مورد {toPersianDigits(firstBad + 1)}: {Object.values(errorsOf(firstBad))[0]}{bad.length > 1 ? ` (و ${toPersianDigits(bad.length - 1)} مورد دیگر)` : ''}</span>
          </button>
        )}
        <button className="btn primary" type="button" disabled={cards.length === 0 || bad.length > 0} aria-describedby={bad.length ? 'confirmWhy' : undefined} onClick={doConfirm}><Icon name="check" />تأیید و ثبت {toPersianDigits(cards.length)} مورد</button>
        <button className="btn" type="button" onClick={onClose}>بعداً</button>
        <span className="grow" />
        <button className="btn ghost danger" type="button" onClick={doReject}>{rejectArmed ? 'دوباره بزنید' : `رد کل ${item.kind === 'voice' ? 'ویس' : 'عکس'}`}</button>
      </div>
    </>
  );
}

// ---------- quick capture ----------

export function CaptureSheet({ open, onClose: close }: { open: boolean; onClose: () => void }) {
  const { capture } = useBook();
  const toast = useToast();
  const [recording, setRecording] = useState(false);
  const [seconds, setSeconds] = useState(0);
  const onClose = () => { setRecording(false); setSeconds(0); close(); };
  useEffect(() => {
    if (!recording) return;
    const t = setInterval(() => setSeconds((s) => s + 1), 1000);
    return () => clearInterval(t);
  }, [recording]);
  const send = (kind: 'voice' | 'receipt' | 'invoice') => {
    capture(kind);
    onClose();
    toast(kind === 'voice' ? 'ویس فرستاده شد؛ تا چند لحظهٔ دیگر در «منتظر تأیید» می‌آید' : 'فایل فرستاده شد؛ تا چند لحظهٔ دیگر در «منتظر تأیید» می‌آید');
  };
  return (
    <Sheet open={open} onClose={onClose}>
      <SheetHead icon="mic" kind="voice" title="ثبت سریع" onClose={onClose} />
      <div className="sheet-body">
        {!recording ? (
          <>
            <p className="muted">بگویید یا بفرستید؛ سیستم می‌فهمد و در «منتظر تأیید» می‌گذارد. همین کار از ربات بله هم می‌شود.</p>
            <div className="cap-opts">
              <button className="cap-opt" type="button" onClick={() => setRecording(true)}><span className="kind-ic voice"><Icon name="mic" /></span><div>ضبط ویس<span className="d">«امروز ۴ کارگر داشتیم…»</span></div></button>
              <label className="cap-opt"><span className="kind-ic receipt"><Icon name="camera" /></span><div>عکس رسید<span className="d">کارت به کارت، پایا، چک</span></div><input type="file" accept="image/*" onChange={(e) => e.target.files?.[0] && send('receipt')} /></label>
              <label className="cap-opt"><span className="kind-ic invoice"><Icon name="file" /></span><div>فاکتور یا سند<span className="d">عکس یا PDF</span></div><input type="file" accept="image/*,application/pdf" onChange={(e) => e.target.files?.[0] && send('invoice')} /></label>
            </div>
          </>
        ) : (
          <div className="rec-box">
            <div className="muted"><span className="rec-dot" />در حال ضبط (نمونه؛ هنوز صدا ضبط نمی‌شود)</div>
            <div className="rec-time num" role="timer">{toPersianDigits(Math.floor(seconds / 60))}:{seconds % 60 < 10 ? '۰' : ''}{toPersianDigits(seconds % 60)}</div>
            <div className="wave rec" aria-hidden="true">{Array.from({ length: 40 }, (_, i) => <i key={i} style={{ height: `${30 + ((i * 37) % 60)}%`, animationDelay: `${(i % 8) * 0.09}s` }} />)}</div>
            <button className="btn primary" type="button" autoFocus onClick={() => send('voice')}><Icon name="check" />پایان و ارسال</button>
          </div>
        )}
      </div>
    </Sheet>
  );
}

// ---------- transaction edit ----------

export function TxSheet({ tx, onClose }: { tx: Transaction | null; onClose: () => void }) {
  const [last, setLast] = useState(tx);
  if (tx && tx !== last) setLast(tx);
  return (
    <Sheet open={!!tx} onClose={onClose} returnFocus="#txTitle">
      {last && <TxBody key={last.id} tx={last} onClose={onClose} />}
    </Sheet>
  );
}

function TxBody({ tx, onClose }: { tx: Transaction; onClose: () => void }) {
  const { book, editTx, voidTx } = useBook();
  const toast = useToast();
  const o = useOptions();
  const [desc, setDesc] = useState(tx.description);
  const [amount, setAmount] = useState((tx.amountRial < 0n ? -tx.amountRial : tx.amountRial).toString());
  const [stage, setStage] = useState(tx.stageId ?? '');
  const [account, setAccount] = useState(tx.accountId);
  const [person, setPerson] = useState(tx.personId ?? '');
  const [on, setOn] = useState(tx.occurredOn);
  const [method, setMethod] = useState(tx.method ?? '');
  const [armed, arm] = useConfirmTap();
  const transfer = !!tx.transferId;
  const SRC: Record<Transaction['source'], string> = { voice: 'از ویس', receipt: 'از عکس رسید', invoice: 'از عکس فاکتور', manual: 'ثبت دستی' };
  const save = () => {
    if (!amount || BigInt(amount) <= 0n) { toast('مبلغ را بنویسید', undefined, 'error'); return; }
    const same = desc === tx.description && BigInt(amount) === (tx.amountRial < 0n ? -tx.amountRial : tx.amountRial) && account === tx.accountId
      && on === tx.occurredOn && (transfer || (stage === (tx.stageId ?? '') && person === (tx.personId ?? '') && method === (tx.method ?? '')));
    if (same) { onClose(); toast('تغییری نبود', undefined, 'info'); return; }
    try {
      editTx(tx.id, transfer
        ? { description: desc, amountRial: BigInt(amount), accountId: account, occurredOn: on }
        : { description: desc, amountRial: BigInt(amount), stageId: stage, accountId: account, personId: person, occurredOn: on, method });
      onClose(); toast('ذخیره شد و در تاریخچه آمد');
    } catch (e) { toast((e as Error).message, undefined, 'error'); }
  };
  const del = () => {
    if (!arm()) return;
    voidTx(tx.id, true); onClose();
    toast(transfer ? 'انتقال حذف شد (هر دو طرف)' : 'تراکنش حذف شد', { label: 'برگرداندن', run: () => voidTx(tx.id, false) });
  };
  return (
    <>
      <SheetHead icon={tx.source === 'voice' ? 'mic' : tx.source === 'manual' ? 'pen' : tx.source === 'receipt' ? 'camera' : 'file'} kind={tx.source === 'manual' ? 'voice' : tx.source}
        title={transfer ? 'ویرایش انتقال' : 'ویرایش تراکنش'} sub={`${SRC[tx.source]} · ${formatJalali(tx.occurredOn)}`} onClose={onClose} />
      <div className="sheet-body">
        <div className="pcard"><div className="fields">
          <Field label="شرح" wide>{(id) => <TextInput labelledBy={id} value={desc} onChange={setDesc} />}</Field>
          <Field label="مبلغ" error={!amount ? 'مبلغ را بنویسید' : undefined}>{(id) => <MoneyInput labelledBy={id} rial={amount} invalid={!amount} onChange={setAmount} />}</Field>
          <Field label="تاریخ">{(id) => <DatePicker labelledBy={id} title="تاریخ تراکنش" today={book.today} value={on} onChange={setOn} />}</Field>
          {!transfer && <Field label="طرف حساب">{(id) => <Dropdown labelledBy={id} options={[{ value: '', label: '—' }, ...o.people]} value={person} onChange={setPerson} />}</Field>}
          {!transfer && <Field label="روش پرداخت">{(id) => <Dropdown labelledBy={id} options={[{ value: '', label: '—' }, ...METHODS]} value={method} onChange={setMethod} />}</Field>}
          {!transfer && tx.isCost && <Field label="مرحله">{(id) => <Dropdown labelledBy={id} options={o.stages} value={stage} onChange={setStage} />}</Field>}
          <Field label={transfer ? (tx.amountRial < 0n ? 'از حساب' : 'به حساب') : 'حساب'}>{(id) => <Dropdown labelledBy={id} options={o.accounts} value={account} onChange={setAccount} />}</Field>
        </div></div>
        {transfer && <div className="effect"><span>این یک طرفِ انتقال بین حساب‌هاست؛ مبلغ و حذف روی هر دو طرف اعمال می‌شود.</span></div>}
        {tx.source !== 'manual' && <div className="effect"><span>منبع: {SRC[tx.source]}. فایل اصلی کنار همین تراکنش در بایگانی نگه داشته می‌شود.</span></div>}
        <div className="sec-title"><Icon name="clip" size="sm" />تاریخچه</div>
        <ol className="hist">{tx.history.map((h, i) => <li key={i}>{h}</li>)}</ol>
        <p className="why">موجودی فعلی این حساب: {formatToman(accountBalance(book, tx.accountId))}</p>
      </div>
      <div className="sheet-foot">
        <button className="btn primary" type="button" onClick={save}><Icon name="check" />ذخیرهٔ تغییرات</button>
        <button className="btn" type="button" onClick={onClose}>بستن</button>
        <span className="grow" />
        <button className="btn ghost danger" type="button" onClick={del}>{armed ? 'دوباره بزنید' : transfer ? 'حذف انتقال' : 'حذف تراکنش'}</button>
      </div>
    </>
  );
}

// ---------- add a stage ----------

const PHASES: Option[] = [
  { value: 'pre', label: 'پیش از ساخت', hint: 'مدارک، شهرداری، پروانه' },
  { value: 'build', label: 'ساخت', hint: 'از تجهیز کارگاه تا نما' },
  { value: 'finish', label: 'پایان کار', hint: 'انشعابات، گواهی‌ها، سند' },
];

export function AddStageSheet({ open, onClose, onAdded }: { open: boolean; onClose: () => void; onAdded?: (name: string) => void }) {
  // a fresh form each time it opens; kept mounted while it closes so it animates out
  const [round, setRound] = useState(0);
  const [wasOpen, setWasOpen] = useState(open);
  if (open !== wasOpen) { setWasOpen(open); if (open) setRound((r) => r + 1); }
  return (
    <Sheet open={open} onClose={onClose}>
      <AddStageBody key={round} onClose={onClose} onAdded={onAdded} />
    </Sheet>
  );
}

function AddStageBody({ onClose, onAdded }: { onClose: () => void; onAdded?: (name: string) => void }) {
  const { addStage } = useBook();
  const toast = useToast();
  const [name, setName] = useState('');
  const [phase, setPhase] = useState('build');
  const [budget, setBudget] = useState('');
  const [tried, setTried] = useState(false);
  const missing = !name.trim();
  const save = () => {
    setTried(true);
    if (missing) return;
    try {
      addStage({ name, phase: phase as 'pre' | 'build' | 'finish', budgetRial: budget ? BigInt(budget) : 0n });
      onAdded?.(name.trim()); onClose(); toast(`مرحلهٔ «${name.trim()}» اضافه شد`);
    } catch (e) { toast((e as Error).message, undefined, 'error'); }
  };
  return (
    <>
      <SheetHead icon="layers" kind="voice" title="مرحلهٔ جدید" sub="مثلاً «دیوار حائل» یا «سوله‌سازی»؛ بعد از آخرین مرحلهٔ همان بخش می‌نشیند" onClose={onClose} />
      <div className="sheet-body">
        <div className="pcard"><div className="fields">
          <Field label="نام مرحله" wide error={tried && missing ? 'نام مرحله را بنویسید' : undefined}>{(id) => <TextInput labelledBy={id} value={name} invalid={tried && missing} onChange={setName} />}</Field>
          <Field label="بخش">{(id) => <Dropdown labelledBy={id} options={PHASES} value={phase} onChange={setPhase} />}</Field>
          <Field label="برآورد هزینه (اختیاری)">{(id) => <MoneyInput labelledBy={id} rial={budget} onChange={setBudget} />}</Field>
        </div></div>
        <p className="why">این مرحله بدون گام و مدرکِ آماده ساخته می‌شود؛ افزودن گام‌ها و مدارک لازم به‌زودی ممکن می‌شود.</p>
      </div>
      <div className="sheet-foot">
        <button className="btn primary" type="button" onClick={save}><Icon name="plus" />افزودن مرحله</button>
        <button className="btn" type="button" onClick={onClose}>انصراف</button>
      </div>
    </>
  );
}
