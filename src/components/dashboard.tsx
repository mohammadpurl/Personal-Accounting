'use client';
// The dashboard panels, computed from the books. Motion handles panel entrances and scroll reveals;
// GSAP handles count-ups, the progress ring, the chart line and the stage bars.
import { useEffect, useLayoutEffect, useMemo, useRef, useState, type ReactNode } from 'react';
import { animate, motion, stagger, useInView, useReducedMotion } from 'motion/react';
import gsap from 'gsap';
import { EASE, Icon, useToast } from './ui';
import { AddStageSheet, ReviewSheet, TxSheet } from './review';
import { useBook } from '@/state/book';
import { accountBalance, interLedgerOwed, personOwed, projectSpent, spendBetween, stageSpent, type Transaction } from '@/lib/book';
import { DOC_CATEGORIES } from '@/lib/drafts';
import { formatShortToman, formatToman, rialToToman, toPersianDigits } from '@/lib/money';
import { initialsFa, normFa } from '@/lib/text';
import { formatJalali, isoToJalali, jalaliToIso, JALALI_MONTHS, monthLength } from '@/lib/jalali';

const M = 10_000_000n;

// ---------- panel with entrance motion (the glass slides; its content fades, never the glass itself) ----------

function Panel({ id, className = '', labelledBy, top, index = 0, children }: { id?: string; className?: string; labelledBy?: string; top?: boolean; index?: number; children: ReactNode }) {
  const reduce = useReducedMotion();
  const box = useRef<HTMLElement>(null), inner = useRef<HTMLDivElement>(null);
  const seen = useInView(box, { once: true, amount: 0.12 });
  const go = !!top || seen;
  const delay = top ? 0.08 * index : 0;
  const [revealed, setRevealed] = useState(false);
  useEffect(() => {
    if (reduce || !go || !inner.current) return;
    const parts = Array.from(inner.current.children);
    if (box.current) {
      box.current.classList.remove('pre-move');
      animate(box.current, { y: [34, 0], scale: [0.965, 1] }, { duration: 0.85, ease: EASE, delay });
    }
    const a = animate(parts, { opacity: [0, 1], y: [12, 0] }, { duration: 0.55, ease: EASE, delay: stagger(0.06, { startDelay: delay + 0.15 }) });
    a.then(() => setRevealed(true));
    return () => a.stop();
  }, [go, reduce, delay]);
  const props = { id, className: `glass panel pre-move ${className}`, 'aria-labelledby': labelledBy };
  // same markup on the server and the client; with reduced motion the parts show at once (CSS) and nothing moves
  return (
    <article {...props} ref={box}>
      <div className={`panel-in${revealed ? '' : ' pre'}`} ref={inner}>{children}</div>
    </article>
  );
}

/** GSAP count-up for a number shown with Persian digits. */
function CountUp({ value, format, delay = 0 }: { value: number; format: (n: number) => string; delay?: number }) {
  const el = useRef<HTMLSpanElement>(null);
  const reduce = useReducedMotion();
  const first = useRef(true);
  useEffect(() => {
    if (!el.current) return;
    if (reduce || !first.current) { el.current.textContent = format(value); return; }
    first.current = false;
    const o = { v: 0 };
    const tw = gsap.to(o, { v: value, duration: 1.8, delay: 0.35 + delay, ease: 'power3.out', onUpdate: () => { if (el.current) el.current.textContent = format(Math.round(o.v)); } });
    return () => { tw.kill(); };
  }, [value, format, reduce, delay]);
  return <span ref={el}>{format(value)}</span>;
}
const fmtToman = (n: number) => formatToman(BigInt(n) * 10n, { unit: false });
// hundredths of a million Toman, shown like the chart's totals (e.g. ۳۰۱٫۸۹)
const fmtMillions = (n: number) => (n / 100).toLocaleString('fa-IR', { maximumFractionDigits: 1 });

// ---------- month helpers ----------

function monthRange(jy: number, jm: number): [string, string] {
  return [jalaliToIso({ jy, jm, jd: 1 }), jalaliToIso({ jy, jm, jd: monthLength(jy, jm) })];
}
function lastMonths(today: string, n: number) {
  const t = isoToJalali(today);
  const out: { jy: number; jm: number }[] = [];
  for (let i = n - 1; i >= 0; i--) { let jm = t.jm - i, jy = t.jy; while (jm < 1) { jm += 12; jy--; } out.push({ jy, jm }); }
  return out;
}

// ---------- dashboard ----------

export function Dashboard() {
  const { book, projectId } = useBook();
  const toast = useToast();
  const [review, setReview] = useState<string | null>(null);
  const [txOpen, setTxOpen] = useState<Transaction | null>(null);

  const projectAccounts = book.accounts.filter((a) => a.ledgerId === projectId);
  const personalAccounts = book.accounts.filter((a) => book.ledgers.find((l) => l.id === a.ledgerId)?.kind === 'personal');
  const projectTotal = projectAccounts.reduce((s, a) => s + accountBalance(book, a.id), 0n);

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

  // the owner's own capital is not a debt; what the project owes their personal ledger is shown separately
  const dealtWith = new Set([
    ...book.obligations.filter((o) => o.ledgerId === projectId && !o.voided).map((o) => o.personId),
    ...book.transactions.filter((x) => x.ledgerId === projectId && !x.voided && !x.isCost && !x.transferId && x.personId).map((x) => x.personId!),
  ]);
  const debts = book.people.filter((p) => p.kind !== 'partner' && dealtWith.has(p.id)).map((p) => ({ p, owed: personOwed(book, projectId, p.id) }))
    .sort((a, b) => (a.owed === 0n ? 1 : 0) - (b.owed === 0n ? 1 : 0) || (b.owed > a.owed ? 1 : b.owed < a.owed ? -1 : 0));
  const ownerDebt = book.ledgers.filter((l) => l.kind !== 'project').reduce((s, l) => s + interLedgerOwed(book, projectId, l.id), 0n);
  const totalDebt = debts.filter((x) => x.owed > 0n).reduce((s, x) => s + x.owed, 0n) + (ownerDebt > 0n ? ownerDebt : 0n);

  const ready = book.inbox.filter((i) => i.status === 'ready' || i.status === 'processing');
  const reviewItem = book.inbox.find((i) => i.id === review && i.status === 'ready') ?? null;

  return (
    <>
      <section className="grid-hero">
        <Panel id="inbox" labelledBy="inboxTitle" top index={0}>
          <div className="panel-head">
            <h2 id="inboxTitle" tabIndex={-1}><Icon name="inbox" />منتظر تأیید</h2>
            <span className="pill accent num">{ready.length ? `${toPersianDigits(ready.filter((i) => i.status === 'ready').length)} مورد` : 'خالی'}</span>
          </div>
          <p className="panel-sub">ویس، رسید و فاکتوری که از ربات بله یا همین صفحه فرستاده‌اید. تا تأیید نکنید، چیزی در حساب‌ها ثبت نمی‌شود.</p>
          <ul className="inbox-list">
            {ready.length === 0 && (
              <li className="empty"><Icon name="check" /><b>چیزی منتظر تأیید نیست</b><span>ویس یا عکس رسید بفرستید تا اینجا ظاهر شود.</span>
                <button className="btn sm primary" type="button" onClick={() => window.dispatchEvent(new Event('open-capture'))}><Icon name="mic" size="sm" />ثبت سریع</button></li>
            )}
            {ready.map((x) => x.status === 'processing' ? (
              <li key={x.id} className="inbox-item processing" aria-busy="true">
                <span className={`kind-ic ${x.kind}`}><Icon name={x.kind === 'voice' ? 'mic' : 'camera'} /></span>
                <div><div className="t">{x.title}<span className="sr-only">در حال پردازش</span></div><div className="meta">همین صفحه · {x.receivedLabel} · در حال بررسی…</div><div className="shimmer" /></div>
              </li>
            ) : (
              <motion.li key={x.id} className="inbox-item" layout initial={{ opacity: 0, y: 14 }} animate={{ opacity: 1, y: 0 }} transition={{ duration: 0.45, ease: EASE }}>
                <span className={`kind-ic ${x.kind}`}><Icon name={x.kind === 'voice' ? 'mic' : x.kind === 'receipt' ? 'camera' : 'file'} /></span>
                <div>
                  <div className="t">{x.title}{x.durationLabel && <span className="meta num">{x.durationLabel}</span>}</div>
                  <div className="meta">{x.channel === 'bale' ? 'ربات بله' : x.channel === 'telegram' ? 'ربات تلگرام' : 'همین صفحه'} · {x.receivedLabel}</div>
                  <div className="chips">{x.chips.map((c) => <span className="chip" key={c}>{c}</span>)}</div>
                </div>
                <button className="btn sm primary" type="button" onClick={() => setReview(x.id)}>بررسی و تأیید</button>
              </motion.li>
            ))}
          </ul>
        </Panel>

        <div className="hero-side">
          <Panel className="accounts" labelledBy="accTitle" top index={1}>
            <div className="panel-head">
              <h2 id="accTitle"><Icon name="wallet" />حساب‌ها</h2>
              <div className="panel-sub">موجودی پروژه <b className="num strong">{formatShortToman(projectTotal)}</b> تومان</div>
            </div>
            <div className="acc-grid">
              {[...projectAccounts, ...personalAccounts].map((a, i) => {
                const personal = a.ledgerId !== projectId;
                return (
                  <div key={a.id} className={`acc ${['a', 'b', 'c'][i % 3]}`}>
                    <div className="name">{a.name} <span className={`ledger${personal ? ' personal' : ''}`}>{personal ? 'شخصی' : 'پروژه'}</span></div>
                    <div className="kind">{a.detail}</div>
                    <div className="amt num"><CountUp value={Number(rialToToman(accountBalance(book, a.id)))} format={fmtToman} delay={0.12 * i} /> <small>تومان</small></div>
                  </div>
                );
              })}
            </div>
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
        </div>
      </section>

      <section className="grid-2">
        <Stages stages={stages} />
        <div className="col-stack">
          <Panel id="people" labelledBy="peopleTitle">
            <div className="panel-head">
              <h2 id="peopleTitle"><Icon name="users" />اشخاص و مانده حساب</h2>
              <div className="head-actions">
                <span className="pill neg num">بدهی پروژه: {formatShortToman(totalDebt)} تومان</span>
                <button className="btn sm ghost" type="button" onClick={() => toast('فهرست کامل اشخاص با جستجو به‌زودی اضافه می‌شود', undefined, 'info')}>همه</button>
              </div>
            </div>
            <ul className="people">
              {ownerDebt !== 0n && (
                <li className="person"><span className="avatar" aria-hidden="true">{initialsFa(book.ownerName)}</span>
                  <div className="who"><b>{book.ownerName} (شما)</b><span>{ownerDebt > 0n ? 'خرج پروژه از حساب شخصی' : 'پول پروژه در حساب شخصی'}</span></div>
                  <div className="bal">{ownerDebt > 0n
                    ? <><b className="num owe">{formatShortToman(ownerDebt)}</b><span className="muted">طلب دارید</span></>
                    : <><b className="num credit">{formatShortToman(-ownerDebt)}</b><span className="muted">به پروژه بدهکارید</span></>}</div></li>
              )}
              {debts.map(({ p, owed }) => (
                <li className="person" key={p.id}><span className="avatar" aria-hidden="true">{p.initials}</span><div className="who"><b>{p.fullName}</b><span>{p.roleTitle}</span></div>
                  <div className="bal">{owed > 0n
                    ? <><b className="num owe">{formatShortToman(owed)}</b><span className="muted">طلب دارد</span></>
                    : owed < 0n ? <><b className="num credit">{formatShortToman(-owed)}</b><span className="muted">پیش‌پرداخت ما</span></>
                    : <><span className="pill pos">تسویه</span></>}</div></li>
              ))}
            </ul>
          </Panel>
          <Panel id="notes" labelledBy="notesTitle">
            <div className="panel-head">
              <h2 id="notesTitle"><Icon name="check-board" />یادداشت‌های روزانه</h2>
              <span className="pill num">{toPersianDigits(book.dailyNotes.filter((n) => !n.voided).length)} یادداشت</span>
            </div>
            <p className="panel-sub">هر چیزی که در ویس بگویید و جای دیگری نداشته باشد، مثل نظر ناظر، اینجا ثبت می‌شود. ثبت بازدید ناظران با پیگیری به‌زودی اضافه می‌شود.</p>
            <div className="notes-list">
              {book.dailyNotes.filter((n) => !n.voided).length === 0 && (
                <div className="empty"><Icon name="msg" /><b>هنوز یادداشتی نیست</b><span>در ویس بگویید «یادداشت کن…» تا اینجا بیاید.</span></div>
              )}
              {book.dailyNotes.filter((n) => !n.voided).map((n) => (
                <div className="note" key={n.id}>
                  <div className="note-head"><span className="avatar" aria-hidden="true"><Icon name="msg" size="sm" /></span>
                    <div className="who"><b>{formatJalali(n.noteDate, { withYear: false })}</b><span>{book.stages.find((s) => s.id === n.stageId)?.name ?? 'کل پروژه'}</span></div></div>
                  <p>{n.body}</p>
                  <div className="src"><Icon name="mic" size="sm" />{n.draftId ? 'از ویس امروز' : 'از ویس'}</div>
                </div>
              ))}
            </div>
          </Panel>
        </div>
      </section>

      <Transactions onOpen={setTxOpen} />

      <section className="grid-2">
        <Panel labelledBy="flowTitle">
          <div className="panel-head">
            <h2 id="flowTitle"><Icon name="bars" />جریان پول پروژه</h2>
            <div className="legend"><span><i style={{ background: 'var(--accent)' }} />خرج</span><span><i className="dash" />واریز</span></div>
          </div>
          <p className="panel-sub">هفت ماه اخیر، به میلیون تومان</p>
          <FlowChart />
        </Panel>
        <Panel id="docs" labelledBy="docsTitle">
          <div className="panel-head">
            <h2 id="docsTitle"><Icon name="folder" />اسناد و نقشه‌ها</h2>
            <div className="head-actions">
              <button className="btn sm" type="button" onClick={() => toast('بارگذاری سند بعد از وصل شدن به سرور فعال می‌شود', undefined, 'info')}><Icon name="upload" size="sm" />بارگذاری</button>
              <button className="btn sm ghost" type="button" onClick={() => toast('کتابخانهٔ کامل اسناد با جستجو به‌زودی اضافه می‌شود', undefined, 'info')}>همه</button>
            </div>
          </div>
          <ul className="docs">
            {book.documents.filter((d) => !d.hidden).map((d) => (
              <li className="doc" key={d.id}>
                <span className={`ext${d.category === 'drawings' ? ' dwg' : d.status === 'awaiting_file' ? ' img' : ''}`}>{d.category === 'drawings' ? 'DWG' : d.status === 'awaiting_file' ? '…' : 'PDF'}</span>
                <div className="who"><b>{d.title}</b><span>{[DOC_CATEGORIES[d.category as keyof typeof DOC_CATEGORIES], ...d.meta.split(' · ')].map((part, i) => <span key={i} className={/[۰-۹0-9]/.test(part) ? 'nowrap' : undefined}>{i > 0 ? '، ' : ''}{part}</span>)}</span></div>
                <span className={`pill ${d.status === 'awaiting_file' ? 'warn' : d.status === 'executive' ? 'accent' : 'pos'}`}>
                  {d.status === 'awaiting_file' ? 'منتظر فایل' : d.status === 'executive' ? 'اجرایی' : 'مصوب'}
                </span>
              </li>
            ))}
          </ul>
        </Panel>
      </section>

      <ReviewSheet item={reviewItem} onClose={() => setReview(null)} />
      <TxSheet tx={txOpen} onClose={() => setTxOpen(null)} />
    </>
  );
}

// ---------- progress ring ----------

function Ring({ pct, stage }: { pct: number; stage?: { name: string; progressPct: number } }) {
  const circ = 2 * Math.PI * 42;
  const ring = useRef<SVGCircleElement>(null);
  const reduce = useReducedMotion();
  useEffect(() => {
    if (!ring.current || reduce) return;
    const tw = gsap.fromTo(ring.current, { attr: { 'stroke-dashoffset': circ } }, { attr: { 'stroke-dashoffset': circ * (1 - pct / 100) }, duration: 1.6, ease: 'power3.out', delay: 0.4 });
    return () => { tw.kill(); };
  }, [pct, circ, reduce]);
  return (
    <div className="ring-wrap">
      <div className="ring-num">
        <svg className="ring" viewBox="0 0 100 100" role="img" aria-label={`${toPersianDigits(pct)} درصد پیشرفت فیزیکی`}>
          <circle className="track" cx="50" cy="50" r="42" />
          <circle className="prog" ref={ring} cx="50" cy="50" r="42" strokeDasharray={circ} strokeDashoffset={circ * (1 - pct / 100)} />
        </svg>
        <b className="num" aria-hidden="true"><CountUp value={pct} format={(n) => `${toPersianDigits(n)}٪`} /></b>
      </div>
      <div><div className="strong">{stage ? `مرحلهٔ ${stage.name}` : 'هنوز شروع نشده'}</div><div className="muted small num">{stage ? `${toPersianDigits(stage.progressPct)}٪ از این مرحله انجام شده` : 'مرحله‌ای در جریان نیست'}</div></div>
    </div>
  );
}

// ---------- stages ----------

function Stages({ stages }: { stages: ReturnType<typeof useBook>['book']['stages'] }) {
  const { book, projectId } = useBook();
  const [all, setAll] = useState(false);
  const [adding, setAdding] = useState(false);
  const list = useRef<HTMLOListElement>(null);
  const reduce = useReducedMotion();
  const [fresh, setFresh] = useState<string | null>(null); // the stage just added: brought into view and lit briefly
  useEffect(() => {
    if (!fresh) return;
    const el = list.current?.querySelector<HTMLElement>(`[data-name="${CSS.escape(fresh)}"]`);
    const raf = requestAnimationFrame(() => el?.scrollIntoView({ block: 'center', behavior: reduce ? 'auto' : 'smooth' }));
    const t = setTimeout(() => setFresh(null), 2200);
    return () => { cancelAnimationFrame(raf); clearTimeout(t); };
  }, [fresh, reduce]);
  const live = stages.findIndex((s) => s.status === 'in_progress');
  const currentIdx = live >= 0 ? live : Math.max(0, stages.findIndex((s) => s.status !== 'done'));
  const from = Math.max(0, currentIdx - 2), to = Math.min(stages.length, currentIdx + 4);
  const visible = all ? stages : stages.slice(from, to);
  const folded = all ? 0 : from;
  useEffect(() => {
    if (reduce || !list.current) return;
    const fills = list.current.querySelectorAll('.fill');
    const io = new IntersectionObserver((en) => {
      if (en[0].isIntersecting) { gsap.from(fills, { scaleX: 0, duration: 1.2, ease: 'power3.out', stagger: 0.07 }); io.disconnect(); }
    }, { threshold: 0.15 });
    io.observe(list.current);
    return () => io.disconnect();
  }, [reduce]);
  return (
    <Panel id="stages" labelledBy="stagesTitle">
      <div className="panel-head">
        <h2 id="stagesTitle"><Icon name="layers" />مراحل ساخت</h2>
        <div className="head-actions">
          <button className="btn sm ghost" type="button" onClick={() => setAdding(true)}><Icon name="plus" size="sm" />مرحلهٔ جدید</button>
          <button className="btn sm" type="button" onClick={() => setAll((a) => !a)} aria-expanded={all} aria-controls="stagesList">{all ? 'خلاصه' : `همهٔ ${toPersianDigits(stages.length)} مرحله`}</button>
        </div>
      </div>
      <p className="panel-sub">خرج واقعی در برابر برآورد هر مرحله، به میلیون تومان.</p>
      <ol className="stages" ref={list} id="stagesList">
        {folded > 0 && (
          <li className="stage more">
            <button type="button" onClick={() => setAll(true)}>
              <span className="n"><Icon name="check" size="sm" /></span>
              <span>{toPersianDigits(folded)} مرحلهٔ پیشین{stages.slice(0, from).every((s) => s.status === 'done' || s.status === 'skipped') ? ' انجام شده' : ''}</span>
              <span className="muted small">دیدن همه</span>
            </button>
          </li>
        )}
        {visible.map((s) => {
          const spent = stageSpent(book, projectId, s.id);
          const over = s.budgetRial > 0n && spent > s.budgetRial;
          const ratio = s.budgetRial > 0n ? Math.min(100, Number(spent * 100n / s.budgetRial)) : 0;
          return (
            <li key={s.id} data-name={s.name} className={`stage ${s.status === 'in_progress' ? 'now' : s.status}${fresh === s.name ? ' just-added' : ''}`}>
              <span className="n num">{s.status === 'done' ? <Icon name="check" size="sm" /> : toPersianDigits(s.ord)}</span>
              <span className="nm">{s.name}</span>
              {s.status === 'done' ? <span className={`pill ${over ? 'warn' : 'pos'}`}>{over ? 'بیش از برآورد' : 'انجام شد'}</span>
                : s.status === 'in_progress' ? <span className="pill accent num">{toPersianDigits(s.progressPct)}٪ انجام</span>
                : <span className="muted small num">{s.budgetRial > 0n ? `برآورد ${toPersianDigits(Number(s.budgetRial / M))}` : 'بدون برآورد'}</span>}
              {(s.status !== 'todo' || spent > 0n) && s.budgetRial > 0n && (
                <div className="bar">
                  <div className="track"><div className={`fill${over ? ' over' : s.status === 'done' ? ' ok' : ''}`} style={{ width: `${ratio}%` }} /></div>
                  <span className="num">{toPersianDigits(Math.round(Number(spent / M)))} از {toPersianDigits(Number(s.budgetRial / M))}</span>
                </div>
              )}
            </li>
          );
        })}
      </ol>
      <AddStageSheet open={adding} onClose={() => setAdding(false)} onAdded={(name) => { setAll(true); setFresh(name); }} />
    </Panel>
  );
}

// ---------- transactions ----------

const norm = normFa;

function Transactions({ onOpen }: { onOpen: (t: Transaction) => void }) {
  const { book, projectId } = useBook();
  const [q, setQ] = useState('');
  const [f, setF] = useState<'all' | 'out' | 'in'>('all');
  const [page, setPage] = useState(1);
  const per = 5;
  useEffect(() => {
    const h = (e: Event) => { setQ((e as CustomEvent<string>).detail); setPage(1); document.getElementById('transactions')?.scrollIntoView({ behavior: 'smooth', block: 'start' }); };
    addEventListener('tx-search', h);
    return () => removeEventListener('tx-search', h);
  }, []);
  const name = (id?: string) => book.people.find((p) => p.id === id)?.fullName ?? '—';
  const stageName = (id?: string) => book.stages.find((s) => s.id === id)?.name ?? 'هزینهٔ عمومی';
  const accName = (id: string) => book.accounts.find((a) => a.id === id)?.name ?? '';
  const rows = useMemo(() => {
    const term = norm(q.trim());
    const digits = term.replace(/[,٬،\s]/g, '');
    const byAmount = /^\d+$/.test(digits);
    return book.transactions
      .filter((t) => !t.voided && (t.ledgerId === projectId))
      // money in / money out of an account; both legs of a transfer show, each on its side
      .filter((t) => f === 'all' || (f === 'in' ? t.amountRial > 0n : t.amountRial < 0n))
      .filter((t) => {
        if (!term) return true;
        if (byAmount) return rialToToman(t.amountRial < 0n ? -t.amountRial : t.amountRial).toString().includes(digits);
        return norm(`${t.description} ${name(t.personId)} ${stageName(t.stageId)} ${accName(t.accountId)}`).includes(term);
      })
      .sort((a, b) => (a.occurredOn < b.occurredOn ? 1 : -1));
  }, [book, projectId, f, q]); // eslint-disable-line react-hooks/exhaustive-deps
  const pages = Math.max(1, Math.ceil(rows.length / per));
  const p = Math.min(page, pages);
  const slice = rows.slice((p - 1) * per, p * per);
  const SRC: Record<Transaction['source'], string> = { voice: 'از ویس', receipt: 'از عکس رسید', invoice: 'از عکس فاکتور', manual: 'ثبت دستی' };

  return (
    <Panel id="transactions" labelledBy="txTitle">
      <div className="panel-head">
        <h2 id="txTitle" tabIndex={-1}><Icon name="swap" />واریز و برداشت</h2>
        <div className="tx-tools">
          <div className="seg" role="group" aria-label="نوع تراکنش">
            {(['all', 'out', 'in'] as const).map((k) => (
              <button key={k} type="button" aria-pressed={f === k} onClick={() => { setF(k); setPage(1); }}>{k === 'all' ? 'همه' : k === 'out' ? 'برداشت' : 'واریز'}</button>
            ))}
          </div>
          <label className="top-search tx-search">
            <Icon name="search" size="sm" /><span className="sr-only">جستجو در تراکنش‌ها</span>
            <input type="search" placeholder="شرح، شخص، مرحله یا مبلغ" value={q} onChange={(e) => { setQ(e.target.value); setPage(1); }} />
            {q && <button type="button" className="clear-btn" aria-label="پاک کردن" onClick={() => setQ('')}><Icon name="x" size="sm" /></button>}
          </label>
        </div>
      </div>
      <p className="panel-sub">روی شرح هر ردیف بزنید تا ویرایشش کنید، منبعش را ببینید و تاریخچهٔ تغییراتش را بخوانید.</p>
      {rows.length === 0 ? (
        <div className="empty"><Icon name="search" /><b>{q ? `تراکنشی با «${q}» پیدا نشد` : 'در این فیلتر تراکنشی نیست'}</b><span>عبارت دیگری بنویسید یا فیلتر را بردارید.</span>
          <button className="btn sm" type="button" onClick={() => { setQ(''); setF('all'); }}>پاک کردن جستجو</button></div>
      ) : (
        <>
          <table className="tbl">
            <thead><tr><th>شرح</th><th>تاریخ</th><th>طرف حساب</th><th>مرحله</th><th>حساب</th><th className="amt">مبلغ (تومان)</th></tr></thead>
            <tbody>
              {slice.map((t) => {
                const k = t.transferId ? 'tr' : t.amountRial > 0n ? 'in' : 'out';
                return (
                  <tr key={t.id}>
                    <td className="first"><button type="button" className="tx-open" onClick={() => onOpen(t)}><span className={`dir ${k}`}><Icon name={k === 'tr' ? 'swap' : k} size="sm" /></span><span className="tx-t"><b>{t.description}</b><small>{SRC[t.source]}</small></span></button></td>
                    <td data-label="تاریخ" className="num">{formatJalali(t.occurredOn, { withYear: false })}</td>
                    <td data-label="طرف حساب">{name(t.personId)}</td>
                    <td data-label="مرحله">{t.transferId || !t.isCost ? '—' : stageName(t.stageId)}</td>
                    <td data-label="حساب">{accName(t.accountId)}</td>
                    <td data-label="مبلغ (تومان)" className={`amt num${k === 'tr' ? ' tr' : k === 'in' ? ' in' : ''}`}>
                      <span className="ltr">{formatToman(t.amountRial, { unit: false, sign: k === 'in' }).replace('−', k === 'tr' ? '' : '−')}</span>
                      {k === 'tr' && <small>انتقال داخلی</small>}
                    </td>
                  </tr>
                );
              })}
            </tbody>
          </table>
          <div className="pager">
            <span className="num">{toPersianDigits((p - 1) * per + 1)} تا {toPersianDigits((p - 1) * per + slice.length)} از {toPersianDigits(rows.length)} تراکنش</span>
            <div className="pages">
              <button type="button" disabled={p === 1} aria-label="صفحهٔ قبل" onClick={() => setPage(p - 1)}><Icon name="right" size="sm" /></button>
              {Array.from({ length: pages }, (_, i) => i + 1).filter((n) => n === 1 || n === pages || Math.abs(n - p) <= 1).map((n, i, arr) => (
                <span key={n} style={{ display: 'contents' }}>
                  {i > 0 && n - arr[i - 1] > 1 && <span aria-hidden="true" className="muted">…</span>}
                  <button type="button" className="num" aria-label={`صفحهٔ ${toPersianDigits(n)}`} aria-current={n === p ? 'page' : undefined} onClick={() => setPage(n)}>{toPersianDigits(n)}</button>
                </span>
              ))}
              <button type="button" disabled={p === pages} aria-label="صفحهٔ بعد" onClick={() => setPage(p + 1)}><Icon name="left" size="sm" /></button>
            </div>
          </div>
        </>
      )}
    </Panel>
  );
}

// ---------- charts ----------

function useSeries() {
  const { book, projectId } = useBook();
  return useMemo(() => {
    const months = lastMonths(book.today, 7);
    const projectAccounts = new Set(book.accounts.filter((a) => a.ledgerId === projectId).map((a) => a.id));
    return months.map(({ jy, jm }) => {
      const [a, b] = monthRange(jy, jm);
      const outRial = spendBetween(book, projectId, a, b);
      const inRial = book.transactions.filter((t) => !t.voided && !t.transferId && t.amountRial > 0n && projectAccounts.has(t.accountId) && t.occurredOn >= a && t.occurredOn <= b)
        .reduce((s, t) => s + t.amountRial, 0n);
      // millions with one decimal for drawing; exact Rial kept for totals
      return { label: JALALI_MONTHS[jm - 1], out: Math.round(Number(outRial) / 1e6) / 10, inn: Math.round(Number(inRial) / 1e6) / 10, outRial, inRial };
    });
  }, [book, projectId]);
}

function smooth(points: [number, number][]) {
  let d = `M${points[0][0]},${points[0][1]}`;
  for (let i = 1; i < points.length; i++) { const [x0, y0] = points[i - 1], [x1, y1] = points[i], cx = (x0 + x1) / 2; d += ` C${cx},${y0} ${cx},${y1} ${x1},${y1}`; }
  return d;
}

function Spark({ book, projectId }: { book: ReturnType<typeof useBook>['book']; projectId: string }) {
  void book; void projectId;
  const series = useSeries();
  const line = useRef<SVGPathElement>(null), area = useRef<SVGPathElement>(null);
  const reduce = useReducedMotion();
  const max = Math.max(...series.map((s) => s.out), 1);
  const pts = series.map((s, i) => [200 - (i * 200) / (series.length - 1), 44 - (s.out / max) * 40] as [number, number]);
  const d = smooth(pts);
  useEffect(() => {
    if (reduce || !line.current) return;
    const len = line.current.getTotalLength();
    const tl = gsap.timeline({ delay: 0.5 })
      .fromTo(line.current, { strokeDasharray: len, strokeDashoffset: len }, { strokeDashoffset: 0, duration: 1.4, ease: 'power2.inOut', clearProps: 'strokeDasharray,strokeDashoffset' })
      .from(area.current, { opacity: 0, duration: 0.8, ease: 'power1.out' }, '-=0.6');
    return () => { tl.kill(); };
  }, [reduce]);
  return (
    <svg className="spark" viewBox="0 0 200 48" preserveAspectRatio="none" aria-hidden="true">
      <defs><linearGradient id="sparkFillR" x1="0" y1="0" x2="0" y2="1"><stop offset="0" style={{ stopColor: 'var(--accent)' }} stopOpacity=".3" /><stop offset="1" style={{ stopColor: 'var(--accent)' }} stopOpacity="0" /></linearGradient></defs>
      <path ref={area} d={`${d} L0,48 L200,48 Z`} fill="url(#sparkFillR)" />
      <path className="line" ref={line} d={d} />
    </svg>
  );
}

function FlowChart() {
  const series = useSeries();
  const box = useRef<HTMLDivElement>(null), tip = useRef<HTMLDivElement>(null);
  const outLine = useRef<SVGPathElement>(null), inLine = useRef<SVGPathElement>(null), areaFill = useRef<SVGPathElement>(null);
  const reduce = useReducedMotion();
  const [W, setW] = useState(600);
  const [hover, setHover] = useState<number | null>(null);
  const [kb, setKb] = useState(series.length - 1);
  const [lastShown, setLastShown] = useState(series.length - 1);
  if (hover !== null && hover !== lastShown) setLastShown(hover); // the tooltip keeps its month while it fades out
  useEffect(() => {
    if (!box.current) return;
    const ro = new ResizeObserver(() => setW(Math.max(280, Math.round(box.current!.clientWidth))));
    ro.observe(box.current);
    return () => ro.disconnect();
  }, []);
  useEffect(() => {
    if (reduce || !outLine.current || !box.current) return;
    const io = new IntersectionObserver((en) => {
      if (!en[0].isIntersecting || !outLine.current) return;
      const len = outLine.current.getTotalLength();
      gsap.timeline()
        .fromTo(outLine.current, { strokeDasharray: len, strokeDashoffset: len }, { strokeDashoffset: 0, duration: 1.6, ease: 'power2.inOut', clearProps: 'strokeDasharray,strokeDashoffset' })
        .from([areaFill.current, inLine.current], { opacity: 0, duration: 0.8, ease: 'power1.out', stagger: 0.15 }, '-=0.8');
      io.disconnect();
    }, { threshold: 0.3 });
    io.observe(box.current);
    return () => io.disconnect();
  }, [reduce]);
  const narrow = W < 480, H = narrow ? 210 : 250;
  const G = { L: 10, R: W - 40, T: 14, B: H - 38 };
  const max = Math.max(600, Math.ceil(Math.max(...series.flatMap((s) => [s.out, s.inn])) / 200) * 200);
  const X = (i: number) => G.R - (i * (G.R - G.L)) / (series.length - 1);
  const Y = (v: number) => G.B - (v / max) * (G.B - G.T);
  const outD = smooth(series.map((s, i) => [X(i), Y(s.out)]));
  const inD = smooth(series.map((s, i) => [X(i), Y(s.inn)]));
  const ticks = Array.from({ length: max / 200 + 1 }, (_, i) => i * 200);
  const show = lastShown;
  const pick = (clientX: number) => {
    const r = box.current!.getBoundingClientRect();
    const vx = ((clientX - r.left) / r.width) * W;
    let best = 0; series.forEach((_, i) => { if (Math.abs(X(i) - vx) < Math.abs(X(best) - vx)) best = i; });
    setHover(best);
  };
  const totalOut = series.reduce((s, x) => s + x.outRial, 0n), totalIn = series.reduce((s, x) => s + x.inRial, 0n);
  return (
    <>
      <div className={`chart-box${hover !== null ? ' hover' : ''}`} ref={box}>
        <svg className="chart" direction="ltr" viewBox={`0 0 ${W} ${H}`} role="img" aria-label="نمودار خرج و واریز هفت ماه اخیر" tabIndex={0}
          onPointerMove={(e) => pick(e.clientX)} onPointerDown={(e) => pick(e.clientX)} onPointerLeave={() => setHover(null)}
          onFocus={() => setHover(kb)} onBlur={() => setHover(null)}
          onKeyDown={(e) => {
            if (e.key === 'ArrowLeft') { e.preventDefault(); const n = Math.min(series.length - 1, kb + 1); setKb(n); setHover(n); }
            if (e.key === 'ArrowRight') { e.preventDefault(); const n = Math.max(0, kb - 1); setKb(n); setHover(n); }
          }}>
          <defs><linearGradient id="areaFillR" x1="0" y1="0" x2="0" y2="1"><stop offset="0" style={{ stopColor: 'var(--accent)' }} stopOpacity=".35" /><stop offset="1" style={{ stopColor: 'var(--accent)' }} stopOpacity="0" /></linearGradient></defs>
          {ticks.map((v) => <g key={v}><line className="gl" x1={G.L} x2={G.R} y1={Y(v)} y2={Y(v)} /><text className="tick" x={W - 2} y={Y(v) + 4} textAnchor="end">{toPersianDigits(v)}</text></g>)}
          {series.map((s, i) => (narrow && i % 2 === 1 ? null : <text key={s.label} className="tick" x={X(i)} y={H - 12} textAnchor={i === 0 ? 'end' : i === series.length - 1 ? 'start' : 'middle'}>{s.label}</text>))}
          <path ref={areaFill} d={`${outD} L${X(series.length - 1)},${G.B} L${X(0)},${G.B} Z`} fill="url(#areaFillR)" />
          <path ref={inLine} className="inn" d={inD} />
          <path className="out" ref={outLine} d={outD} />
          <line className="guide" x1={X(show)} x2={X(show)} y1={G.T} y2={G.B} />
          <circle className="pt n" r="5" cx={X(show)} cy={Y(series[show].inn)} />
          <circle className="pt o" r="6" cx={X(show)} cy={Y(series[show].out)} />
        </svg>
        <ChartTip ref={tip} x={X(show)} top={Y(Math.max(series[show].out, series[show].inn))} bottom={Y(Math.min(series[show].out, series[show].inn))} W={W} H={H}>
          <b>{series[show].label}</b>
          <div><span>خرج</span><span className="num">{formatShortToman(series[show].outRial)}</span></div>
          <div><span>واریز</span><span className="num">{formatShortToman(series[show].inRial)}</span></div>
          <div><span>خالص</span><span className="num" style={{ color: `var(${series[show].inRial >= series[show].outRial ? '--pos' : '--neg'})` }}>{signedShort(series[show].inRial - series[show].outRial)}</span></div>
        </ChartTip>
      </div>
      <div className="chart-sum">
        <div><span>جمع خرج</span><b className="num">{formatShortToman(totalOut)}</b></div>
        <div><span>جمع واریز</span><b className="num">{formatShortToman(totalIn)}</b></div>
        <div><span>پرخرج‌ترین ماه</span><b>{series.reduce((a, b) => (b.out > a.out ? b : a)).label}</b></div>
      </div>
    </>
  );
}

/** «+۱۲٫۵ میلیون»: only the signed number is left-to-right, the unit stays in the Persian flow. */
function signedShort(rial: bigint) {
  const [num, ...unit] = formatShortToman(rial < 0n ? -rial : rial).split(' ');
  return <><span className="ltr">{rial < 0n ? '−' : '+'}{num}</span>{unit.length ? ` ${unit.join(' ')}` : ''}</>;
}

/** The tooltip measures itself: above the month's highest point; when there is no room above, beside the
 *  guide line (the points sit on that line, so a tooltip next to it never covers them). */
function ChartTip({ ref, x, top, bottom, W, H, children }: { ref: React.RefObject<HTMLDivElement | null>; x: number; top: number; bottom: number; W: number; H: number; children: ReactNode }) {
  useLayoutEffect(() => {
    const el = ref.current;
    if (!el) return;
    const w = el.offsetWidth, h = el.offsetHeight, gap = 14;
    let left = Math.max(0, Math.min(W - w, x - w / 2));
    let y = top - h - gap;
    if (y < 0) {
      left = x - w - gap >= 0 ? x - w - gap : Math.min(W - w, x + gap);
      y = Math.max(0, Math.min(H - h, (top + bottom) / 2 - h / 2));
    }
    el.style.transform = `translate(${left}px, ${y}px)`;
  });
  return <div className="tip" ref={ref} aria-hidden="true">{children}</div>;
}
