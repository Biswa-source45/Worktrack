'use client';

import { useEffect, type ReactNode } from 'react';
import { useMutation, useQueryClient } from '@tanstack/react-query';
import Link from 'next/link';
import { usePathname, useRouter } from 'next/navigation';
import { useTranslation } from 'react-i18next';
import { HealthIndicator } from '@/components/health-status';
import { Button } from '@/components/ui/button';
import { errorMessage } from '@/lib/api-client';
import { useMe } from '@/lib/me';
import { cn } from '@/lib/utils';

const NAV = [
  { href: '/employees', permission: 'employees.manage', label: 'nav.employees' },
  { href: '/devices', permission: 'devices.manage', label: 'nav.devices' },
] as const;

export function AppShell({ children }: { children: ReactNode }) {
  const { t } = useTranslation();
  const router = useRouter();
  const pathname = usePathname();
  const queryClient = useQueryClient();
  const { data: me, error, isPending, refetch } = useMe();

  // The backend refuses everything else until the temporary password is changed.
  const mustChange = me?.must_change_password === true;
  useEffect(() => {
    if (mustChange) router.replace('/change-password');
  }, [mustChange, router]);

  const logout = useMutation({
    mutationFn: () => fetch('/api/auth/logout', { method: 'POST' }),
    onSuccess: () => {
      queryClient.clear();
      router.replace('/login');
    },
  });

  if (error) {
    return (
      <main className="mx-auto max-w-xl space-y-4 p-8">
        <p role="alert">{errorMessage(t, error)}</p>
        <Button variant="outline" onClick={() => void refetch()}>
          {t('common.retry')}
        </Button>
      </main>
    );
  }
  if (isPending || mustChange) return <p className="p-8">{t('common.loading')}</p>;

  const items = NAV.filter((item) => me.permissions.includes(item.permission));
  return (
    <div className="min-h-screen">
      <header className="border-b">
        <div className="mx-auto flex max-w-7xl flex-wrap items-center gap-4 px-4 py-2">
          <Link href="/" className="font-semibold">
            {t('app.title')}
          </Link>
          <nav aria-label={t('nav.label')} className="flex flex-1 gap-1">
            {items.map((item) => (
              <Link
                key={item.href}
                href={item.href}
                aria-current={pathname.startsWith(item.href) ? 'page' : undefined}
                className={cn(
                  'rounded-md px-2.5 py-1 text-sm hover:bg-muted',
                  pathname.startsWith(item.href) && 'bg-muted font-medium',
                )}
              >
                {t(item.label)}
              </Link>
            ))}
          </nav>
          <HealthIndicator />
          <span className="text-sm text-muted-foreground">{me.name}</span>
          <Button
            variant="outline"
            size="sm"
            onClick={() => logout.mutate()}
            disabled={logout.isPending}
          >
            {t('nav.logout')}
          </Button>
        </div>
      </header>
      <main className="mx-auto max-w-7xl space-y-4 p-4">
        {items.length === 0 ? <p>{t('shell.noAccess')}</p> : children}
      </main>
    </div>
  );
}
