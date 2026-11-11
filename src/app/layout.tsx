import type { Metadata, Viewport } from 'next';
import { Vazirmatn } from 'next/font/google';
import { SPRITE } from '@/components/sprite';
import './globals.css';
import './app.css';

// Self-hosted at build time by next/font: the live site never calls Google, which matters on a server in Iran.
const vazirmatn = Vazirmatn({ subsets: ['arabic', 'latin'], variable: '--font-vazirmatn', display: 'swap' });

export const metadata: Metadata = {
  title: 'دفتر ساختمان',
  description: 'مدیریت و حسابداری ساخت ساختمان با ویس و عکس',
};

export const viewport: Viewport = { width: 'device-width', initialScale: 1, viewportFit: 'cover' };

// Palette and light/dark choice from Settings, applied before the first paint so the page never flashes.
const THEME_INIT = `try{var d=document.documentElement,h=localStorage.getItem('hue'),m=localStorage.getItem('mode');d.dataset.hue=['blue','violet','teal'].indexOf(h)>-1?h:'blue';if(m==='light'||m==='dark')d.dataset.theme=m;}catch(e){}`;

export default function RootLayout({ children }: Readonly<{ children: React.ReactNode }>) {
  return (
    <html lang="fa" dir="rtl" data-hue="blue" className={vazirmatn.variable} suppressHydrationWarning>
      <head>
        <script dangerouslySetInnerHTML={{ __html: THEME_INIT }} />
      </head>
      <body>
        <div aria-hidden="true" style={{ position: 'absolute', width: 0, height: 0, overflow: 'hidden' }} dangerouslySetInnerHTML={{ __html: SPRITE }} />
        {children}
      </body>
    </html>
  );
}
