import type { Metadata } from 'next';
import { WorkersPage } from '@/components/pages';

export const metadata: Metadata = { title: 'کارکرد کارگرها · دفتر ساختمان' };

export default function Page() {
  return <WorkersPage />;
}
