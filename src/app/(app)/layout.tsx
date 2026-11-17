import { AppShell } from '@/components/shell';
import { ToastProvider } from '@/components/ui';
import { SheetsProvider } from '@/components/sheets';
import { BookProvider } from '@/state/book';

// Shared by every page: the books, toasts, the frame and the windows. Kept across navigation, so the sample
// data and what you just confirmed survive moving between pages.
export default function AppLayout({ children }: { children: React.ReactNode }) {
  return (
    <BookProvider>
      <ToastProvider>
        <SheetsProvider>
          <AppShell>{children}</AppShell>
        </SheetsProvider>
      </ToastProvider>
    </BookProvider>
  );
}
