'use client';

import type { ReactNode } from 'react';
import { useTranslation } from 'react-i18next';
import { BrandLogo } from '@/components/brand-logo';
import { Blob, CurvedEdge, DotPattern } from '@/components/decor/decor';
import { ThemeToggle } from '@/components/theme/theme-toggle';

/** The signed-out screens: one card on a decorated hero, with the theme control top-right. */
export function AuthLayout({ children }: { children: ReactNode }) {
  const { t } = useTranslation();
  return (
    <main className="relative grid min-h-screen place-items-center overflow-hidden px-4 py-16">
      <DotPattern className="absolute inset-0 size-full text-muted-foreground/25" />
      <Blob className="absolute -top-32 -left-32 size-112 text-primary/10" />
      <CurvedEdge className="absolute inset-x-0 bottom-0 h-2/5 w-full text-raised" />
      <ThemeToggle className="absolute top-4 right-4" />
      <div className="relative w-full max-w-sm animate-in duration-250 ease-out fade-in slide-in-from-bottom-2">
        <div className="rounded-xl border bg-card p-8 shadow-lg">
          <div className="mb-6 flex justify-center">
            <BrandLogo variant="full" label={t('app.name')} className="w-64" />
          </div>
          {children}
        </div>
      </div>
    </main>
  );
}
