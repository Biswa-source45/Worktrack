import type { Metadata } from 'next';
import type { ReactNode } from 'react';
import './globals.css';
import { Plus_Jakarta_Sans } from 'next/font/google';
import { Providers } from '@/components/providers';
import { themeScript } from '@/lib/theme';
import { themeCss } from '@/lib/theme-css';

const jakarta = Plus_Jakarta_Sans({
  subsets: ['latin'],
  weight: ['400', '500', '600', '700'],
  variable: '--font-sans',
});

export const metadata: Metadata = {
  title: 'WorkTrack Admin',
  description: 'WorkTrack admin portal',
};

export default function RootLayout({ children }: { children: ReactNode }) {
  return (
    // The head script sets the theme class on <html> before React hydrates it.
    <html lang="en" suppressHydrationWarning>
      <head>
        <style dangerouslySetInnerHTML={{ __html: themeCss }} />
        <script dangerouslySetInnerHTML={{ __html: themeScript }} />
      </head>
      <body className={jakarta.variable}>
        <Providers>{children}</Providers>
      </body>
    </html>
  );
}
