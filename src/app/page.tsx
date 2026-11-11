import { AppShell } from '@/components/shell';
import { Dashboard } from '@/components/dashboard';
import { ToastProvider } from '@/components/ui';
import { BookProvider } from '@/state/book';

export default function Home() {
  return (
    <BookProvider>
      <ToastProvider>
        <AppShell>
          <Dashboard />
        </AppShell>
      </ToastProvider>
    </BookProvider>
  );
}
