import type { Metadata } from 'next';
import { NotesPage } from '@/components/pages';

export const metadata: Metadata = { title: 'یادداشت‌ها · دفتر ساختمان' };

export default function Page() {
  return <NotesPage />;
}
