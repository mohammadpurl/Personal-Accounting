'use client';
// Shared controls: icon, custom dropdown (searchable when long), Jalali date picker, modal sheet, toast.
// All keyboard-accessible and RTL; no native <select> or <input type="date">.
import { AnimatePresence, motion, useReducedMotion } from 'motion/react';
import { createPortal } from 'react-dom';
import {
  createContext, useCallback, useContext, useEffect, useId, useLayoutEffect, useMemo, useRef, useState,
  type KeyboardEvent as ReactKeyboardEvent, type ReactNode,
} from 'react';
import { formatJalali, formatJalaliMonth, isoToJalali, jalaliToIso, monthLength, WEEKDAYS_SHORT, weekdayIndex } from '@/lib/jalali';
import { toPersianDigits } from '@/lib/money';
import { includesFa } from '@/lib/text';

export const EASE = [0.22, 1, 0.36, 1] as const;

export function Icon({ name, size, className }: { name: string; size?: 'sm'; className?: string }) {
  return (
    <svg className={`i${size ? ` ${size}` : ''}${className ? ` ${className}` : ''}`} aria-hidden="true">
      <use href={`#i-${name}`} />
    </svg>
  );
}

// ---------- popover placement: open upward only when there is room above inside a sheet ----------

function usePlacement(open: boolean, btn: React.RefObject<HTMLElement | null>, pop: React.RefObject<HTMLElement | null>) {
  useLayoutEffect(() => {
    if (!open || !btn.current || !pop.current) return;
    const p = pop.current;
    p.classList.remove('up');
    if (getComputedStyle(p).position === 'fixed') return; // phone: the calendar is its own bottom sheet
    const sheet = btn.current.closest('.sheet') as HTMLElement | null;
    const r = btn.current.getBoundingClientRect();
    const lim = sheet ? sheet.getBoundingClientRect().bottom - ((sheet.querySelector('.sheet-foot') as HTMLElement | null)?.offsetHeight ?? 0) : innerHeight;
    const ceil = sheet ? (sheet.querySelector('.sheet-head') as HTMLElement).getBoundingClientRect().bottom : 0;
    if (r.bottom + p.offsetHeight + 8 > lim) {
      if (r.top - ceil >= p.offsetHeight + 8) p.classList.add('up');
      else if (sheet) sheet.scrollTop += p.getBoundingClientRect().bottom - lim + 8;
    }
  }, [open, btn, pop]);
}

function useOutside(ref: React.RefObject<HTMLElement | null>, onOut: () => void, active: boolean) {
  useEffect(() => {
    if (!active) return;
    const h = (e: PointerEvent) => { if (ref.current && !ref.current.contains(e.target as Node)) onOut(); };
    document.addEventListener('pointerdown', h);
    return () => document.removeEventListener('pointerdown', h);
  }, [ref, onOut, active]);
}

// ---------- dropdown ----------

export interface Option { value: string; label: string; hint?: string; swatch?: string }

export function Dropdown({ options, value, onChange, labelledBy, warn, invalid, placeholder = 'انتخاب کنید', className }: {
  options: Option[]; value: string | undefined; onChange: (v: string) => void; labelledBy?: string; warn?: boolean; invalid?: boolean; placeholder?: string; className?: string;
}) {
  const id = useId();
  const [open, setOpen] = useState(false);
  const [term, setTerm] = useState('');
  const [kb, setKb] = useState(0);
  const host = useRef<HTMLDivElement>(null), btn = useRef<HTMLButtonElement>(null), pop = useRef<HTMLDivElement>(null);
  const list = useRef<HTMLUListElement>(null), search = useRef<HTMLInputElement>(null);
  const searchable = options.length > 6;
  const shown = useMemo(() => (term.trim() ? options.filter((o) => includesFa(o.label, term)) : options), [options, term]);
  const current = options.find((o) => o.value === value);
  usePlacement(open, btn, pop);
  const close = useCallback((focus?: boolean) => { setOpen(false); if (focus) btn.current?.focus(); }, []);
  useOutside(host, () => close(), open);

  const openList = () => {
    setTerm('');
    setKb(Math.max(0, options.findIndex((o) => o.value === value)));
    setOpen(true);
    requestAnimationFrame(() => (searchable ? search.current : list.current)?.focus());
  };
  useEffect(() => { list.current?.querySelector('.kb')?.scrollIntoView({ block: 'nearest' }); }, [kb, open]);
  const pick = (o?: Option) => { if (!o) return; if (o.value !== value) onChange(o.value); close(true); };
  const keys = (e: ReactKeyboardEvent) => {
    if (e.key === 'ArrowDown') { e.preventDefault(); setKb((k) => Math.min(shown.length - 1, k + 1)); }
    else if (e.key === 'ArrowUp') { e.preventDefault(); setKb((k) => Math.max(0, k - 1)); }
    else if (e.key === 'Home' && !searchable) { e.preventDefault(); setKb(0); }
    else if (e.key === 'End' && !searchable) { e.preventDefault(); setKb(shown.length - 1); }
    else if (e.key === 'Enter' || (e.key === ' ' && !searchable)) { e.preventDefault(); pick(shown[kb]); }
    else if (e.key === 'Escape') { e.preventDefault(); e.stopPropagation(); close(true); }
    else if (e.key === 'Tab') close();
  };
  const activeId = shown[kb] ? `${id}-o${kb}` : undefined;

  return (
    <div className={`dd${warn ? ' warn' : ''}${invalid ? ' err' : ''}${className ? ` ${className}` : ''}`} ref={host}>
      <button type="button" className="dd-btn" ref={btn} aria-haspopup="listbox" aria-expanded={open} data-invalid={invalid || undefined}
        aria-labelledby={`${labelledBy ? `${labelledBy} ` : ''}${id}-b`} id={`${id}-b`}
        onClick={() => (open ? close() : openList())}
        onKeyDown={(e) => { if (e.key === 'ArrowDown' || e.key === 'ArrowUp') { e.preventDefault(); openList(); } }}>
        <span className={`v${current ? '' : ' ph'}`}>
          {current?.swatch && <span className="sw" style={{ background: current.swatch }} aria-hidden="true" />}
          {current?.label ?? placeholder}
        </span>
        <Icon name="chev" size="sm" />
      </button>
      {open && (
        <div className="dd-pop" ref={pop}>
          {searchable && (
            <div className="dd-search">
              <Icon name="search" size="sm" />
              <input ref={search} type="text" placeholder="جستجو…" aria-label="جستجو در گزینه‌ها" aria-controls={`${id}-l`} aria-activedescendant={activeId}
                autoComplete="off" value={term} onChange={(e) => { setTerm(e.target.value); setKb(0); }} onKeyDown={keys} />
            </div>
          )}
          <ul className="dd-list" role="listbox" id={`${id}-l`} ref={list} tabIndex={-1} aria-labelledby={labelledBy}
            aria-activedescendant={activeId} onKeyDown={keys}>
            {shown.length === 0 && <li className="dd-empty" role="presentation">چیزی پیدا نشد</li>}
            {shown.map((o, i) => (
              <li key={o.value} id={`${id}-o${i}`} role="option" aria-selected={o.value === value} className={i === kb ? 'kb' : undefined}
                onClick={() => pick(o)} onPointerMove={() => setKb(i)}>
                <Icon name="check" size="sm" className="tick" />
                {o.swatch && <span className="sw" style={{ background: o.swatch }} aria-hidden="true" />}
                <span>{o.label}</span>
                {o.hint && <small>{o.hint}</small>}
              </li>
            ))}
          </ul>
        </div>
      )}
    </div>
  );
}

// ---------- Jalali date picker ----------

export function DatePicker({ value, onChange, labelledBy, warn, invalid, placeholder = 'انتخاب تاریخ', today, title }: {
  value: string | undefined; onChange: (iso: string) => void; labelledBy?: string; warn?: boolean; invalid?: boolean; placeholder?: string; today: string; title?: string;
}) {
  const id = useId();
  const t = isoToJalali(today);
  const start = value ? isoToJalali(value) : t;
  const [open, setOpen] = useState(false);
  const [view, setView] = useState({ jy: start.jy, jm: start.jm });
  const [focusD, setFocusD] = useState(start.jd);
  const host = useRef<HTMLDivElement>(null), btn = useRef<HTMLButtonElement>(null), pop = useRef<HTMLDivElement>(null), grid = useRef<HTMLDivElement>(null);
  usePlacement(open, btn, pop);
  const close = useCallback((focus?: boolean) => { setOpen(false); if (focus) btn.current?.focus(); }, []);
  useOutside(host, () => close(), open);
  const len = monthLength(view.jy, view.jm);
  const offset = weekdayIndex(jalaliToIso({ jy: view.jy, jm: view.jm, jd: 1 }));
  const shift = (n: number) => setView((v) => { let jm = v.jm + n, jy = v.jy; while (jm < 1) { jm += 12; jy--; } while (jm > 12) { jm -= 12; jy++; } return { jy, jm }; });
  // Focus goes to the days only when the calendar opens or the keys move inside it; the month buttons keep their focus.
  const focusGrid = useRef(false);
  useEffect(() => {
    if (!open || !focusGrid.current) return;
    focusGrid.current = false;
    grid.current?.querySelector<HTMLButtonElement>(`[data-d="${Math.min(focusD, len)}"]`)?.focus();
  }, [open, view, focusD, len]);
  useEffect(() => {
    if (!open) return;
    const h = () => setTimeout(() => { if (host.current && !host.current.contains(document.activeElement)) setOpen(false); }, 0);
    const el = host.current; el?.addEventListener('focusout', h);
    return () => el?.removeEventListener('focusout', h);
  }, [open]);
  const move = (days: number) => {
    let d = focusD + days;
    if (d < 1) { const pj = view.jm === 1 ? { jy: view.jy - 1, jm: 12 } : { jy: view.jy, jm: view.jm - 1 }; d += monthLength(pj.jy, pj.jm); setView(pj); }
    else if (d > len) { d -= len; shift(1); }
    setFocusD(d);
  };
  const keys = (e: ReactKeyboardEvent) => {
    const step = ({ ArrowLeft: 1, ArrowRight: -1, ArrowDown: 7, ArrowUp: -7 } as Record<string, number>)[e.key];
    if (step) { e.preventDefault(); focusGrid.current = true; move(step); }
    else if (e.key === 'PageDown') { e.preventDefault(); focusGrid.current = true; shift(1); }
    else if (e.key === 'PageUp') { e.preventDefault(); focusGrid.current = true; shift(-1); }
    else if (e.key === 'Escape') { e.preventDefault(); e.stopPropagation(); close(true); }
  };
  const sel = value ? isoToJalali(value) : undefined;

  return (
    <div className={`dd${warn ? ' warn' : ''}${invalid ? ' err' : ''}`} ref={host}>
      <button type="button" className="dd-btn" ref={btn} aria-haspopup="dialog" aria-expanded={open} id={`${id}-b`} data-invalid={invalid || undefined}
        aria-labelledby={`${labelledBy ? `${labelledBy} ` : ''}${id}-b`}
        onClick={() => { if (open) close(); else { const s = value ? isoToJalali(value) : t; setView({ jy: s.jy, jm: s.jm }); setFocusD(s.jd); focusGrid.current = true; setOpen(true); } }}>
        <span className={`v${value ? '' : ' ph'}`}>{value ? formatJalali(value) : placeholder}</span>
        <Icon name="calendar" size="sm" />
      </button>
      {open && (
        <div className="dd-pop dp" ref={pop} role="dialog" aria-label="انتخاب تاریخ" onKeyDown={(e) => { if (e.key === 'Escape') { e.stopPropagation(); close(true); } }}>
          {title && <div className="dp-field" aria-hidden="true">{title}</div>}
          <div className="dp-head">
            <button type="button" className="icon-btn sm" aria-label="ماه قبل" onClick={() => shift(-1)}><Icon name="right" size="sm" /></button>
            <b className="dp-title" aria-live="polite">{formatJalaliMonth(view.jy, view.jm)}</b>
            <button type="button" className="icon-btn sm" aria-label="ماه بعد" onClick={() => shift(1)}><Icon name="left" size="sm" /></button>
          </div>
          <div className="dp-week" aria-hidden="true">{WEEKDAYS_SHORT.map((w) => <span key={w}>{w}</span>)}</div>
          <div className="dp-grid" ref={grid} onKeyDown={keys}>
            {Array.from({ length: offset }, (_, i) => <span key={`e${i}`} />)}
            {Array.from({ length: len }, (_, i) => {
              const d = i + 1;
              const iso = jalaliToIso({ jy: view.jy, jm: view.jm, jd: d });
              const isSel = !!sel && sel.jy === view.jy && sel.jm === view.jm && sel.jd === d;
              const isToday = t.jy === view.jy && t.jm === view.jm && t.jd === d;
              return (
                <button key={d} type="button" data-d={d} tabIndex={d === Math.min(focusD, len) ? 0 : -1}
                  className={`dp-day${isSel ? ' sel' : ''}${isToday ? ' today' : ''}`} aria-pressed={isSel}
                  aria-label={`${formatJalali(iso)}${isToday ? '، امروز' : ''}`}
                  onClick={() => { onChange(iso); close(true); }}>
                  {toPersianDigits(d)}
                </button>
              );
            })}
          </div>
        </div>
      )}
    </div>
  );
}

// ---------- sheet (modal) ----------

/** A modal window. `returnFocus` is where focus goes on close when the button that opened it is gone or hidden. */
export function Sheet({ open, onClose, children, labelledBy = 'sheetTitle', returnFocus }: { open: boolean; onClose: () => void; children: ReactNode; labelledBy?: string; returnFocus?: string }) {
  const reduce = useReducedMotion();
  const sheet = useRef<HTMLDivElement>(null);
  const back = useRef<Element | null>(null);
  // The latest onClose without re-running the open effect (parents pass a new function each render).
  const close = useRef(onClose);
  const fallback = useRef(returnFocus);
  useLayoutEffect(() => { close.current = onClose; fallback.current = returnFocus; });
  useEffect(() => {
    if (!open) return;
    back.current = document.activeElement;
    const page = [document.querySelector('.main'), document.querySelector('.fab'), document.querySelector('#sidebar')] as (HTMLElement | null)[];
    const wasInert = page.map((el) => el?.inert ?? false);
    page.forEach((el) => { if (el) el.inert = true; });
    document.body.setAttribute('data-sheet', ''); // the shell leaves the page inert while this is set
    document.body.style.overflow = 'hidden';
    requestAnimationFrame(() => {
      if (sheet.current) sheet.current.scrollTop = 0;
      (sheet.current?.querySelector<HTMLElement>('[data-autofocus]') ?? sheet.current?.querySelector<HTMLElement>('button'))?.focus({ preventScroll: true });
    });
    const onKey = (e: KeyboardEvent) => {
      if (e.key === 'Escape') { e.preventDefault(); close.current(); }
      if (e.key === 'Tab' && sheet.current) {
        const f = [...sheet.current.querySelectorAll<HTMLElement>('button, input, textarea, [tabindex="0"]')].filter((el) => !(el as HTMLButtonElement).disabled && el.offsetParent !== null);
        if (!f.length) return;
        const i = f.indexOf(document.activeElement as HTMLElement), inside = sheet.current.contains(document.activeElement);
        if (e.shiftKey && (i === 0 || (i === -1 && (document.activeElement as HTMLElement).id === labelledBy) || !inside)) { e.preventDefault(); f[f.length - 1].focus(); }
        else if (!e.shiftKey && (i === f.length - 1 || !inside)) { e.preventDefault(); f[0].focus(); }
      }
    };
    document.addEventListener('keydown', onKey);
    return () => {
      document.removeEventListener('keydown', onKey);
      document.body.removeAttribute('data-sheet');
      page.forEach((el, i) => { if (el) el.inert = wasInert[i]; });
      document.body.style.overflow = '';
      window.dispatchEvent(new Event('sheet-closed')); // the shell re-applies the drawer's own inert rules
      const b = back.current as HTMLElement | null;
      if (b?.isConnected && !b.closest('[inert]') && b.offsetParent !== null) b.focus();
      else if (fallback.current) document.querySelector<HTMLElement>(fallback.current)?.focus();
    };
  }, [open, labelledBy]);

  // Rendered at the top of <body>, outside the page that becomes inert while the sheet is open.
  if (typeof document === 'undefined') return null;
  return createPortal(
    <AnimatePresence>
      {open && (
        <div className="scrim" onClick={(e) => { if (e.target === e.currentTarget) onClose(); }}>
          <motion.div className="sheet" ref={sheet} role="dialog" aria-modal="true" aria-labelledby={labelledBy}
            initial={reduce ? false : { opacity: 0, y: 56, scale: 0.96 }} animate={{ opacity: 1, y: 0, scale: 1 }}
            exit={reduce ? undefined : { opacity: 0, y: 30, scale: 0.98 }} transition={{ duration: 0.5, ease: EASE }}>
            {children}
          </motion.div>
        </div>
      )}
    </AnimatePresence>,
    document.body,
  );
}

export function SheetHead({ icon, kind, title, sub, onClose }: { icon: string; kind: string; title: string; sub?: string; onClose: () => void }) {
  return (
    <div className="sheet-head">
      <span className={`kind-ic ${kind}`}><Icon name={icon} /></span>
      <div className="sheet-ttl">
        <h2 id="sheetTitle" tabIndex={-1} data-autofocus>{title}</h2>
        {sub && <span className="muted small">{sub}</span>}
      </div>
      <button className="icon-btn" type="button" aria-label="بستن" onClick={onClose}><Icon name="x" /></button>
    </div>
  );
}

// ---------- toast ----------

type Tone = 'error' | 'info';
interface ToastMsg { id: number; text: string; action?: { label: string; run: () => void }; tone?: Tone }
const ToastCtx = createContext<(text: string, action?: ToastMsg['action'], tone?: Tone) => void>(() => {});
export const useToast = () => useContext(ToastCtx);

export function ToastProvider({ children }: { children: ReactNode }) {
  const [msg, setMsg] = useState<ToastMsg | null>(null);
  const timer = useRef<ReturnType<typeof setTimeout>>(undefined);
  const reduce = useReducedMotion();
  const show = useCallback((text: string, action?: ToastMsg['action'], tone?: Tone) => {
    clearTimeout(timer.current);
    setMsg({ id: Date.now(), text, action, tone });
    timer.current = setTimeout(() => setMsg(null), action ? 7000 : 2800);
  }, []);
  return (
    <ToastCtx.Provider value={show}>
      {children}
      <div aria-live="polite" role="status">
        <AnimatePresence>
          {msg && (
            <motion.div key={msg.id} className={`toast${msg.tone ? ` ${msg.tone}` : ''}`} initial={reduce ? false : { opacity: 0, y: 24, scale: 0.94 }} animate={{ opacity: 1, y: 0, scale: 1 }}
              exit={reduce ? undefined : { opacity: 0, y: 16 }} transition={{ type: 'spring', stiffness: 420, damping: 26 }}>
              <Icon name={msg.tone === 'error' ? 'alert' : msg.tone === 'info' ? 'msg' : 'check'} />
              <span className="toast-msg">{msg.text}</span>
              {msg.action && (
                <button type="button" className="toast-act" onClick={() => { setMsg(null); try { msg.action!.run(); } catch (e) { show((e as Error).message, undefined, 'error'); } }}>{msg.action.label}</button>
              )}
            </motion.div>
          )}
        </AnimatePresence>
      </div>
    </ToastCtx.Provider>
  );
}

/** Two-tap confirm for destructive buttons: the first tap asks, it resets after 4 s. */
export function useConfirmTap(): [boolean, () => boolean] {
  const [armed, setArmed] = useState(false);
  const timer = useRef<ReturnType<typeof setTimeout>>(undefined);
  useEffect(() => () => clearTimeout(timer.current), []);
  return [armed, () => {
    if (armed) { clearTimeout(timer.current); setArmed(false); return true; }
    setArmed(true); timer.current = setTimeout(() => setArmed(false), 4000); return false;
  }];
}
