import type { Metadata } from 'next';
import { ArchivePage } from '@/components/pages';

export const metadata: Metadata = { title: 'بایگانی · دفتر ساختمان' };

export default function Page() {
  return <ArchivePage />;
}
