// Persian text matching: Arabic ي/ك equal Persian ی/ک, Persian/Arabic digits equal Latin, half-spaces count as spaces.
import { toLatinDigits } from './money';

export const normFa = (s: string) => toLatinDigits(s).replace(/ي/g, 'ی').replace(/ك/g, 'ک').replace(/\u200c/g, ' ').trim().toLowerCase();
/** «مهدی کریمی» → «م‌ک»: first letters of the first two words. */
export const initialsFa = (name: string) => name.split(/\s+/).filter(Boolean).slice(0, 2).map((w) => w[0]).join('‌');
export const includesFa = (text: string, term: string) => normFa(text).includes(normFa(term));
