'use client';
// Lists and tables used on every page: search (Persian-aware), segment filters, pagination, an empty state,
// and a table that turns into one card per row on phones (CSS: .tbl + data-label).
import { useState, type ReactNode } from 'react';
import { Icon } from './ui';
import { toPersianDigits } from '@/lib/money';
import { includesFa } from '@/lib/text';

export function useList<T>(rows: T[], text: (r: T) => string, per = 8) {
  const [q, setQ0] = useState('');
  const [page, setPage] = useState(1);
  const shown = q.trim() ? rows.filter((r) => includesFa(text(r), q)) : rows;
  const pages = Math.max(1, Math.ceil(shown.length / per));
  const p = Math.min(page, pages);
  return {
    q, setQ: (v: string) => { setQ0(v); setPage(1); },
    page: p, setPage, pages, total: shown.length, per,
    slice: shown.slice((p - 1) * per, p * per),
  };
}

export function ListToolbar({ q, onQ, placeholder, label, filters, filter, onFilter, extra }: {
  q: string; onQ: (v: string) => void; placeholder: string; label: string;
  filters?: { k: string; v: string }[]; filter?: string; onFilter?: (k: string) => void; extra?: ReactNode;
}) {
  return (
    <div className="list-tools">
      {filters && (
        <div className="seg" role="group" aria-label="فیلتر">
          {filters.map((f) => <button key={f.k} type="button" aria-pressed={filter === f.k} onClick={() => onFilter?.(f.k)}>{f.v}</button>)}
        </div>
      )}
      {extra}
      <label className="top-search tx-search">
        <Icon name="search" size="sm" /><span className="sr-only">{label}</span>
        <input type="search" placeholder={placeholder} value={q} onChange={(e) => onQ(e.target.value)} />
        {q && <button type="button" className="clear-btn" aria-label="پاک کردن جستجو" onClick={() => onQ('')}><Icon name="x" size="sm" /></button>}
      </label>
    </div>
  );
}

export function Pager({ page, pages, total, per, setPage, noun }: { page: number; pages: number; total: number; per: number; setPage: (n: number) => void; noun: string }) {
  if (total === 0) return null;
  const from = (page - 1) * per + 1, to = Math.min(total, page * per);
  return (
    <div className="pager">
      <span className="num">{toPersianDigits(from)} تا {toPersianDigits(to)} از {toPersianDigits(total)} {noun}</span>
      {pages > 1 && (
        <div className="pages">
          <button type="button" disabled={page === 1} aria-label="صفحهٔ قبل" onClick={() => setPage(page - 1)}><Icon name="right" size="sm" /></button>
          {Array.from({ length: pages }, (_, i) => i + 1).filter((n) => n === 1 || n === pages || Math.abs(n - page) <= 1).map((n, i, arr) => (
            <span key={n} style={{ display: 'contents' }}>
              {i > 0 && n - arr[i - 1] > 1 && <span aria-hidden="true" className="muted">…</span>}
              <button type="button" className="num" aria-label={`صفحهٔ ${toPersianDigits(n)}`} aria-current={n === page ? 'page' : undefined} onClick={() => setPage(n)}>{toPersianDigits(n)}</button>
            </span>
          ))}
          <button type="button" disabled={page === pages} aria-label="صفحهٔ بعد" onClick={() => setPage(page + 1)}><Icon name="left" size="sm" /></button>
        </div>
      )}
    </div>
  );
}

export interface Column<T> { label: string; cell: (r: T) => ReactNode; className?: string }

/** A table whose first column is the row's title (a button when the row opens); on phones each row is a card. */
export function DataTable<T>({ rows, columns, rowKey, title, onOpen, caption }: {
  rows: T[]; columns: Column<T>[]; rowKey: (r: T) => string; title: (r: T) => ReactNode; onOpen?: (r: T) => void; caption: string;
}) {
  return (
    <table className="tbl">
      <caption className="sr-only">{caption}</caption>
      <thead><tr><th>{caption}</th>{columns.map((c) => <th key={c.label} className={c.className}>{c.label}</th>)}</tr></thead>
      <tbody>
        {rows.map((r) => (
          <tr key={rowKey(r)}>
            <td className="first">{onOpen ? <button type="button" className="tx-open" onClick={() => onOpen(r)}>{title(r)}</button> : <div className="tx-open static">{title(r)}</div>}</td>
            {columns.map((c) => <td key={c.label} data-label={c.label} className={c.className}>{c.cell(r)}</td>)}
          </tr>
        ))}
      </tbody>
    </table>
  );
}

export function EmptyState({ icon = 'search', title, text, action }: { icon?: string; title: string; text?: string; action?: ReactNode }) {
  return <div className="empty"><Icon name={icon} /><b>{title}</b>{text && <span>{text}</span>}{action}</div>;
}
