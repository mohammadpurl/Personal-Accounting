'use client';
// The frame around every screen: moving glass background, sidebar (collapsible on desktop, a drawer on phones)
// with a sliding pill for the active item, top bar, quick-capture button, and the Settings window.
import { useCallback, useEffect, useRef, useState, useSyncExternalStore, type ReactNode } from 'react';
import { animate, motion, MotionConfig, stagger, useReducedMotion } from 'motion/react';
import gsap from 'gsap';
import { ScrollTrigger } from 'gsap/ScrollTrigger';
import { BACKDROP } from './backdrop-markup';
import { Dropdown, EASE, Icon, Sheet, SheetHead, useToast } from './ui';
import { CaptureSheet } from './review';
import { useBook } from '@/state/book';
import { formatJalali } from '@/lib/jalali';
import { toPersianDigits } from '@/lib/money';
import { includesFa, initialsFa } from '@/lib/text';

if (typeof window !== 'undefined') gsap.registerPlugin(ScrollTrigger);

const NAV_MAIN = [
  { href: '#top', icon: 'grid', label: 'داشبورد' },
  { href: '#inbox', icon: 'inbox', label: 'منتظر تأیید', badge: true },
  { href: '#transactions', icon: 'swap', label: 'واریز و برداشت' },
  { href: '#people', icon: 'users', label: 'اشخاص' },
];
const NAV_PROJECT = [
  { href: '#stages', icon: 'layers', label: 'مراحل ساخت', live: true },
  { soon: 'صفحهٔ کارکرد کارگرها به‌زودی اضافه می‌شود', icon: 'hat', label: 'کارکرد کارگرها' },
  { href: '#docs', icon: 'folder', label: 'اسناد و نقشه‌ها' },
  { href: '#notes', icon: 'check-board', label: 'یادداشت‌های روزانه' },
  { soon: 'بایگانی همهٔ ویس‌ها و عکس‌ها به‌زودی اضافه می‌شود', icon: 'clip', label: 'بایگانی' },
  { soon: 'گزارش‌ها به‌زودی اضافه می‌شوند', icon: 'bars', label: 'گزارش‌ها' },
];
const SPY = ['inbox', 'stages', 'people', 'transactions', 'notes', 'docs'];

const HUES = [
  { k: 'blue', v: 'آبی یخی', c: ['#2563eb', '#7c3aed', '#0891b2'] },
  { k: 'violet', v: 'بنفش یاسی', c: ['#7c3aed', '#db2777', '#4f46e5'] },
  { k: 'teal', v: 'فیروزه‌ای', c: ['#0d9488', '#0284c7', '#059669'] },
] as const;
const MODES = [{ k: 'system', v: 'مثل سیستم' }, { k: 'light', v: 'روشن' }, { k: 'dark', v: 'تیره' }] as const;
type Mode = (typeof MODES)[number]['k'];

const store = (k: string, v: string) => { try { localStorage.setItem(k, v); } catch { /* private mode */ } };
const recall = (k: string) => { try { return localStorage.getItem(k); } catch { return null; } };
const root = () => document.documentElement;
const isDark = () => {
  const t = root().getAttribute('data-theme');
  return t ? t === 'dark' : !matchMedia('(prefers-color-scheme: light)').matches;
};

// Preferences live in localStorage / <html> attributes / media queries; components read them as external stores.
const PREFS_EVENT = 'prefs-change';
const announce = () => window.dispatchEvent(new Event(PREFS_EVENT));
function subscribePrefs(cb: () => void) {
  const mqs = ['(prefers-color-scheme: light)', '(max-width: 960px)'].map((q) => matchMedia(q));
  mqs.forEach((m) => m.addEventListener('change', cb));
  window.addEventListener(PREFS_EVENT, cb);
  window.addEventListener('storage', cb);
  return () => { mqs.forEach((m) => m.removeEventListener('change', cb)); window.removeEventListener(PREFS_EVENT, cb); window.removeEventListener('storage', cb); };
}
const usePref = <T,>(get: () => T, server: T) => useSyncExternalStore(subscribePrefs, get, () => server);
const getMode = (): Mode => { const m = recall('mode'); return m === 'light' || m === 'dark' ? m : 'system'; };
const demoHidden = () => { try { return sessionStorage.getItem('demo-bar') === 'hidden'; } catch { return false; } };
const hideDemo = () => { try { sessionStorage.setItem('demo-bar', 'hidden'); } catch { /* private mode */ } announce(); };

// Pressing a control shrinks it a little (Motion); .capture-top has its own whileTap.
const PRESSABLE = '.btn:not(.capture-top), .icon-btn, .cap-opt, .nav a, .nav button, .theme-btn, .dp-day, .pages button, .seg button, .dd-btn, .tx-open, .hue-card, .collapse-btn, .toast-act, .stage.more button';

export function AppShell({ children }: { children: ReactNode }) {
  const { book } = useBook();
  const toast = useToast();
  const reduce = useReducedMotion();
  const collapsed = usePref(() => recall('sb-collapsed') === '1', false);
  const narrow = usePref(() => matchMedia('(max-width: 960px)').matches, false);
  const dark = usePref(isDark, true);
  const hue = usePref(() => root().getAttribute('data-hue') ?? 'blue', 'blue');
  const mode = usePref(getMode, 'system' as Mode);
  const demoOff = usePref(demoHidden, false);
  const [drawerWanted, setDrawer] = useState(false);
  const drawer = narrow && drawerWanted;
  const [filter, setFilter] = useState('');
  const [active, setActive] = useState('#top');
  const [settings, setSettings] = useState(false);
  const [capture, setCapture] = useState(false);
  const topbar = useRef<HTMLElement>(null);
  // entrances: the top bar drops in and the menu items slide in one after another (Motion)
  useEffect(() => {
    const items = Array.from(document.querySelectorAll<HTMLElement>('#sidebar .nav li.pre-in'));
    document.documentElement.setAttribute('data-entered', ''); // items shown later (menu filter) are not hidden again
    topbar.current?.classList.remove('pre-drop');
    if (reduce) return;
    const a = topbar.current ? animate(topbar.current, { y: [-16, 0] }, { duration: 0.6, ease: EASE }) : null;
    const b = animate(items, { opacity: [0, 1], x: [18, 0] }, { duration: 0.5, ease: EASE, delay: stagger(0.035, { startDelay: 0.1 }) });
    return () => { a?.stop(); b.stop(); };
  }, [reduce]);
  const sidebar = useRef<HTMLElement>(null), scroller = useRef<HTMLDivElement>(null), pill = useRef<HTMLSpanElement>(null);
  const spyLock = useRef(0); // after a menu click, the clicked item stays active until that scroll ends
  const menuBtn = useRef<HTMLButtonElement>(null), blobs = useRef<HTMLDivElement>(null);
  const pending = book.inbox.filter((i) => i.status === 'ready').length;

  // drawer: page is inert while open; closed drawer is inert on phones. While a window is open it owns inert.
  useEffect(() => {
    const apply = () => {
      if (document.body.hasAttribute('data-sheet')) return;
      const main = document.querySelector<HTMLElement>('.main'), fab = document.querySelector<HTMLElement>('.fab');
      if (sidebar.current) sidebar.current.inert = narrow && !drawer;
      if (main) main.inert = narrow && drawer;
      if (fab) fab.inert = narrow && drawer;
    };
    apply();
    addEventListener('sheet-closed', apply);
    return () => removeEventListener('sheet-closed', apply);
  }, [narrow, drawer]);
  const openDrawer = (o: boolean) => {
    setDrawer(o);
    requestAnimationFrame(() => { if (o) sidebar.current?.querySelector<HTMLElement>('.nav a')?.focus(); else menuBtn.current?.focus(); });
  };
  useEffect(() => {
    if (!drawer) return;
    const k = (e: KeyboardEvent) => {
      if (e.key !== 'Escape') return;
      e.preventDefault();
      setDrawer(false);
      requestAnimationFrame(() => menuBtn.current?.focus());
    };
    addEventListener('keydown', k);
    return () => removeEventListener('keydown', k);
  }, [drawer]);
  useEffect(() => {
    const o = () => setCapture(true);
    addEventListener('open-capture', o);
    return () => removeEventListener('open-capture', o);
  }, []);

  // Motion: controls shrink a little while pressed; the glass catches a soft light under the pointer
  useEffect(() => {
    if (reduce) return;
    let pressed: Element | null = null;
    const down = (e: PointerEvent) => {
      const el = (e.target as Element | null)?.closest?.(PRESSABLE);
      if (!el || (el as HTMLButtonElement).disabled) return;
      pressed = el;
      animate(el, { scale: 0.95 }, { duration: 0.12, ease: 'easeOut' });
    };
    const up = () => {
      if (!pressed) return;
      animate(pressed, { scale: 1 }, { type: 'spring', stiffness: 520, damping: 24 });
      pressed = null;
    };
    document.addEventListener('pointerdown', down);
    document.addEventListener('pointerup', up);
    document.addEventListener('pointercancel', up);
    return () => { document.removeEventListener('pointerdown', down); document.removeEventListener('pointerup', up); document.removeEventListener('pointercancel', up); };
  }, [reduce]);
  useEffect(() => {
    if (reduce || !matchMedia('(hover: hover)').matches) return;
    let raf = 0, last: PointerEvent | null = null;
    const paint = () => {
      raf = 0;
      const g = (last?.target as Element | null)?.closest?.('.glass') as HTMLElement | null;
      if (!g || !last) return;
      const r = g.getBoundingClientRect();
      g.style.setProperty('--mx', `${last.clientX - r.left}px`);
      g.style.setProperty('--my', `${last.clientY - r.top}px`);
    };
    const move = (e: PointerEvent) => { last = e; if (!raf) raf = requestAnimationFrame(paint); };
    document.addEventListener('pointermove', move, { passive: true });
    return () => { document.removeEventListener('pointermove', move); cancelAnimationFrame(raf); };
  }, [reduce]);

  // GSAP: the glass pill slides to the active item; the aurora drifts with the scroll
  const movePill = useCallback((animate: boolean) => {
    const a = sidebar.current?.querySelector<HTMLElement>('.nav .active');
    const p = pill.current;
    if (!p) return;
    if (!a || !a.offsetParent) { p.style.opacity = '0'; return; }
    const li = a.parentElement as HTMLElement;
    p.style.opacity = '1';
    if (animate && !reduce) gsap.to(p, { y: li.offsetTop, height: a.offsetHeight, duration: 0.6, ease: 'power3.out' });
    else gsap.set(p, { y: li.offsetTop, height: a.offsetHeight });
  }, [reduce]);
  useEffect(() => { movePill(true); }, [active, movePill]);
  useEffect(() => { movePill(false); const t = setTimeout(() => movePill(true), 380); return () => clearTimeout(t); }, [collapsed, filter, movePill]);
  useEffect(() => {
    const r = () => movePill(false);
    addEventListener('resize', r);
    return () => removeEventListener('resize', r);
  }, [movePill]);
  useEffect(() => {
    if (reduce || !blobs.current) return;
    const tw = gsap.to(blobs.current, { yPercent: -10, ease: 'none', scrollTrigger: { start: 0, end: 'max', scrub: 0.6 } });
    return () => { tw.scrollTrigger?.kill(); tw.kill(); };
  }, [reduce]);

  // scroll spy: of the sections crossing the band, the one nearest the top wins (two panels can sit side by side);
  // right after a menu click the clicked item stays until that scroll ends.
  useEffect(() => {
    const inBand = new Set<string>();
    const decide = () => {
      if (Date.now() < spyLock.current) return;
      if (scrollY < 80) { setActive('#top'); return; }
      if (innerHeight + scrollY >= document.documentElement.scrollHeight - 4) { setActive('#docs'); return; }
      // of the sections crossing the band, the one that started most recently (largest top above the band) wins,
      // so a short panel beside a tall one still gets its turn
      const line = innerHeight * 0.4;
      let best: string | null = null, bestTop = -Infinity;
      for (const id of SPY) {
        if (!inBand.has(id)) continue;
        const top = document.getElementById(id)!.getBoundingClientRect().top;
        if (top <= line && top > bestTop + 1) { best = id; bestTop = top; }
      }
      if (best) setActive(`#${best}`);
    };
    const io = new IntersectionObserver((entries) => {
      entries.forEach((en) => { if (en.isIntersecting) inBand.add(en.target.id); else inBand.delete(en.target.id); });
      decide();
    }, { rootMargin: '-35% 0px -60% 0px' });
    SPY.forEach((id) => { const el = document.getElementById(id); if (el) io.observe(el); });
    // a menu click holds its item until the user scrolls by hand
    const release = () => { spyLock.current = 0; };
    const keys = (e: KeyboardEvent) => { if (['ArrowDown', 'ArrowUp', 'PageDown', 'PageUp', 'Home', 'End', ' '].includes(e.key)) release(); };
    addEventListener('scroll', decide, { passive: true });
    addEventListener('wheel', release, { passive: true });
    addEventListener('touchmove', release, { passive: true });
    addEventListener('pointerdown', release, { passive: true }); // scrollbar drags; a menu click sets the lock again right after
    addEventListener('keydown', keys);
    return () => { io.disconnect(); removeEventListener('scroll', decide); removeEventListener('wheel', release); removeEventListener('touchmove', release); removeEventListener('pointerdown', release); removeEventListener('keydown', keys); };
  }, []);

  const toggleCollapsed = () => { store('sb-collapsed', collapsed ? '0' : '1'); announce(); };
  const applyHue = (k: string) => { root().setAttribute('data-hue', k); store('hue', k); announce(); };
  const applyMode = (k: Mode) => {
    store('mode', k);
    if (k === 'system') root().removeAttribute('data-theme'); else root().setAttribute('data-theme', k);
    announce();
  };
  const toggleDark = () => applyMode(isDark() ? 'light' : 'dark');

  const navItem = (item: { href?: string; soon?: string; icon: string; label: string; badge?: boolean; live?: boolean }, i: number) => {
    if (filter.trim() && !includesFa(item.label, filter)) return null;
    const inner = (
      <>
        <Icon name={item.icon} />
        <span className="lbl">{item.label}</span>
        {item.badge && pending > 0 && <span className="badge num">{toPersianDigits(pending)}</span>}
        {item.live && <><span className="dot" title="کار در جریان" aria-hidden="true" /><span className="sr-only">، کار در جریان</span></>}
      </>
    );
    return (
      <li key={item.label} className="pre-in" style={{ ['--i' as string]: i }}>
        {item.href ? (
          <a href={item.href} title={item.label} className={active === item.href ? 'active' : undefined} aria-current={active === item.href ? 'page' : undefined}
            onClick={() => { spyLock.current = Number.MAX_SAFE_INTEGER; setActive(item.href!); if (narrow) setDrawer(false); }}>{inner}</a>
        ) : (
          <button type="button" title={item.label} onClick={() => toast(item.soon!, undefined, 'info')}>{inner}</button>
        )}
      </li>
    );
  };

  return (
    <MotionConfig reducedMotion="user">
    <div className="app" id="app">
      <div className="backdrop" aria-hidden="true">
        <div ref={blobs} className="blobs-wrap" style={{ position: 'absolute', inset: 0 }} dangerouslySetInnerHTML={{ __html: BACKDROP }} />
      </div>

      <aside ref={sidebar} id="sidebar" aria-label="منوی اصلی"
        className={`sidebar glass${collapsed && !narrow ? ' collapsed' : ''}${drawer ? ' open' : ''}`}>
        <div className="brand">
          <div className="brand-mark"><Icon name="building" /></div>
          <div className="brand-text"><b>دفتر ساختمان</b><span>{book.workspaceName}</span></div>
          <button className="collapse-btn" type="button" aria-label={collapsed ? 'باز کردن منو' : 'جمع کردن منو'} aria-expanded={!collapsed} onClick={toggleCollapsed}>
            <Icon name="dbl" size="sm" />
          </button>
          <button className="icon-btn drawer-close" type="button" aria-label="بستن منو" onClick={() => openDrawer(false)}><Icon name="x" /></button>
        </div>
        <label className="side-search" title="جستجو" onClick={() => { if (collapsed && !narrow) toggleCollapsed(); }}>
          <Icon name="search" size="sm" />
          <span className="sr-only">جستجو در منو</span>
          <input type="search" placeholder="جستجو در منو" value={filter} onChange={(e) => setFilter(e.target.value)} />
        </label>
        <div className="side-scroll" ref={scroller}>
          <span className="nav-ind" ref={pill} aria-hidden="true" />
          <div className="nav-label">اصلی</div>
          <ul className="nav">{NAV_MAIN.map((it, i) => navItem(it, i))}</ul>
          <div className="nav-label">پروژه</div>
          <ul className="nav">{NAV_PROJECT.map((it, i) => navItem(it, NAV_MAIN.length + i))}</ul>
        </div>
        <div className="side-foot">
          <ul className="nav">
            <li>
              <button type="button" title="تنظیمات" aria-haspopup="dialog" onClick={() => { if (narrow) setDrawer(false); setSettings(true); }}>
                <Icon name="sliders" /><span className="lbl">تنظیمات</span>
              </button>
            </li>
          </ul>
          <div className="user">
            <span className="avatar" aria-hidden="true">{initialsFa(book.ownerName)}</span>
            <div><b>{book.ownerName}</b><small>صاحب‌کار</small></div>
            <button className="theme-btn" type="button" role="switch" aria-checked={dark} aria-label="حالت شب" title="حالت شب" onClick={toggleDark}>
              <Icon name="moon" size="sm" />
            </button>
          </div>
        </div>
      </aside>
      {drawer && <div className="drawer-scrim" onClick={() => openDrawer(false)} />}

      <div className="main" id="top">
        <header className="topbar glass pre-drop" ref={topbar}>
          <button ref={menuBtn} className="icon-btn menu-btn" type="button" aria-label="باز کردن منو" aria-controls="sidebar" aria-expanded={drawer} onClick={() => openDrawer(true)}>
            <Icon name="menu" />
          </button>
          <div className="page-title">
            <h1>داشبورد</h1>
            <p>{formatJalali(book.today, { weekday: true })} <span className="sample-chip">دادهٔ نمونه</span></p>
          </div>
          <span className="sr-only" id="projectDdLbl">دفتر</span>
          <Dropdown className="project-dd" labelledBy="projectDdLbl" value="project"
            options={[{ value: 'project', label: `پروژه: ${book.ledgers.find((l) => l.kind === 'project')?.name ?? ''}`, hint: book.projectHint }, { value: 'company', label: 'دفتر شرکت', hint: 'هزینه‌های جاری' }, { value: 'personal', label: 'دفتر شخصی', hint: 'خانواده' }]}
            onChange={(v) => { if (v !== 'project') toast('دفترهای دیگر بعد از وصل شدن به سرور باز می‌شوند', undefined, 'info'); }} />
          <label className="top-search">
            <Icon name="search" size="sm" />
            <span className="sr-only">جستجو در تراکنش‌ها</span>
            <input type="search" placeholder="جستجو در تراکنش‌ها…" onKeyDown={(e) => {
              if (e.key === 'Enter') window.dispatchEvent(new CustomEvent('tx-search', { detail: (e.target as HTMLInputElement).value }));
            }} />
          </label>
          <motion.button className="btn primary capture-top" type="button" whileTap={{ scale: 0.95 }} onClick={() => setCapture(true)}>
            <Icon name="mic" />ثبت سریع
          </motion.button>
        </header>
        {!demoOff && (
          <div className="demo-bar glass" role="note">
            <Icon name="alert" size="sm" />
            <span className="demo-text"><b>نسخهٔ نمایشی.</b><span className="demo-long"> هنوز به سرور وصل نیست: ویس ضبط نمی‌شود، عکس‌ها خوانده نمی‌شوند و هر تغییری با تازه کردن صفحه پاک می‌شود.</span><span className="demo-short"> تغییرها ذخیره نمی‌شوند.</span></span>
            <button className="icon-btn sm demo-x" type="button" aria-label="بستن این پیام" onClick={hideDemo}><Icon name="x" size="sm" /></button>
          </div>
        )}
        {children}
      </div>

      <button className="fab" type="button" onClick={() => setCapture(true)}><Icon name="mic" />ثبت سریع</button>

      <Sheet open={settings} onClose={() => setSettings(false)} returnFocus=".menu-btn">
        <SheetHead icon="sliders" kind="voice" title="تنظیمات" sub="فقط روی همین دستگاه ذخیره می‌شود" onClose={() => setSettings(false)} />
        <div className="sheet-body">
          <section className="set-sec">
            <h3 className="set-h" id="setHueH">رنگ داشبورد</h3>
            <div className="hue-cards" role="radiogroup" aria-labelledby="setHueH" onKeyDown={(e) => radioKeys(e, HUES.map((h) => h.k), hue, applyHue)}>
              {HUES.map((h) => (
                <button key={h.k} type="button" role="radio" className="hue-card" data-k={h.k} aria-checked={h.k === hue} tabIndex={h.k === hue ? 0 : -1} onClick={() => applyHue(h.k)}>
                  <span className="hue-prev" aria-hidden="true" style={{ ['--p1' as string]: h.c[0], ['--p2' as string]: h.c[1], ['--p3' as string]: h.c[2] }}>
                    <i /><i /><i /><span className="hue-glass"><b /><b /><b /></span><Icon name="check" size="sm" className="hue-tick" />
                  </span>
                  <span className="hue-name">{h.v}</span>
                </button>
              ))}
            </div>
          </section>
          <section className="set-sec">
            <h3 className="set-h" id="setModeH">حالت نمایش</h3>
            <div className="seg mode-seg" role="radiogroup" aria-labelledby="setModeH" onKeyDown={(e) => radioKeys(e, MODES.map((m) => m.k), mode, (k) => applyMode(k as Mode))}>
              {MODES.map((m) => (
                <button key={m.k} type="button" role="radio" data-k={m.k} aria-checked={m.k === mode} tabIndex={m.k === mode ? 0 : -1} onClick={() => applyMode(m.k)}>{m.v}</button>
              ))}
            </div>
            <p className="why">«مثل سیستم» یعنی داشبورد همان حالت روشن یا تیرهٔ گوشی یا کامپیوترتان را می‌گیرد.</p>
          </section>
        </div>
        <div className="sheet-foot"><button className="btn primary" type="button" onClick={() => setSettings(false)}><Icon name="check" />انجام شد</button></div>
      </Sheet>

      <CaptureSheet open={capture} onClose={() => setCapture(false)} />
    </div>
    </MotionConfig>
  );
}

/** Arrow keys move the choice inside a radio group (RTL: left is "next"). */
function radioKeys(e: React.KeyboardEvent, keys: readonly string[], current: string, set: (k: string) => void) {
  const step = ({ ArrowLeft: 1, ArrowDown: 1, ArrowRight: -1, ArrowUp: -1 } as Record<string, number>)[e.key];
  if (!step) return;
  e.preventDefault();
  const group = e.currentTarget as HTMLElement;
  const next = keys[(keys.indexOf(current) + step + keys.length) % keys.length];
  set(next);
  requestAnimationFrame(() => group.querySelector<HTMLElement>(`[data-k="${next}"]`)?.focus());
}
