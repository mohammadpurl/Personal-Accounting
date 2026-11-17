'use client';
// Building blocks shared by the pages, computed from the books. Motion handles panel entrances and scroll reveals;
// GSAP handles count-ups, the progress ring, the chart line and the stage bars.
import { useEffect, useLayoutEffect, useMemo, useRef, useState, type ReactNode } from 'react';
import { animate, stagger, useInView, useReducedMotion } from 'motion/react';
import gsap from 'gsap';
import { EASE, Icon } from './ui';
import { AddStageSheet } from './review';
import { useSheets } from './sheets-context';
import { ListToolbar, Pager, useList } from './table';
import Link from 'next/link';
import { useBook } from '@/state/book';
import { clearSearch, peekSearch } from '@/state/handoff';
import { spendBetween, stageSpent, type Transaction } from '@/lib/book';
import { formatShortToman, formatToman, rialToToman, toPersianDigits } from '@/lib/money';
import { normFa } from '@/lib/text';
import { formatJalali, isoToJalali, jalaliToIso, JALALI_MONTHS, monthLength } from '@/lib/jalali';

const M = 10_000_000n;

// ---------- panel with entrance motion (the glass slides; its content fades, never the glass itself) ----------

export function Panel({ id, className = '', labelledBy, top, index = 0, children }: { id?: string; className?: string; labelledBy?: string; top?: boolean; index?: number; children: ReactNode }) {
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
export function CountUp({ value, format, delay = 0 }: { value: number; format: (n: number) => string; delay?: number }) {
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
export const fmtToman = (n: number) => formatToman(BigInt(n) * 10n, { unit: false });
// hundredths of a million Toman, shown like the chart's totals (e.g. ۳۰۱٫۸۹)
export const fmtMillions = (n: number) => (n / 100).toLocaleString('fa-IR', { maximumFractionDigits: 1 });

// ---------- month helpers ----------

export function monthRange(jy: number, jm: number): [string, string] {
  return [jalaliToIso({ jy, jm, jd: 1 }), jalaliToIso({ jy, jm, jd: monthLength(jy, jm) })];
}
function lastMonths(today: string, n: number) {
  const t = isoToJalali(today);
  const out: { jy: number; jm: number }[] = [];
  for (let i = n - 1; i >= 0; i--) { let jm = t.jm - i, jy = t.jy; while (jm < 1) { jm += 12; jy--; } out.push({ jy, jm }); }
  return out;
}

// ---------- progress ring ----------

export function Ring({ pct, stage }: { pct: number; stage?: { name: string; progressPct: number } }) {
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

const PHASE = { pre: 'پیش از ساخت', build: 'ساخت', finish: 'پایان کار' } as const;

export function Stages({ mode = 'summary' }: { mode?: 'summary' | 'page' }) {
  const { book, projectId } = useBook();
  const stages = book.stages.filter((s) => s.ledgerId === projectId);
  const [allWanted, setAll] = useState(false);
  const [phase, setPhase] = useState<'all' | keyof typeof PHASE>('all');
  const all = mode === 'page' || allWanted;
  const filtered = stages.filter((s) => phase === 'all' || s.phase === phase);
  const list$ = useList(filtered, (s) => s.name, 10);
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
  const visible = mode === 'page' ? list$.slice : all ? stages : stages.slice(from, to);
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
          {mode === 'page'
            ? <button className="btn sm primary" type="button" onClick={() => setAdding(true)}><Icon name="plus" size="sm" />مرحلهٔ جدید</button>
            : <Link className="btn sm" href="/stages">همهٔ {toPersianDigits(stages.length)} مرحله</Link>}
        </div>
      </div>
      <p className="panel-sub">خرج واقعی در برابر برآورد هر مرحله، به میلیون تومان. گام‌ها و مدارک لازم هر مرحله به‌زودی همین‌جا باز می‌شوند.</p>
      {mode === 'page' && (
        <ListToolbar q={list$.q} onQ={list$.setQ} placeholder="نام مرحله" label="جستجو در مراحل"
          filters={[{ k: 'all', v: 'همه' }, { k: 'pre', v: PHASE.pre }, { k: 'build', v: PHASE.build }, { k: 'finish', v: PHASE.finish }]}
          filter={phase} onFilter={(k) => { setPhase(k as typeof phase); list$.setPage(1); }} />
      )}
      {mode === 'page' && visible.length === 0 && (
        <div className="empty"><Icon name="search" /><b>مرحله‌ای با «{list$.q}» پیدا نشد</b><button className="btn sm" type="button" onClick={() => { list$.setQ(''); setPhase('all'); }}>پاک کردن جستجو</button></div>
      )}
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
      {mode === 'page' && <Pager {...list$} noun="مرحله" />}
      <AddStageSheet open={adding} onClose={() => setAdding(false)}
        onAdded={(name) => { setAll(true); setPhase('all'); list$.setQ(''); const i = book.stages.filter((s) => s.ledgerId === projectId).length; list$.setPage(Math.ceil((i + 1) / 10)); setFresh(name); }} />
    </Panel>
  );
}

// ---------- transactions ----------

const norm = normFa;

export function Transactions() {
  const { book, projectId } = useBook();
  const { openTx: onOpen } = useSheets();
  const [q, setQ] = useState(peekSearch);
  const [f, setF] = useState<'all' | 'out' | 'in'>('all');
  const [page, setPage] = useState(1);
  const per = 8;
  useEffect(() => {
    // a page kept hidden from an earlier visit stops listening while hidden: pick up what was typed meanwhile
    const pending = peekSearch();
    clearSearch();
    if (pending) queueMicrotask(() => { setQ(pending); setPage(1); });
    const h = (e: Event) => { setQ((e as CustomEvent<string>).detail); setPage(1); clearSearch(); };
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
      .sort((a, b) => b.occurredOn.localeCompare(a.occurredOn));
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

export function Spark({ book, projectId }: { book: ReturnType<typeof useBook>['book']; projectId: string }) {
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

export function FlowChart() {
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
    const el = box.current;
    if (!el) return;
    // the element itself, not the ref: the observer can fire once more while the page is leaving
    const ro = new ResizeObserver(() => setW(Math.max(280, Math.round(el.clientWidth))));
    ro.observe(el);
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
