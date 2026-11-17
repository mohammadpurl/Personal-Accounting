import type { Metadata } from 'next';
import { DocumentsPage } from '@/components/pages';

export const metadata: Metadata = { title: 'اسناد و نقشه‌ها · دفتر ساختمان' };

export default function Page() {
  return <DocumentsPage />;
}
