// Dates: stored as Gregorian ISO dates (YYYY-MM-DD) in Asia/Tehran, shown in the Jalali calendar.
import { isValidJalaaliDate, jalaaliMonthLength, toGregorian, toJalaali } from 'jalaali-js';
import { toPersianDigits } from './money';

export const JALALI_MONTHS = ['فروردین', 'اردیبهشت', 'خرداد', 'تیر', 'مرداد', 'شهریور', 'مهر', 'آبان', 'آذر', 'دی', 'بهمن', 'اسفند'] as const;
/** Persian week starts on Saturday. */
export const WEEKDAYS = ['شنبه', 'یکشنبه', 'دوشنبه', 'سه‌شنبه', 'چهارشنبه', 'پنجشنبه', 'جمعه'] as const;
export const WEEKDAYS_SHORT = ['ش', 'ی', 'د', 'س', 'چ', 'پ', 'ج'] as const;

export interface JDate { jy: number; jm: number; jd: number }

function parseIso(iso: string): { gy: number; gm: number; gd: number } {
  const m = /^(\d{4})-(\d{2})-(\d{2})$/.exec(iso);
  if (!m) throw new Error(`not an ISO date: ${iso}`);
  return { gy: Number(m[1]), gm: Number(m[2]), gd: Number(m[3]) };
}

const pad = (n: number) => String(n).padStart(2, '0');

export function isoToJalali(iso: string): JDate {
  const { gy, gm, gd } = parseIso(iso);
  return toJalaali(gy, gm, gd);
}

export function jalaliToIso(d: JDate): string {
  if (!isValidJalaaliDate(d.jy, d.jm, d.jd)) throw new Error(`not a valid Jalali date: ${d.jy}/${d.jm}/${d.jd}`);
  const g = toGregorian(d.jy, d.jm, d.jd);
  return `${g.gy}-${pad(g.gm)}-${pad(g.gd)}`;
}

export const monthLength = (jy: number, jm: number) => jalaaliMonthLength(jy, jm);

/** Column of a date in a Saturday-first week (0 = Saturday … 6 = Friday). */
export function weekdayIndex(iso: string): number {
  const { gy, gm, gd } = parseIso(iso);
  const js = new Date(Date.UTC(gy, gm - 1, gd)).getUTCDay(); // 0 = Sunday
  return (js + 1) % 7;
}

/** Today's business date in Tehran, whatever the server's own time zone. */
export function todayTehran(now: Date = new Date()): string {
  const parts = new Intl.DateTimeFormat('en-CA', { timeZone: 'Asia/Tehran', year: 'numeric', month: '2-digit', day: '2-digit' }).formatToParts(now);
  const get = (t: string) => parts.find((p) => p.type === t)!.value;
  return `${get('year')}-${get('month')}-${get('day')}`;
}

/** Years without a thousands separator: "۱۴۰۵". */
const year = (jy: number) => toPersianDigits(jy);

/** "۱۹ آبان ۱۴۰۵" (or "۱۹ آبان" with withYear false; "سه‌شنبه ۱۹ آبان ۱۴۰۵" with weekday). */
export function formatJalali(iso: string, opts: { withYear?: boolean; weekday?: boolean } = {}): string {
  const d = isoToJalali(iso);
  const base = `${toPersianDigits(d.jd)} ${JALALI_MONTHS[d.jm - 1]}`;
  const withYear = opts.withYear === false ? base : `${base} ${year(d.jy)}`;
  return opts.weekday ? `${WEEKDAYS[weekdayIndex(iso)]} ${withYear}` : withYear;
}

/** "آبان ۱۴۰۵" for calendar headers. */
export const formatJalaliMonth = (jy: number, jm: number) => `${JALALI_MONTHS[jm - 1]} ${year(jy)}`;

/** Days from a to b (b − a), both ISO dates. */
export function daysBetween(a: string, b: string): number {
  const x = parseIso(a), y = parseIso(b);
  return Math.round((Date.UTC(y.gy, y.gm - 1, y.gd) - Date.UTC(x.gy, x.gm - 1, x.gd)) / 86_400_000);
}

export function addDays(iso: string, days: number): string {
  const { gy, gm, gd } = parseIso(iso);
  const t = new Date(Date.UTC(gy, gm - 1, gd + days));
  return `${t.getUTCFullYear()}-${pad(t.getUTCMonth() + 1)}-${pad(t.getUTCDate())}`;
}
