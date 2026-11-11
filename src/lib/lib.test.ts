import { describe, expect, it } from 'vitest';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { formatShortToman, formatToman, parseWholeNumber, rialToToman, toLatinDigits, toPersianDigits, tomanToRial } from './money';
import { addDays, daysBetween, formatJalali, formatJalaliMonth, isoToJalali, jalaliToIso, monthLength, todayTehran, weekdayIndex } from './jalali';
import { DOC_CATEGORIES, describeEffect, validateDraft, type EffectContext } from './drafts';

const M = 10_000_000n; // one million Toman in Rial

describe('money', () => {
  it('reads amounts typed or spoken with Persian or Latin digits and separators', () => {
    expect(parseWholeNumber('۱۲٬۰۰۰٬۰۰۰')).toBe(12_000_000n);
    expect(parseWholeNumber('12,000,000')).toBe(12_000_000n);
    expect(parseWholeNumber('١٢ ٠٠٠')).toBe(12_000n);
    expect(parseWholeNumber('۱۲.۵')).toBeNull();
    expect(parseWholeNumber('')).toBeNull();
    expect(toLatinDigits('۴۸۲۱۹۰')).toBe('482190');
    expect(toPersianDigits('1405')).toBe('۱۴۰۵');
  });

  it('stores Rial and shows Toman', () => {
    expect(tomanToRial(8_500_000n)).toBe(85_000_000n);
    expect(rialToToman(85_000_000n)).toBe(8_500_000n);
    expect(rialToToman(15n)).toBe(2n);
    expect(formatToman(120_000_000n)).toBe('۱۲٬۰۰۰٬۰۰۰ تومان');
    expect(formatToman(-120_000_000n, { unit: false })).toBe('−۱۲٬۰۰۰٬۰۰۰');
    expect(formatToman(2_000_000_000n, { unit: false, sign: true })).toBe('+۲۰۰٬۰۰۰٬۰۰۰');
  });

  it('short form for cards', () => {
    expect(formatShortToman(12n * M)).toBe('۱۲ میلیون');
    expect(formatShortToman(124n * M / 100n)).toBe('۱٫۲۴ میلیون');
    expect(formatShortToman(21_900n * M)).toBe('۲۱٫۹ میلیارد');
    expect(formatShortToman(8_500_000n)).toBe('۸۵۰ هزار');
    expect(formatShortToman(-6n * M)).toBe('−۶ میلیون');
  });
});

describe('jalali dates', () => {
  it('converts both ways', () => {
    expect(isoToJalali('2026-11-10')).toEqual({ jy: 1405, jm: 8, jd: 19 });
    expect(jalaliToIso({ jy: 1405, jm: 1, jd: 1 })).toBe('2026-03-21');
    expect(() => jalaliToIso({ jy: 1404, jm: 12, jd: 30 })).toThrow();
    expect(monthLength(1403, 12)).toBe(30); // leap year
    expect(monthLength(1404, 12)).toBe(29);
  });

  it('formats for people', () => {
    expect(formatJalali('2026-11-10', { weekday: true })).toBe('سه‌شنبه ۱۹ آبان ۱۴۰۵');
    expect(formatJalali('2026-11-10', { withYear: false })).toBe('۱۹ آبان');
    expect(formatJalaliMonth(1405, 8)).toBe('آبان ۱۴۰۵');
    expect(weekdayIndex('2026-11-07')).toBe(0); // a Saturday
  });

  it('knows the business day in Tehran, not the server\'s zone', () => {
    // 21:00 UTC on 9 Nov is already 00:30 on 10 Nov in Tehran (UTC+3:30, no daylight saving since 1401)
    expect(todayTehran(new Date('2026-11-09T21:00:00Z'))).toBe('2026-11-10');
    expect(todayTehran(new Date('2026-06-15T20:00:00Z'))).toBe('2026-06-15');
    expect(daysBetween('2026-11-10', '2026-12-08')).toBe(28);
    expect(addDays('2026-11-10', 28)).toBe('2026-12-08');
  });
});

describe('cards', () => {
  const ids = {
    bank: '11111111-1111-4111-8111-111111111111',
    personal: '22222222-2222-4222-8222-222222222222',
    rezaei: '33333333-3333-4333-8333-333333333333',
    crew: '44444444-4444-4444-8444-444444444444',
    frame: '55555555-5555-4555-8555-555555555555',
  };
  const ctx: EffectContext = {
    accounts: { [ids.bank]: { name: 'بانک ملت', ledgerKind: 'project' }, [ids.personal]: { name: 'پاسارگاد', ledgerKind: 'personal' } },
    people: { [ids.rezaei]: { name: 'حسین رضایی', owedRial: 18n * M }, [ids.crew]: { name: 'کارگران روزمزد', owedRial: 0n } },
    stages: { [ids.frame]: { name: 'اسکلت' } },
    today: '2026-11-10',
  };

  it('checks the same rules as the database before anything is sent', () => {
    expect(validateDraft('payment', { amount_rial: '0', account_id: ids.bank })).toEqual({ ok: false, errors: { amount_rial: 'مبلغ باید بیشتر از صفر باشد' } });
    expect(validateDraft('transfer', { amount_rial: '10', from_account_id: ids.bank, to_account_id: ids.bank })).toMatchObject({ ok: false, errors: { to_account_id: 'مبدأ و مقصد یکی است' } });
    expect(validateDraft('work_log', { headcount: 5, wage_rial: '12000000', paid: false })).toMatchObject({ ok: false, errors: { crew_person_id: 'طلب به چه کسی است؟' } });
    expect(validateDraft('work_log', { headcount: 5, wage_rial: '12000000', paid: true })).toMatchObject({ ok: false, errors: { account_id: 'از کدام حساب پرداخت شد؟' } });
    expect(validateDraft('document', { title: 'نامه', category_code: 'nope' }).ok).toBe(false);
    expect(validateDraft('daily_note', { body: '  ' }).ok).toBe(false);
    expect(validateDraft('payment', { amount_rial: '120000000', account_id: ids.bank, settles: true }).ok).toBe(false); // settling needs the person
    expect(validateDraft('payment', { amount_rial: '120000000', account_id: ids.bank, person_id: 'p', settles: true }).ok).toBe(true);
  });

  it('says what confirming will change', () => {
    const pay = validateDraft('payment', { amount_rial: (12n * M).toString(), account_id: ids.bank, person_id: ids.rezaei, settles: true });
    if (!pay.ok) throw new Error('invalid');
    expect(describeEffect('payment', pay.fields, ctx)).toBe('موجودی بانک ملت ۱۲ میلیون تومان کم می‌شود. طلب حسین رضایی از ۱۸ میلیون به ۶ میلیون تومان می‌رسد.');

    const personal = validateDraft('payment', { amount_rial: (124n * M / 100n).toString(), account_id: ids.personal });
    if (!personal.ok) throw new Error('invalid');
    expect(describeEffect('payment', personal.fields, ctx)).toBe('از حساب شخصی شما می‌رود و پروژه ۱٫۲۴ میلیون تومان به شما بدهکار می‌شود. به خرج هزینه‌های عمومی پروژه اضافه می‌شود.');

    const work = validateDraft('work_log', { headcount: 5, wage_rial: (12n * M / 10n).toString(), paid: false, crew_person_id: ids.crew, stage_id: ids.frame });
    if (!work.ok) throw new Error('invalid');
    expect(describeEffect('work_log', work.fields, ctx)).toBe('۶ میلیون تومان به خرج مرحلهٔ «اسکلت» اضافه می‌شود و کارگران روزمزد همین مبلغ را طلب می‌کنند. ۵ نفر در کارکرد ۱۹ آبان ثبت می‌شوند.');

    const doc = validateDraft('document', { title: 'نامهٔ تمدید پروانه', category_code: 'municipality' });
    if (!doc.ok) throw new Error('invalid');
    expect(describeEffect('document', doc.fields, ctx)).toBe('در «اسناد و نقشه‌ها»، دستهٔ «شهرداری» با برچسب «منتظر فایل» ثبت می‌شود.');
  });

  it('document categories match the database', () => {
    const sql = readFileSync(join(process.cwd(), 'supabase/migrations/20261110090150_reference_data.sql'), 'utf8');
    const block = sql.slice(sql.indexOf('insert into public.doc_categories'), sql.indexOf('insert into public.doc_disciplines'));
    const fromSql = Object.fromEntries([...block.matchAll(/\('(\w+)', \d+, '([^']+)'\)/g)].map((m) => [m[1], m[2]]));
    expect(fromSql).toEqual(DOC_CATEGORIES);
  });
});
