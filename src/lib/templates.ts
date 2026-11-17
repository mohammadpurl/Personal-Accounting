// Record templates («الگوی ثبت»): for every kind of entry, what must be said, what may be said, sample sentences,
// and the page where the confirmed record lands. Used by the assistant (destination of each card), the
// «راهنمای ثبت» page (teaching people how to speak), the review sheet and, later, the AI extraction prompts.
import type { DraftKind } from './drafts';

export interface RecordTemplate {
  key: DraftKind | 'purchase' | 'inspection';
  label: string;
  icon: string;
  tone: 'neg' | 'pos' | 'info' | 'accent' | 'warn';
  href: string; // page where the record is kept
  page: string; // that page's name
  required: string[];
  optional: string[];
  examples: string[];
  tip: string;
  soon?: boolean; // not recorded yet; shown so people know it is coming
}

export const TEMPLATES: RecordTemplate[] = [
  {
    key: 'payment', label: 'پرداخت', icon: 'out', tone: 'neg', href: '/transactions', page: 'حساب‌ها و تراکنش‌ها',
    required: ['مبلغ', 'به چه کسی', 'از کدام حساب'],
    optional: ['بابت چه کاری یا کدام مرحله', 'روش (کارت به کارت، پایا، نقد)', 'تسویهٔ بدهی قبلی است یا خرج تازه', 'تاریخ اگر امروز نیست'],
    examples: ['دوازده میلیون کارت به کارت از ملت به آقای رضایی دادم، بابت آرماتوربندی', 'سه میلیون نقد از تنخواه برای بیست کیسه سیمان به مصالح‌فروشی امید'],
    tip: 'اگر بدهی قبلی را می‌دهید بگویید «بابت طلبش»، تا خرج تازه حساب نشود.',
  },
  {
    key: 'receipt', label: 'دریافت', icon: 'in', tone: 'pos', href: '/transactions', page: 'حساب‌ها و تراکنش‌ها',
    required: ['مبلغ', 'از چه کسی', 'به کدام حساب'],
    optional: ['بابت چه', 'روش', 'تاریخ'],
    examples: ['دویست میلیون آورده گذاشتم به حساب ملت', 'پیش‌خریدار واحد دو، صد و پنجاه میلیون پایا به ملت زد'],
    tip: 'نام حساب را بگویید؛ اگر نگویید، دستیار می‌پرسد.',
  },
  {
    key: 'cheque', label: 'چک', icon: 'receipt', tone: 'warn', href: '/cheques', page: 'چک‌ها',
    required: ['صادر کردید یا گرفتید', 'مبلغ', 'طرف چک', 'تاریخ سررسید', 'از کدام حساب (فقط چکی که خودتان می‌دهید)'],
    optional: ['بانک', 'شمارهٔ صیادی (۱۶ رقم)', 'بابت چه یا کدام مرحله', 'برای بدهی قبلی است یا خرید تازه'],
    examples: ['یک چک صادر کردم به آهن‌آلات صالحی، صد و بیست میلیون، سررسید سی آبان، از حساب ملت', 'از خانم نادری یک چک سیصد میلیونی گرفتم، سررسید پانزده آذر'],
    tip: 'عکس روی چک را هم بفرستید تا شمارهٔ صیادی و بانک خوانده شود. پاس شدن، برگشت خوردن یا وصول چک را در صفحهٔ «چک‌ها» بزنید، نه با ویس.',
  },
  {
    key: 'transfer', label: 'انتقال بین حساب‌ها', icon: 'swap', tone: 'info', href: '/transactions', page: 'حساب‌ها و تراکنش‌ها',
    required: ['مبلغ', 'از کدام حساب', 'به کدام حساب'],
    optional: ['تاریخ'],
    examples: ['سی میلیون از ملت ریختم به تنخواه کارگاه'],
    tip: 'انتقال خرج حساب نمی‌شود؛ فقط پول جابه‌جا می‌شود.',
  },
  {
    key: 'work_log', label: 'کارکرد کارگر', icon: 'hat', tone: 'accent', href: '/workers', page: 'کارکرد کارگرها',
    required: ['تعداد نفر', 'چه کاری یا کدام مرحله', 'دستمزد هر نفر', 'پرداخت شد یا نه'],
    optional: ['از کدام حساب (اگر پرداخت شد)', 'طلب با کیست؛ سرگروه یا «کارگران روزمزد» (اگر پرداخت نشد)', 'تاریخ اگر امروز نیست (دیروز، پریروز یا روز و ماه)'],
    examples: ['امروز پنج کارگر داشتیم، سقف دوم، نفری یک میلیون و دویست، هنوز ندادم', 'دیروز سه نفر نظافت کارگاه، نفری نهصد هزار، از تنخواه دادم'],
    tip: 'اگر دستمزد را نگویید، دستیار می‌پرسد. اگر نگویید پرداخت شد یا نه، «پرداخت نشده» فرض می‌شود.',
  },
  {
    key: 'stage_progress', label: 'پیشرفت مرحله', icon: 'layers', tone: 'pos', href: '/stages', page: 'مراحل ساخت',
    required: ['کدام مرحله', 'درصد یا «تمام شد»'],
    optional: ['کدام بخش از کار'],
    examples: ['سفت‌کاری ده درصد جلو رفته', 'اسکلت هفتاد و پنج درصد است'],
    tip: 'پیشرفت را فقط صاحب‌کار تأیید می‌کند؛ سرکارگر فقط خبر می‌دهد.',
  },
  {
    key: 'daily_note', label: 'یادداشت روزانه', icon: 'msg', tone: 'warn', href: '/notes', page: 'یادداشت‌ها',
    required: ['متن'],
    optional: ['مرحله', 'تاریخ'],
    examples: ['یادداشت کن: مهندس احمدی گفت قبل از بتن‌ریزی صورت‌جلسه امضا شود'],
    tip: 'هر چیزی که جای دیگری ندارد اینجا می‌آید؛ با «یادداشت کن» شروع کنید.',
  },
  {
    key: 'document', label: 'سند یا نقشه', icon: 'folder', tone: 'info', href: '/documents', page: 'اسناد و نقشه‌ها',
    required: ['نوع سند', 'دسته (شهرداری، نقشه، قرارداد…)'],
    optional: ['رشته (معماری، سازه، آب، برق، گاز)', 'وضعیت (پیش‌نویس، مصوب، اجرایی)', 'صادرکننده', 'تاریخ اعتبار'],
    examples: ['نقشهٔ اجرایی برق را از مهندس گرفتم', 'نامهٔ تمدید پروانه از شهرداری آمد'],
    tip: 'فایل را «به‌صورت فایل» بفرستید، نه عکس، تا کیفیت از بین نرود. برای نقشهٔ اتوکد، PDF همان برگ را هم بفرستید.',
  },
  {
    key: 'purchase', label: 'خرید مصالح با فاکتور', icon: 'file', tone: 'neg', href: '/transactions', page: 'حساب‌ها و تراکنش‌ها',
    required: ['قلم', 'مقدار و واحد', 'مبلغ', 'فروشنده'],
    optional: ['مرحله', 'پرداخت شد یا نسیه'],
    examples: ['شش تن میلگرد شانزده از صالحی، صد و نود و هشت میلیون، نسیه'],
    tip: 'فعلاً به‌صورت «پرداخت» ثبت می‌شود؛ فهرست اقلام و انبار به‌زودی می‌آید.', soon: true,
  },
  {
    key: 'inspection', label: 'بازدید ناظر', icon: 'check-board', tone: 'info', href: '/notes', page: 'یادداشت‌ها',
    required: ['ناظر', 'نظر یا ایراد'],
    optional: ['مهلت رفع', 'مرحله'],
    examples: ['مهندس احمدی آمد، گفت کاور میلگرد ستون‌ها کم است، تا شنبه درست شود'],
    tip: 'فعلاً به‌صورت یادداشت روزانه ثبت می‌شود؛ پیگیری ایرادها به‌زودی می‌آید.', soon: true,
  },
];

export const templateOf = (key: string) => TEMPLATES.find((t) => t.key === key);
