'use client';
// The assistant (دستیار): say, type or photograph what happened; it splits it into cards, says which page each one
// goes to, asks for what is missing, and nothing is recorded until the owner confirms. The same assistant answers
// in the Bale and Telegram bots. On this sample, typed Persian is understood with simple rules (lib/demo-parse).
import Link from 'next/link';
import { useEffect, useRef, useState } from 'react';
import { motion } from 'motion/react';
import { EASE, Icon, Sheet, SheetHead, useToast } from './ui';
import { CHANNEL, KIND_ICON } from './review';
import { useSheets } from './sheets-context';
import { cardHeadline, useBook, type CaptureKind } from '@/state/book';
import { validateDraft } from '@/lib/drafts';
import { templateOf } from '@/lib/templates';
import { transcriptText } from '@/lib/transcript';
import { toPersianDigits } from '@/lib/money';
import type { InboxItem } from '@/lib/book';

const EXAMPLES = ['work_log', 'cheque', 'payment'].map((k) => templateOf(k)?.examples[0] ?? '').filter(Boolean);

function Composer({ initialText = '', autoFocus, onSent, onNavigate }: { initialText?: string; autoFocus?: boolean; onSent?: () => void; onNavigate?: () => void }) {
  const { capture } = useBook();
  const toast = useToast();
  const [text, setText] = useState(initialText);
  const [recording, setRecording] = useState(false);
  const [seconds, setSeconds] = useState(0);
  const box = useRef<HTMLTextAreaElement>(null);
  useEffect(() => {
    if (!recording) return;
    const t = setInterval(() => setSeconds((s) => s + 1), 1000);
    return () => clearInterval(t);
  }, [recording]);
  const send = (kind: CaptureKind) => {
    if (kind === 'text' && !text.trim()) { box.current?.focus(); return; }
    capture(kind, kind === 'text' ? text.trim() : undefined);
    setText(''); setRecording(false); setSeconds(0);
    toast(kind === 'text' ? 'پیام فرستاده شد؛ تا چند لحظهٔ دیگر می‌گویم چه فهمیدم' : 'فرستاده شد؛ تا چند لحظهٔ دیگر می‌گویم چه فهمیدم');
    onSent?.();
  };
  const mmss = `${toPersianDigits(Math.floor(seconds / 60))}:${seconds % 60 < 10 ? '۰' : ''}${toPersianDigits(seconds % 60)}`;

  return (
    <div className="composer">
      {recording ? (
        <div className="rec-row" role="status">
          <span className="rec-dot" aria-hidden="true" />
          <span>در حال ضبط <span className="num">{mmss}</span> <span className="muted small">(نمونه؛ صدا ضبط نمی‌شود)</span></span>
          <span className="grow" />
          <button className="btn sm ghost" type="button" onClick={() => { setRecording(false); setSeconds(0); }}>لغو</button>
          <button className="btn sm primary" type="button" onClick={() => send('voice')}><Icon name="check" size="sm" />پایان و ارسال</button>
        </div>
      ) : (
        <>
          <label className="sr-only" htmlFor="assistantText">بگویید یا بنویسید چه شد</label>
          <div className="inp area compose-box">
            <textarea id="assistantText" ref={box} rows={2} value={text} data-autofocus-first={autoFocus || undefined}
              onFocus={(e) => { const n = e.target.value.length; e.target.setSelectionRange(n, n); }} placeholder="بگویید یا بنویسید چه شد؛ مثلاً «امروز پنج کارگر داشتیم، نفری یک میلیون و دویست، هنوز ندادم»"
              onChange={(e) => setText(e.target.value)}
              onKeyDown={(e) => { if (e.key === 'Enter' && !e.shiftKey && !e.nativeEvent.isComposing) { e.preventDefault(); send('text'); } }} />
          </div>
          <div className="compose-actions">
            <button className="btn primary mic-btn" type="button" onClick={() => setRecording(true)} aria-label="ضبط ویس"><Icon name="mic" /><span>ویس</span></button>
            <label className="btn file-btn"><Icon name="camera" size="sm" /><span>رسید یا فاکتور</span>
              <input type="file" accept="image/*,application/pdf" onChange={(e) => { if (e.target.files?.[0]) send('receipt'); e.target.value = ''; }} /></label>
            <label className="btn file-btn"><Icon name="receipt" size="sm" /><span>عکس چک</span>
              <input type="file" accept="image/*" onChange={(e) => { if (e.target.files?.[0]) send('cheque'); e.target.value = ''; }} /></label>
            <span className="grow" />
            <button className="btn send-btn" type="button" disabled={!text.trim()} onClick={() => send('text')}><Icon name="left" size="sm" />فرستادن</button>
          </div>
          <div className="examples" aria-label="نمونه">
            <span className="muted small">نمونه:</span>
            {EXAMPLES.map((x) => <button key={x} type="button" className="chip chip-btn" onClick={() => { setText(x); box.current?.focus(); }}>{x}</button>)}
            <Link className="small link" href="/guide" onClick={onNavigate}>همهٔ الگوها</Link>
          </div>
        </>
      )}
    </div>
  );
}

function Turn({ item, onNavigate }: { item: InboxItem; onNavigate?: () => void }) {
  const { book } = useBook();
  const { openReview } = useSheets();
  const said = item.text ?? (item.transcript ? transcriptText(item.transcript) : item.ocr) ?? '';
  const pending = item.drafts.filter((d) => d.status !== 'dropped');
  return (
    <motion.li className="turn" layout initial={{ opacity: 0, y: 12 }} animate={{ opacity: 1, y: 0 }} transition={{ duration: 0.4, ease: EASE }}>
      <div className="turn-in">
        <span className={`kind-ic ${item.kind}`}><Icon name={KIND_ICON[item.kind]} /></span>
        <div className="turn-body">
          <div className="t">{item.title} <span className="meta">{CHANNEL[item.channel]} · {item.receivedLabel}</span></div>
          {said && <p className="said">{said.length > 140 ? `${said.slice(0, 140)}…` : said}</p>}
        </div>
      </div>
      <div className="turn-out">
        {item.status === 'processing' && (
          <div className="thinking" aria-busy="true"><span className="dots" aria-hidden="true"><i /><i /><i /></span>در حال فهمیدن…</div>
        )}
        {item.status !== 'processing' && (
          <ul className="card-lines">
            {pending.map((d) => {
              const tpl = templateOf(d.kind);
              const v = validateDraft(d.kind, d.fields);
              const missing = !v.ok ? Object.values(v.errors)[0] : null;
              return (
                <li key={d.id}>
                  <span className={`pill ${tpl?.tone ?? 'info'}`}>{tpl?.label}</span>
                  <span className="headline">{cardHeadline(book, d.kind, d.fields)}</span>
                  {tpl && <Link className="dest" href={tpl.href} onClick={onNavigate}><Icon name="left" size="sm" />{tpl.page}</Link>}
                  {item.status === 'ready' && missing && <span className="ask"><Icon name="alert" size="sm" />{missing}</span>}
                </li>
              );
            })}
          </ul>
        )}
        {item.status === 'ready' && (
          <div className="turn-act">
            <span className="muted small">{toPersianDigits(pending.length)} مورد منتظر تأیید شماست</span>
            <button className="btn sm primary" type="button" onClick={() => openReview(item.id)}>بررسی و تأیید</button>
          </div>
        )}
        {item.status === 'confirmed' && <div className="turn-done pos"><Icon name="check" size="sm" />ثبت شد</div>}
        {item.status === 'rejected' && <div className="turn-done muted"><Icon name="x" size="sm" />رد شد؛ فایل اصلی در بایگانی است</div>}
      </div>
    </motion.li>
  );
}

export function AssistantThread({ limit, onNavigate }: { limit: number; onNavigate?: () => void }) {
  const { book } = useBook();
  const items = book.inbox.slice(0, limit);
  if (items.length === 0) return <p className="muted small">هنوز چیزی نفرستاده‌اید.</p>;
  return <ol className="thread" aria-live="polite">{items.map((i) => <Turn key={i.id} item={i} onNavigate={onNavigate} />)}</ol>;
}

/** The assistant on the dashboard: the box to talk in, and the latest few things it understood. */
export function AssistantPanel() {
  return (
    <>
      <Composer />
      <div className="sec-title"><Icon name="msg" size="sm" />آخرین گفت‌وگوها</div>
      <AssistantThread limit={2} />
      <Link className="btn sm ghost more-link" href="/archive">همهٔ ویس‌ها و عکس‌ها</Link>
    </>
  );
}

/** The assistant from any page: the top-bar button and the floating button open it. */
export function AssistantSheet({ open, initialText, round, onClose }: { open: boolean; initialText: string; round: number; onClose: () => void }) {
  return (
    <Sheet open={open} onClose={onClose}>
      <SheetHead icon="mic" kind="voice" title="دستیار" sub="بگویید چه شد؛ هر مورد به صفحهٔ خودش می‌رود و تا تأیید نکنید ثبت نمی‌شود" onClose={onClose} />
      <div className="sheet-body">
        <Composer key={round} initialText={initialText} autoFocus onNavigate={onClose} />
        <div className="sec-title"><Icon name="msg" size="sm" />آخرین گفت‌وگوها</div>
        <AssistantThread limit={5} onNavigate={onClose} />
      </div>
    </Sheet>
  );
}
