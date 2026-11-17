'use client';
// The dashboard is a live view only: the assistant to talk to, what needs attention now, what just happened,
// and a few key numbers. The detail of everything lives on its own page.
import Link from 'next/link';
import { motion } from 'motion/react';
import { EASE, Icon } from './ui';
import { AssistantPanel } from './assistant';
import { dueLabel } from './details';
import { AccountsPanel } from './pages';
import { CountUp, Panel, Ring, Spark, Stages, fmtMillions, monthRange } from './widgets';
import { useBook } from '@/state/book';
import { personOwed, projectSpent, spendBetween, stageSpent } from '@/lib/book';
import { formatShortToman, toPersianDigits } from '@/lib/money';
import { addDays, isoToJalali, jalaliToIso, JALALI_MONTHS, monthLength } from '@/lib/jalali';

const M = 10_000_000n;

interface Alert { key: string; icon: string; tone: 'neg' | 'warn' | 'accent' | 'info'; text: string; href: string; cta: string }

function useAttention(): Alert[] {
  const { book, projectId } = useBook();
  const out: Alert[] = [];
  const ready = book.inbox.filter((i) => i.status === 'ready').length;
  if (ready) out.push({ key: 'inbox', icon: 'inbox', tone: 'accent', text: `${toPersianDigits(ready)} ورودی منتظر تأیید شماست`, href: '/inbox', cta: 'بررسی' });
  const pending = book.cheques.filter((c) => c.ledgerId === projectId && !c.voided && c.status === 'pending');
  const late = pending.filter((c) => c.dueDate < book.today);
  const soon = pending.filter((c) => c.dueDate >= book.today && c.dueDate <= addDays(book.today, 7));
  for (const c of [...late, ...soon]) {
    const who = book.people.find((p) => p.id === c.personId)?.fullName ?? '';
    out.push({ key: c.id, icon: 'receipt', tone: c.dueDate < book.today ? 'neg' : 'warn', href: '/cheques', cta: 'چک‌ها',
      text: `چک ${formatShortToman(c.amountRial)} تومانی ${c.direction === 'issued' ? 'به' : 'از'} ${who}، سررسید ${dueLabel(c.dueDate, book.today)}${c.direction === 'issued' ? '؛ موجودی حساب را ببینید' : ''}` });
  }
  const bounced = book.cheques.filter((c) => c.ledgerId === projectId && !c.voided && c.status === 'bounced');
  const ours = bounced.filter((c) => c.direction === 'issued'), theirs = bounced.filter((c) => c.direction === 'received');
  if (ours.length) out.push({ key: 'bounced-ours', icon: 'alert', tone: 'neg', href: '/cheques', cta: 'پیگیری', text: `${toPersianDigits(ours.length)} چک صادرهٔ شما برگشت خورده؛ پیش از ثبت در سامانه تسویه کنید` });
  if (theirs.length) out.push({ key: 'bounced', icon: 'alert', tone: 'neg', href: '/cheques', cta: 'پیگیری', text: `${toPersianDigits(theirs.length)} چک دریافتی برگشت خورده و هنوز وصول نشده` });
  const crewOwed = book.people.filter((p) => p.kind === 'crew').reduce((s, p) => s + personOwed(book, projectId, p.id), 0n);
  if (crewOwed > 0n) out.push({ key: 'crew', icon: 'hat', tone: 'warn', href: '/workers', cta: 'کارکرد', text: `${formatShortToman(crewOwed)} تومان دستمزد کارگرها هنوز پرداخت نشده` });
  const over = book.stages.filter((s) => s.ledgerId === projectId && s.budgetRial > 0n && stageSpent(book, projectId, s.id) > s.budgetRial);
  for (const s of over) out.push({ key: s.id, icon: 'layers', tone: 'warn', href: '/stages', cta: 'مراحل', text: `خرج مرحلهٔ «${s.name}» از برآورد گذشته` });
  return out;
}

export function Dashboard() {
  const { book, projectId } = useBook();
  const alerts = useAttention();

  const t = isoToJalali(book.today);
  const [monthStart] = monthRange(t.jy, t.jm);
  const prev = t.jm === 1 ? { jy: t.jy - 1, jm: 12 } : { jy: t.jy, jm: t.jm - 1 };
  const prevStart = monthRange(prev.jy, prev.jm)[0];
  const prevSameDay = jalaliToIso({ ...prev, jd: Math.min(t.jd, monthLength(prev.jy, prev.jm)) });
  const monthSpend = spendBetween(book, projectId, monthStart, book.today);
  const prevSpend = spendBetween(book, projectId, prevStart, prevSameDay);
  const stages = book.stages.filter((s) => s.ledgerId === projectId);
  const totalBudget = stages.reduce((s, x) => s + x.budgetRial, 0n);
  const physical = totalBudget > 0n ? Math.round(stages.reduce((s, x) => s + Number(x.budgetRial / M) * x.progressPct, 0) / Number(totalBudget / M)) : 0;
  const spentAll = projectSpent(book, projectId);
  const financial = totalBudget > 0n ? Math.round(Number(spentAll * 100n / totalBudget)) : 0;
  const current = stages.find((s) => s.status === 'in_progress');

  return (
    <>
      <section className="grid-hero dash-hero">
        <Panel id="assistant" className="assistant-panel" labelledBy="assistantTitle" top index={0}>
          <div className="panel-head">
            <h2 id="assistantTitle" tabIndex={-1}><Icon name="mic" />دستیار</h2>
            <Link className="btn sm ghost" href="/guide">راهنمای ثبت</Link>
          </div>
          <p className="panel-sub">بگویید یا بنویسید چه شد؛ هر مورد به صفحهٔ خودش می‌رود. تا تأیید نکنید چیزی ثبت نمی‌شود.</p>
          <AssistantPanel />
        </Panel>

        <div className="hero-side">
          <Panel id="attention" labelledBy="attnTitle" top index={1}>
            <div className="panel-head">
              <h2 id="attnTitle"><Icon name="alert" />نیاز به توجه</h2>
              <span className={`pill num ${alerts.length ? 'warn' : 'pos'}`}>{alerts.length ? `${toPersianDigits(alerts.length)} مورد` : 'مرتب'}</span>
            </div>
            {alerts.length === 0 ? (
              <div className="empty"><Icon name="check" /><b>همه‌چیز مرتب است</b><span>چیزی منتظر شما نیست.</span></div>
            ) : (
              <ul className="alerts">
                {alerts.slice(0, 6).map((a) => (
                  <li key={a.key} className={`alert-row ${a.tone}`}>
                    <span className="a-ic"><Icon name={a.icon} size="sm" /></span>
                    <span className="a-t">{a.text}</span>
                    <Link className="btn sm" href={a.href}>{a.cta}</Link>
                  </li>
                ))}
              </ul>
            )}
          </Panel>
          <div className="kpi-pair">
            <Panel className="kpi" top index={2}>
              <div className="label"><Icon name="out" size="sm" />خرج {JALALI_MONTHS[t.jm - 1]} تا امروز</div>
              <div className="value num"><CountUp value={Math.round(Number(monthSpend) / 1e5)} format={fmtMillions} /><small>میلیون تومان</small></div>
              <Spark book={book} projectId={projectId} />
              <div className="foot"><span className="muted">{JALALI_MONTHS[prev.jm - 1]} تا همین روز</span><b className="num">{formatShortToman(prevSpend)} تومان</b></div>
            </Panel>
            <Panel className="kpi" top index={3}>
              <div className="label"><Icon name="layers" size="sm" />پیشرفت فیزیکی</div>
              <Ring pct={physical} stage={current} />
              <div className="foot">
                <span className="muted">پیشرفت مالی <b className="num" style={{ color: 'var(--fg)' }}>{toPersianDigits(financial)}٪</b></span>
                <span className="num muted">{formatShortToman(spentAll)} از {formatShortToman(totalBudget)} تومان</span>
              </div>
            </Panel>
          </div>
          <AccountsPanel index={4} />
        </div>
      </section>

      <section className="grid-2 dash-grid">
        <Panel id="activity" labelledBy="actTitle">
          <div className="panel-head">
            <h2 id="actTitle"><Icon name="clip" />کارهای اخیر</h2>
            <Link className="btn sm ghost" href="/archive">بایگانی</Link>
          </div>
          <ol className="feed">
            {book.activity.slice(0, 8).map((a, i) => (
              <motion.li key={a.id} className={`feed-row ${a.tone}`} layout initial={{ opacity: 0, x: 12 }} animate={{ opacity: 1, x: 0 }} transition={{ duration: 0.4, ease: EASE, delay: Math.min(i, 8) * 0.04 }}>
                <span className="dot" aria-hidden="true" />
                <div><span className="f-t">{a.text}</span><span className="muted small">{a.at}</span></div>
                {a.href && <Link className="f-go" href={a.href} aria-label="رفتن به صفحه"><Icon name="left" size="sm" /></Link>}
              </motion.li>
            ))}
          </ol>
        </Panel>
        <Stages />
      </section>
    </>
  );
}
