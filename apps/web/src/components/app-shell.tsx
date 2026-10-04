'use client';

import { useEffect, type ReactNode } from 'react';
import { useMutation, useQueryClient } from '@tanstack/react-query';
import { LogOut } from 'lucide-react';
import Link from 'next/link';
import { usePathname, useRouter } from 'next/navigation';
import { useTranslation } from 'react-i18next';
import { HealthIndicator } from '@/components/health-status';
import { NoAccess } from '@/components/require-permission';
import { ThemeToggle } from '@/components/theme/theme-toggle';
import { Avatar } from '@/components/ui/avatar';
import { Button } from '@/components/ui/button';
import { Card } from '@/components/ui/card';
import { errorMessage } from '@/lib/api-client';
import { useMe } from '@/lib/me';
import { cn } from '@/lib/utils';

const NAV = [
  { href: '/employees', permission: 'employees.manage', label: 'nav.employees' },
  { href: '/branches', permission: 'branches.manage', label: 'nav.branches' },
  { href: '/shifts', permission: 'branches.manage', label: 'nav.shifts' },
  { href: '/devices', permission: 'devices.manage', label: 'nav.devices' },
  { href: '/sessions', permission: 'devices.manage', label: 'nav.sessions' },
  { href: '/settings', permission: 'settings.view', label: 'nav.settings' },
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
      <main className="grid min-h-screen place-items-center p-4">
        <Card className="w-full max-w-md space-y-4">
          <p role="alert" className="text-danger">
            {errorMessage(t, error)}
          </p>
          <Button variant="outline" onClick={() => void refetch()}>
            {t('common.retry')}
          </Button>
        </Card>
      </main>
    );
  }
  if (isPending || mustChange) {
    return (
      <p role="status" className="grid min-h-screen place-items-center text-muted-foreground">
        {t('common.loading')}
      </p>
    );
  }

  const items = NAV.filter((item) => me.permissions.includes(item.permission));
  return (
    <div className="min-h-screen">
      <header className="sticky top-0 z-40 border-b bg-surface shadow-sm">
        <div className="mx-auto flex max-w-7xl flex-wrap items-center gap-x-4 gap-y-2 px-4 py-2">
          <Link href="/" className="rounded-sm text-large font-bold">
            {t('app.title')}
          </Link>
          {/* min-w-max: on a narrow screen the header wraps to a second row instead of squeezing
              the links into a column. */}
          <nav aria-label={t('nav.label')} className="flex min-w-max flex-1 gap-1">
            {items.map((item) => {
              const active = pathname.startsWith(item.href);
              return (
                <Link
                  key={item.href}
                  href={item.href}
                  aria-current={active ? 'page' : undefined}
                  className={cn(
                    'rounded-full px-3 py-1.5 text-small font-medium transition-transform active:scale-(--wt-press-scale)',
                    active
                      ? 'bg-primary font-semibold text-primary-foreground'
                      : 'text-muted-foreground hover:bg-raised hover:text-foreground',
                  )}
                >
                  {t(item.label)}
                </Link>
              );
            })}
          </nav>
          <HealthIndicator />
          <ThemeToggle />
          <span className="flex items-center gap-2 text-small font-medium">
            <Avatar name={me.name} />
            <span className="max-w-40 truncate">{me.name}</span>
          </span>
          <Button
            variant="outline"
            size="sm"
            onClick={() => logout.mutate()}
            disabled={logout.isPending}
          >
            <LogOut aria-hidden="true" />
            {/* Six nav links fill a 1280 px header: the label stays for screen readers only there. */}
            <span className="sr-only 2xl:not-sr-only">{t('nav.logout')}</span>
          </Button>
        </div>
      </header>
      <main className="mx-auto max-w-7xl p-4">{items.length === 0 ? <NoAccess /> : children}</main>
    </div>
  );
}
