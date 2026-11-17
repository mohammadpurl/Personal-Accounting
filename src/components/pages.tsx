'use client';
// One page per kind of work. Every list has search, filters where they help, pagination and an empty state;
// on phones the tables become one card per row.
import Link from 'next/link';
import { useMemo, useState } from 'react';
import { motion } from 'motion/react';
import { Dropdown, EASE, Icon, useToast } from './ui';
import { CHANNEL, KIND_ICON } from './review';
import { CHEQUE_STATUS, dueLabel, inboxStatus } from './details';
import { useSheets } from './sheets-context';
import { DataTable, EmptyState, ListToolbar, Pager, useList } from './table';
import { CountUp, FlowChart, Panel, Stages, Transactions, fmtToman } from './widgets';
import { useBook } from '@/state/book';
import { accountBalance, interLedgerOwed, personOwed, type Cheque, type DocumentRec, type InboxItem, type Person, type WorkLog } from '@/lib/book';
import { DOC_CATEGORIES } from '@/lib/drafts';
import { TEMPLATES } from '@/lib/templates';
import { transcriptText } from '@/lib/transcript';
import { formatShortToman, formatToman, rialToToman, toPersianDigits } from '@/lib/money';
import { addDays, formatJalali } from '@/lib/jalali';
import { includesFa, initialsFa } from '@/lib/text';

function Head({ id, icon, title, children, sub }: { id: string; icon: string; title: string; children?: React.ReactNode; sub?: string }) {
  return (
    <>
      <div className="panel-head">
        <h2 id={id} tabIndex={-1}><Icon name={icon} />{title}</h2>
        {children && <div className="head-actions">{children}</div>}
      </div>
      {sub && <p className="panel-sub">{sub}</p>}
    </>
  );
}

// ---------- inbox ----------

export function InboxPage() {
  const { book } = useBook();
  const { openReview, openAssistant } = useSheets();
  const items = book.inbox.filter((i) => i.status === 'ready' || i.status === 'processing');
  const l = useList(items, (i) => `${i.title} ${i.chips.join(' ')} ${i.text ?? ''} ${i.ocr ?? ''} ${i.transcript ? transcriptText(i.transcript) : ''}`, 6);
  return (
    <Panel labelledBy="inboxTitle" top>
      <Head id="inboxTitle" icon="inbox" title="منتظر تأیید" sub="ویس، رسید، چک و پیامی که از ربات یا همین سایت فرستاده‌اید. تا تأیید نکنید، چیزی ثبت نمی‌شود.">
        <span className="pill accent num">{toPersianDigits(items.filter((i) => i.status === 'ready').length)} مورد</span>
      </Head>
      <ListToolbar q={l.q} onQ={l.setQ} placeholder="متن ویس، نام یا مبلغ" label="جستجو در موارد منتظر" />
      {items.length === 0 ? (
        <EmptyState icon="check" title="چیزی منتظر تأیید نیست" text="ویس یا عکس رسید بفرستید تا اینجا ظاهر شود."
          action={<button className="btn sm primary" type="button" onClick={() => openAssistant()}><Icon name="mic" size="sm" />دستیار</button>} />
      ) : l.total === 0 ? (
        <EmptyState title={`موردی با «${l.q}» پیدا نشد`} action={<button className="btn sm" type="button" onClick={() => l.setQ('')}>پاک کردن جستجو</button>} />
      ) : (
        <ul className="inbox-list">
          {l.slice.map((x) => x.status === 'processing' ? (
            <li key={x.id} className="inbox-item processing" aria-busy="true">
              <span className={`kind-ic ${x.kind}`}><Icon name={KIND_ICON[x.kind]} /></span>
              <div><div className="t">{x.title}<span className="sr-only">در حال پردازش</span></div><div className="meta">{CHANNEL[x.channel]} · {x.receivedLabel} · در حال بررسی…</div><div className="shimmer" /></div>
            </li>
          ) : (
            <motion.li key={x.id} className="inbox-item" layout initial={{ opacity: 0, y: 14 }} animate={{ opacity: 1, y: 0 }} transition={{ duration: 0.45, ease: EASE }}>
              <span className={`kind-ic ${x.kind}`}><Icon name={KIND_ICON[x.kind]} /></span>
              <div>
                <div className="t">{x.title}{x.durationLabel && <span className="meta num">{x.durationLabel}</span>}</div>
                <div className="meta">{CHANNEL[x.channel]} · {x.receivedLabel}</div>
                <div className="chips">{x.chips.map((c) => <span className="chip" key={c}>{c}</span>)}</div>
              </div>
              <button className="btn sm primary" type="button" onClick={() => openReview(x.id)}>بررسی و تأیید</button>
            </motion.li>
          ))}
        </ul>
      )}
      <Pager {...l} noun="مورد" />
    </Panel>
  );
}

// ---------- accounts & transactions ----------

export function AccountsPanel({ index = 0 }: { index?: number }) {
  const { book, projectId } = useBook();
  const projectAccounts = book.accounts.filter((a) => a.ledgerId === projectId);
  const personalAccounts = book.accounts.filter((a) => book.ledgers.find((l) => l.id === a.ledgerId)?.kind === 'personal');
  const projectTotal = projectAccounts.reduce((s, a) => s + accountBalance(book, a.id), 0n);
  return (
    <Panel className="accounts" labelledBy="accTitle" top index={index}>
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
  );
}

export function TransactionsPage() {
  return (
    <>
      <AccountsPanel />
      <Transactions />
      <Panel labelledBy="flowTitle">
        <div className="panel-head">
          <h2 id="flowTitle"><Icon name="bars" />جریان پول پروژه</h2>
          <div className="legend"><span><i style={{ background: 'var(--accent)' }} />خرج</span><span><i className="dash" />واریز</span></div>
        </div>
        <p className="panel-sub">هفت ماه اخیر، به میلیون تومان</p>
        <FlowChart />
      </Panel>
    </>
  );
}

// ---------- cheques ----------

export function ChequesPage() {
  const { book, projectId } = useBook();
  const { openCheque, openAssistant } = useSheets();
  const [f, setF] = useState<'all' | 'pending' | 'issued' | 'received'>('pending');
  const name = (id: string) => book.people.find((p) => p.id === id)?.fullName ?? '—';
  const all = book.cheques.filter((c) => c.ledgerId === projectId && !c.voided).sort((a, b) => a.dueDate.localeCompare(b.dueDate));
  const rows = all.filter((c) => f === 'all' || (f === 'pending' ? c.status === 'pending' : c.direction === f));
  const l = useList(rows, (c) => `${name(c.personId)} ${c.description} ${c.bank ?? ''} ${c.sayadNo ?? ''} ${rialToToman(c.amountRial)}`, 8);
  const pending = all.filter((c) => c.status === 'pending');
  const sum = (d: Cheque['direction']) => pending.filter((c) => c.direction === d).reduce((s, c) => s + c.amountRial, 0n);
  const week = pending.filter((c) => c.dueDate <= addDays(book.today, 7));
  return (
    <>
      <section className="kpi-row">
        <Panel className="kpi" top index={0}><div className="label"><Icon name="out" size="sm" />چک‌های صادره در جریان</div><div className="value num">{formatShortToman(sum('issued'))}<small>تومان</small></div><div className="foot muted">تا پاس نشوند از حساب کم نمی‌شوند</div></Panel>
        <Panel className="kpi" top index={1}><div className="label"><Icon name="in" size="sm" />چک‌های دریافتی در جریان</div><div className="value num">{formatShortToman(sum('received'))}<small>تومان</small></div><div className="foot muted">تا وصول نشوند به حساب نمی‌آیند</div></Panel>
        <Panel className="kpi" top index={2}><div className="label"><Icon name="calendar" size="sm" />سررسید تا یک هفتهٔ دیگر</div><div className="value num">{toPersianDigits(week.length)}<small>چک</small></div><div className="foot muted">{week.length ? `نزدیک‌ترین: ${name(week[0].personId)}، ${dueLabel(week[0].dueDate, book.today)}` : 'چکی نزدیک سررسید نیست'}</div></Panel>
      </section>
      <Panel labelledBy="chequeTitle">
        <Head id="chequeTitle" icon="receipt" title="چک‌ها" sub="روی هر چک بزنید تا پاس شدن، وصول، برگشت یا ابطالش را ثبت کنید. چک تازه را با عکسش به دستیار بدهید.">
          <button className="btn sm primary" type="button" onClick={() => openAssistant('یک چک صادر کردم به ')}><Icon name="plus" size="sm" />چک تازه</button>
        </Head>
        <ListToolbar q={l.q} onQ={l.setQ} placeholder="نام، بانک، شمارهٔ صیادی یا مبلغ" label="جستجو در چک‌ها"
          filters={[{ k: 'pending', v: 'در جریان' }, { k: 'issued', v: 'صادره' }, { k: 'received', v: 'دریافتی' }, { k: 'all', v: 'همه' }]} filter={f} onFilter={(k) => { setF(k as typeof f); l.setPage(1); }} />
        {l.total === 0 ? (
          <EmptyState title={l.q ? `چکی با «${l.q}» پیدا نشد` : 'در این فیلتر چکی نیست'} action={<button className="btn sm" type="button" onClick={() => { l.setQ(''); setF('all'); }}>دیدن همه</button>} />
        ) : (
          <DataTable caption="چک" rows={l.slice} rowKey={(c) => c.id} onOpen={(c) => openCheque(c.id)}
            title={(c) => (<><span className={`dir ${c.direction === 'issued' ? 'out' : 'in'}`}><Icon name={c.direction === 'issued' ? 'out' : 'in'} size="sm" /></span>
              <span className="tx-t"><b>{name(c.personId)}</b><small>{c.direction === 'issued' ? 'صادره' : 'دریافتی'}{c.description ? ` · ${c.description}` : ''}</small></span></>)}
            columns={[
              { label: 'سررسید', cell: (c) => <span className="num">{formatJalali(c.dueDate, { withYear: false })} <small className={`due${c.status === 'pending' && c.dueDate < book.today ? ' late' : ''}`}>{c.status === 'pending' ? dueLabel(c.dueDate, book.today) : ''}</small></span> },
              { label: 'بانک', cell: (c) => c.bank ?? '—' },
              { label: 'وضعیت', cell: (c) => <span className={`pill ${CHEQUE_STATUS[c.status].tone}`}>{CHEQUE_STATUS[c.status].label(c)}</span> },
              { label: 'مبلغ (تومان)', className: 'amt num', cell: (c) => <span className={c.direction === 'issued' ? '' : 'in'}>{formatToman(c.amountRial, { unit: false })}</span> },
            ]} />
        )}
        <Pager {...l} noun="چک" />
      </Panel>
    </>
  );
}

// ---------- workers ----------

export function WorkersPage() {
  const { book, projectId } = useBook();
  const { openAssistant } = useSheets();
  const [f, setF] = useState<'all' | 'paid' | 'unpaid'>('all');
  const stageName = (id?: string) => book.stages.find((s) => s.id === id)?.name ?? 'کل پروژه';
  const logs = book.workLogs.filter((w) => w.ledgerId === projectId && !w.voided).sort((a, b) => b.workDate.localeCompare(a.workDate));
  const rows = logs.filter((w) => f === 'all' || (f === 'paid' ? w.paid : !w.paid));
  const l = useList(rows, (w) => `${w.description} ${stageName(w.stageId)}`, 8);
  const crew = book.people.filter((p) => p.kind === 'crew');
  const owedCrew = crew.reduce((s, p) => s + personOwed(book, projectId, p.id), 0n);
  const personDays = logs.reduce((s, w) => s + w.headcount, 0);
  const total = (w: WorkLog) => w.wageRial * BigInt(w.headcount);
  return (
    <>
      <section className="kpi-row">
        <Panel className="kpi" top index={0}><div className="label"><Icon name="hat" size="sm" />نفر-روز ثبت‌شده</div><div className="value num">{toPersianDigits(personDays)}<small>نفر-روز</small></div><div className="foot muted">در {toPersianDigits(logs.length)} روز کاری</div></Panel>
        <Panel className="kpi" top index={1}><div className="label"><Icon name="out" size="sm" />جمع دستمزدها</div><div className="value num">{formatShortToman(logs.reduce((s, w) => s + total(w), 0n))}<small>تومان</small></div><div className="foot muted">پرداخت‌شده و نشده</div></Panel>
        <Panel className="kpi" top index={2}><div className="label"><Icon name="alert" size="sm" />طلب کارگرها</div><div className="value num">{formatShortToman(owedCrew > 0n ? owedCrew : 0n)}<small>تومان</small></div><div className="foot muted">دستمزدهای هنوز پرداخت‌نشده</div></Panel>
      </section>
      <Panel labelledBy="workTitle">
        <Head id="workTitle" icon="hat" title="کارکرد کارگرها" sub="هر روز کاری یک ردیف: چند نفر، چه کاری، دستمزد و اینکه پرداخت شد یا نه.">
          <button className="btn sm primary" type="button" onClick={() => openAssistant('امروز ')}><Icon name="plus" size="sm" />ثبت کارکرد</button>
        </Head>
        <ListToolbar q={l.q} onQ={l.setQ} placeholder="کار یا مرحله" label="جستجو در کارکردها"
          filters={[{ k: 'all', v: 'همه' }, { k: 'unpaid', v: 'پرداخت‌نشده' }, { k: 'paid', v: 'پرداخت‌شده' }]} filter={f} onFilter={(k) => { setF(k as typeof f); l.setPage(1); }} />
        {l.total === 0 ? (
          <EmptyState icon="hat" title={l.q ? `کارکردی با «${l.q}» پیدا نشد` : 'در این فیلتر کارکردی نیست'} text="به دستیار بگویید «امروز پنج کارگر داشتیم…»." />
        ) : (
          <DataTable caption="کار" rows={l.slice} rowKey={(w) => w.id}
            title={(w) => <span className="tx-t"><b>{w.description || 'کارکرد'}</b><small>{stageName(w.stageId)}</small></span>}
            columns={[
              { label: 'تاریخ', className: 'num', cell: (w) => formatJalali(w.workDate, { withYear: false }) },
              { label: 'نفر', className: 'num', cell: (w) => toPersianDigits(w.headcount) },
              { label: 'دستمزد هر نفر', className: 'num', cell: (w) => formatToman(w.wageRial, { unit: false }) },
              { label: 'وضعیت', cell: (w) => <span className={`pill ${w.paid ? 'pos' : 'warn'}`}>{w.paid ? 'پرداخت شد' : 'طلب'}</span> },
              { label: 'جمع (تومان)', className: 'amt num', cell: (w) => formatToman(total(w), { unit: false }) },
            ]} />
        )}
        <Pager {...l} noun="روز کاری" />
      </Panel>
    </>
  );
}

// ---------- people ----------

export function PeoplePage() {
  const { book, projectId } = useBook();
  const { openPerson } = useSheets();
  const [f, setF] = useState<'owed' | 'all'>('owed');
  const KIND: Record<string, string> = { contractor: 'پیمانکار', crew: 'کارگران', supplier: 'فروشنده', supervisor: 'ناظر', office: 'اداره', buyer: 'خریدار', partner: 'صاحب‌کار' };
  const rows = useMemo(() => book.people.filter((p) => p.kind !== 'partner').map((p) => ({ p, owed: personOwed(book, projectId, p.id) }))
    .filter((x) => f === 'all' || x.owed !== 0n)
    .sort((a, b) => (b.owed > a.owed ? 1 : b.owed < a.owed ? -1 : a.p.fullName.localeCompare(b.p.fullName, 'fa'))), [book, projectId, f]);
  const l = useList(rows, (x) => `${x.p.fullName} ${x.p.roleTitle} ${KIND[x.p.kind] ?? ''}`, 8);
  const ownerDebt = book.ledgers.filter((x) => x.kind !== 'project').reduce((s, x) => s + interLedgerOwed(book, projectId, x.id), 0n);
  const totalDebt = rows.filter((x) => x.owed > 0n).reduce((s, x) => s + x.owed, 0n) + (ownerDebt > 0n ? ownerDebt : 0n);
  return (
    <Panel labelledBy="peopleTitle" top>
      <Head id="peopleTitle" icon="users" title="اشخاص و مانده حساب" sub="روی هر نام بزنید تا گردش حسابش را ببینید: طلب‌ها، پرداخت‌ها و چک‌ها.">
        <span className="pill neg num">بدهی پروژه: {formatShortToman(totalDebt)} تومان</span>
      </Head>
      {ownerDebt !== 0n && (
        <div className="effect"><span><b>{book.ownerName} (شما):</b> {ownerDebt > 0n ? `${formatShortToman(ownerDebt)} تومان از پروژه طلب دارید (خرج پروژه از حساب شخصی).` : `${formatShortToman(-ownerDebt)} تومان به پروژه بدهکارید.`}</span></div>
      )}
      <ListToolbar q={l.q} onQ={l.setQ} placeholder="نام یا نقش" label="جستجو در اشخاص"
        filters={[{ k: 'owed', v: 'با مانده' }, { k: 'all', v: 'همه' }]} filter={f} onFilter={(k) => { setF(k as typeof f); l.setPage(1); }} />
      {l.total === 0 ? <EmptyState icon="users" title={l.q ? `کسی با «${l.q}» پیدا نشد` : 'کسی با مانده نیست'} /> : (
        <DataTable caption="نام" rows={l.slice} rowKey={(x) => x.p.id} onOpen={(x) => openPerson(x.p.id)}
          title={(x: { p: Person; owed: bigint }) => <><span className="avatar" aria-hidden="true">{x.p.initials || initialsFa(x.p.fullName)}</span><span className="tx-t"><b>{x.p.fullName}</b><small>{x.p.roleTitle}</small></span></>}
          columns={[
            { label: 'نوع', cell: (x) => KIND[x.p.kind] ?? '—' },
            { label: 'وضعیت', cell: (x) => x.owed > 0n ? <span className="pill warn">طلب دارد</span> : x.owed < 0n ? <span className="pill info">پیش‌پرداخت</span> : <span className="pill pos">تسویه</span> },
            { label: 'مانده (تومان)', className: 'amt num', cell: (x) => x.owed === 0n ? '—' : formatToman(x.owed < 0n ? -x.owed : x.owed, { unit: false }) },
          ]} />
      )}
      <Pager {...l} noun="شخص" />
    </Panel>
  );
}

// ---------- stages ----------

export function StagesPage() {
  return <Stages mode="page" />;
}

// ---------- documents ----------

const DOC_STATUS: Record<DocumentRec['status'], { label: string; tone: string }> = {
  awaiting_file: { label: 'منتظر فایل', tone: 'warn' }, draft: { label: 'پیش‌نویس', tone: 'info' }, approved: { label: 'مصوب', tone: 'pos' },
  executive: { label: 'اجرایی', tone: 'accent' }, as_built: { label: 'چون‌ساخت', tone: 'accent' }, expired: { label: 'منقضی', tone: 'neg' },
};

export function DocumentsPage() {
  const { book, projectId } = useBook();
  const toast = useToast();
  const [cat, setCat] = useState('all');
  const docs = book.documents.filter((d) => d.ledgerId === projectId && !d.hidden && (cat === 'all' || d.category === cat));
  const l = useList(docs, (d) => `${d.title} ${d.meta} ${DOC_CATEGORIES[d.category as keyof typeof DOC_CATEGORIES] ?? ''}`, 8);
  return (
    <Panel labelledBy="docsTitle" top>
      <Head id="docsTitle" icon="folder" title="اسناد و نقشه‌ها" sub="هر سند در دستهٔ خودش؛ نقشه‌ها جدا بر اساس رشته (معماری، سازه، آب، برق، گاز).">
        <button className="btn sm" type="button" onClick={() => toast('بارگذاری سند بعد از وصل شدن به سرور فعال می‌شود', undefined, 'info')}><Icon name="upload" size="sm" />بارگذاری</button>
      </Head>
      <div className="effect"><span><b>نقشه‌های اتوکد:</b> فایل DWG اصلی برای همیشه بایگانی می‌شود؛ نسخهٔ رسمی که همه می‌بینند PDF همان برگ است. از مهندس بخواهید هر نقشه را با PDF هم بفرستد.</span></div>
      <ListToolbar q={l.q} onQ={l.setQ} placeholder="عنوان یا صادرکننده" label="جستجو در اسناد"
        extra={<div className="dd-inline"><span className="sr-only" id="docCatLbl">دسته</span>
          <Dropdown labelledBy="docCatLbl" value={cat} onChange={(v) => { setCat(v); l.setPage(1); }}
            options={[{ value: 'all', label: 'همهٔ دسته‌ها' }, ...Object.entries(DOC_CATEGORIES).map(([value, label]) => ({ value, label }))]} /></div>} />
      {l.total === 0 ? <EmptyState icon="folder" title={l.q ? `سندی با «${l.q}» پیدا نشد` : 'در این دسته سندی نیست'} action={<button className="btn sm" type="button" onClick={() => { l.setQ(''); setCat('all'); }}>همهٔ اسناد</button>} /> : (
        <DataTable caption="سند" rows={l.slice} rowKey={(d) => d.id}
          title={(d) => <><span className={`ext${d.category === 'drawings' ? ' dwg' : d.status === 'awaiting_file' ? ' img' : ''}`}>{d.category === 'drawings' ? 'DWG' : d.status === 'awaiting_file' ? '…' : 'PDF'}</span><span className="tx-t"><b>{d.title}</b><small>{d.meta.split(' · ').join('، ')}</small></span></>}
          columns={[
            { label: 'دسته', cell: (d) => DOC_CATEGORIES[d.category as keyof typeof DOC_CATEGORIES] ?? '—' },
            { label: 'وضعیت', cell: (d) => <span className={`pill ${DOC_STATUS[d.status].tone}`}>{DOC_STATUS[d.status].label}</span> },
          ]} />
      )}
      <Pager {...l} noun="سند" />
    </Panel>
  );
}

// ---------- notes ----------

export function NotesPage() {
  const { book, projectId } = useBook();
  const { openAssistant } = useSheets();
  const notes = book.dailyNotes.filter((n) => n.ledgerId === projectId && !n.voided).sort((a, b) => b.noteDate.localeCompare(a.noteDate));
  const stageName = (id?: string) => book.stages.find((s) => s.id === id)?.name ?? 'کل پروژه';
  const l = useList(notes, (n) => `${n.body} ${stageName(n.stageId)}`, 6);
  return (
    <Panel labelledBy="notesTitle" top>
      <Head id="notesTitle" icon="check-board" title="یادداشت‌های روزانه" sub="نظر ناظر، اتفاق‌های کارگاه و هر چیزی که جای دیگری ندارد. پیگیری ایرادهای ناظر به‌زودی اضافه می‌شود.">
        <button className="btn sm primary" type="button" onClick={() => openAssistant('یادداشت کن: ')}><Icon name="plus" size="sm" />یادداشت تازه</button>
      </Head>
      <ListToolbar q={l.q} onQ={l.setQ} placeholder="متن یا مرحله" label="جستجو در یادداشت‌ها" />
      {l.total === 0 ? <EmptyState icon="msg" title={l.q ? `یادداشتی با «${l.q}» پیدا نشد` : 'هنوز یادداشتی نیست'} text="در ویس بگویید «یادداشت کن…» تا اینجا بیاید." /> : (
        <div className="notes-list">
          {l.slice.map((n) => (
            <div className="note" key={n.id}>
              <div className="note-head"><span className="avatar" aria-hidden="true"><Icon name="msg" size="sm" /></span>
                <div className="who"><b>{formatJalali(n.noteDate, { withYear: false })}</b><span>{stageName(n.stageId)}</span></div></div>
              <p>{n.body}</p>
            </div>
          ))}
        </div>
      )}
      <Pager {...l} noun="یادداشت" />
    </Panel>
  );
}

// ---------- archive ----------

export function ArchivePage() {
  const { book } = useBook();
  const { openArchive } = useSheets();
  const [f, setF] = useState<'all' | 'voice' | 'photo' | 'text'>('all');
  const rows = book.inbox.filter((i) => f === 'all' || (f === 'voice' ? i.kind === 'voice' : f === 'text' ? i.kind === 'text' : !['voice', 'text'].includes(i.kind)));
  const l = useList(rows, (i) => `${i.title} ${i.chips.join(' ')} ${i.text ?? ''} ${i.ocr ?? ''} ${i.transcript ? transcriptText(i.transcript) : ''}`, 8);
  return (
    <Panel labelledBy="archTitle" top>
      <Head id="archTitle" icon="clip" title="بایگانی ویس و عکس" sub="هر ویس، عکس و پیامی که رسیده، برای همیشه؛ حتی اگر رد شده باشد. فایل اصلی هرگز تغییر نمی‌کند." />
      <ListToolbar q={l.q} onQ={l.setQ} placeholder="متن، نام یا مبلغ" label="جستجو در بایگانی"
        filters={[{ k: 'all', v: 'همه' }, { k: 'voice', v: 'ویس' }, { k: 'photo', v: 'عکس' }, { k: 'text', v: 'پیام' }]} filter={f} onFilter={(k) => { setF(k as typeof f); l.setPage(1); }} />
      {l.total === 0 ? <EmptyState icon="clip" title={l.q ? `چیزی با «${l.q}» پیدا نشد` : 'در این فیلتر چیزی نیست'} /> : (
        <DataTable caption="ورودی" rows={l.slice} rowKey={(i) => i.id} onOpen={(i) => openArchive(i.id)}
          title={(i: InboxItem) => <><span className={`kind-ic sm ${i.kind}`}><Icon name={KIND_ICON[i.kind]} size="sm" /></span><span className="tx-t"><b>{i.title}</b><small>{i.chips.join('، ') || '—'}</small></span></>}
          columns={[
            { label: 'از', cell: (i) => CHANNEL[i.channel] },
            { label: 'زمان', cell: (i) => i.receivedLabel },
            { label: 'وضعیت', cell: (i) => <span className={`pill ${inboxStatus[i.status].tone}`}>{inboxStatus[i.status].label}</span> },
          ]} />
      )}
      <Pager {...l} noun="ورودی" />
    </Panel>
  );
}

// ---------- the guide: templates people learn to speak by ----------

export function GuidePage() {
  const { openAssistant } = useSheets();
  const [q, setQ] = useState('');
  const shown = TEMPLATES.filter((t) => !q.trim() || includesFa(`${t.label} ${t.required.join(' ')} ${t.examples.join(' ')}`, q));
  return (
    <>
      <Panel labelledBy="guideTitle" top>
        <Head id="guideTitle" icon="msg" title="راهنمای ثبت با ویس" sub="لازم نیست جمله‌ای از پیش حفظ کنید؛ طبیعی بگویید. فقط هر الگو چند چیز لازم دارد. اگر یکی را نگویید، دستیار می‌پرسد." />
        <ul className="rules">
          <li><b>یک ویس، چند کار:</b> «امروز پنج کارگر داشتیم و دوازده میلیون هم به رضایی دادم» دو کارت می‌شود.</li>
          <li><b>مبلغ با واحد:</b> «دوازده میلیون» یعنی تومان؛ اگر ریال است بگویید «ریال».</li>
          <li><b>نام طرف و حساب:</b> نام فروشنده یا استادکار و نام حساب (ملت، تنخواه) را بگویید.</li>
          <li><b>عکس کنار ویس:</b> رسید، فاکتور و چک را عکس بگیرید؛ عکس اصلی کنار ثبت می‌ماند.</li>
        </ul>
      </Panel>
      <div className="glass panel tool-panel">
        <ListToolbar q={q} onQ={setQ} placeholder="مثلاً چک، کارگر، سند" label="جستجو در الگوها"
          extra={<span className="muted small num tool-count" aria-live="polite">{toPersianDigits(shown.length)} الگو</span>} />
      </div>
      {shown.length === 0 && (
        <div className="glass panel"><EmptyState title={`الگویی با «${q}» پیدا نشد`} action={<button className="btn sm" type="button" onClick={() => setQ('')}>همهٔ الگوها</button>} /></div>
      )}
      <section className="tpl-grid">
        {shown.map((t, i) => (
          <Panel key={t.key} className="tpl" labelledBy={`tpl-${t.key}`} top index={i % 4}>
            <div className="panel-head">
              <h3 id={`tpl-${t.key}`}><span className={`pill ${t.tone}`}><Icon name={t.icon} size="sm" />{t.label}</span>{t.soon && <span className="pill">به‌زودی</span>}</h3>
              <Link className="small link" href={t.href}>می‌رود به «{t.page}»</Link>
            </div>
            <div className="tpl-cols">
              <div><div className="sec-title">حتماً بگویید</div><ul className="req">{t.required.map((r) => <li key={r}><Icon name="check" size="sm" />{r}</li>)}</ul></div>
              <div><div className="sec-title">اگر بود بگویید</div><ul className="opt">{t.optional.map((r) => <li key={r}>{r}</li>)}</ul></div>
            </div>
            <div className="sec-title">نمونه</div>
            <div className="ex-list">{t.examples.map((x) => (
              <div className="example" key={x}><span>«{x}»</span>
                {!t.soon && <button className="btn sm try-btn" type="button" onClick={() => openAssistant(x)}><Icon name="mic" size="sm" />امتحان کنید</button>}</div>
            ))}</div>
            <p className="why">{t.tip}</p>
          </Panel>
        ))}
      </section>
    </>
  );
}
