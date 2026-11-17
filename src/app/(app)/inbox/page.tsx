import type { Metadata } from 'next';
import { InboxPage } from '@/components/pages';

export const metadata: Metadata = { title: 'منتظر تأیید · دفتر ساختمان' };

export default function Page() {
  return <InboxPage />;
}
