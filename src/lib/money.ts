// Money is stored in Rial (bigint) and shown in Toman with Persian digits.

const PERSIAN = '۰۱۲۳۴۵۶۷۸۹';
const ARABIC = '٠١٢٣٤٥٦٧٨٩';

export function toPersianDigits(s: string | number | bigint): string {
  return String(s).replace(/[0-9]/g, (d) => PERSIAN[Number(d)]);
}

export function toLatinDigits(s: string): string {
  return s
    .replace(/[۰-۹]/g, (d) => String(PERSIAN.indexOf(d)))
    .replace(/[٠-٩]/g, (d) => String(ARABIC.indexOf(d)));
}

/** "۱۲٬۰۰۰٬۰۰۰" / "12,000,000" / "۱۲ ۰۰۰ ۰۰۰" → 12000000n. Returns null for anything that is not a whole number. */
export function parseWholeNumber(input: string): bigint | null {
  const s = toLatinDigits(input).replace(/[\s,٬،_]/g, '');
  if (!/^\d+$/.test(s)) return null;
  return BigInt(s);
}

export const tomanToRial = (toman: bigint): bigint => toman * 10n;

/** Rial → Toman, rounded half away from zero (Rial amounts are almost always whole Toman). */
export function rialToToman(rial: bigint): bigint {
  const q = rial / 10n;
  const r = rial % 10n;
  if (r >= 5n) return q + 1n;
  if (r <= -5n) return q - 1n;
  return q;
}

function group(n: bigint): string {
  const neg = n < 0n;
  const digits = (neg ? -n : n).toString().replace(/\B(?=(\d{3})+(?!\d))/g, '٬');
  return (neg ? '−' : '') + toPersianDigits(digits);
}

/** 120000000n (Rial) → "۱۲٬۰۰۰٬۰۰۰ تومان" */
export function formatToman(rial: bigint, opts: { unit?: boolean; sign?: boolean } = {}): string {
  const t = rialToToman(rial);
  let s = group(t);
  if (opts.sign && t > 0n) s = '+' + s;
  return opts.unit === false ? s : `${s} تومان`;
}

function decimals(value: number, max: number): string {
  const s = value.toFixed(max).replace(/\.?0+$/, '');
  return toPersianDigits(s.replace('.', '٫'));
}

/** Short form for cards and summaries: "۱۲ میلیون", "۱٫۲۴ میلیون", "۲٫۱۹ میلیارد", "۸۵۰ هزار". */
export function formatShortToman(rial: bigint): string {
  const t = rialToToman(rial);
  const abs = t < 0n ? -t : t;
  const sign = t < 0n ? '−' : '';
  if (abs >= 1_000_000_000n) return `${sign}${decimals(Number(abs) / 1e9, 2)} میلیارد`;
  if (abs >= 1_000_000n) return `${sign}${decimals(Number(abs) / 1e6, 2)} میلیون`;
  if (abs >= 1_000n) return `${sign}${decimals(Number(abs) / 1e3, 1)} هزار`;
  return `${sign}${toPersianDigits(abs.toString())}`;
}
