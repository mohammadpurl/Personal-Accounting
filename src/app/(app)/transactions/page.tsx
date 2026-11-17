import type { Metadata } from 'next';
import { TransactionsPage } from '@/components/pages';

export const metadata: Metadata = { title: 'حساب‌ها و تراکنش‌ها · دفتر ساختمان' };

export default function Page() {
  return <TransactionsPage />;
}
