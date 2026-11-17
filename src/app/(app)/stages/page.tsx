import type { Metadata } from 'next';
import { StagesPage } from '@/components/pages';

export const metadata: Metadata = { title: 'مراحل ساخت · دفتر ساختمان' };

export default function Page() {
  return <StagesPage />;
}
