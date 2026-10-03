import type { Metadata } from 'next';
import type { ReactNode } from 'react';
import './globals.css';
import { Geist } from 'next/font/google';
import { Providers } from '@/components/providers';
import { cn } from '@/lib/utils';

const geist = Geist({ subsets: ['latin'], variable: '--font-sans' });

export const metadata: Metadata = {
  title: 'WorkTrack Admin',
  description: 'WorkTrack admin portal',
};

export default function RootLayout({ children }: { children: ReactNode }) {
  return (
    <html lang="en" className={cn('font-sans', geist.variable)}>
      <body>
        <Providers>{children}</Providers>
      </body>
    </html>
  );
}
