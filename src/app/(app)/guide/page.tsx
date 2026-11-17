import type { Metadata } from 'next';
import { GuidePage } from '@/components/pages';

export const metadata: Metadata = { title: 'راهنمای ثبت · دفتر ساختمان' };

export default function Page() {
  return <GuidePage />;
}
