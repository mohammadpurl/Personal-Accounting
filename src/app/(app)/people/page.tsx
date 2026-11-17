import type { Metadata } from 'next';
import { PeoplePage } from '@/components/pages';

export const metadata: Metadata = { title: 'اشخاص · دفتر ساختمان' };

export default function Page() {
  return <PeoplePage />;
}
