import type { Metadata } from 'next';
import { ChequesPage } from '@/components/pages';

export const metadata: Metadata = { title: 'چک‌ها · دفتر ساختمان' };

export default function Page() {
  return <ChequesPage />;
}
