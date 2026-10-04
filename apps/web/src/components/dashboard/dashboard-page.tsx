'use client';

import type { ReactNode } from 'react';
import { useQuery } from '@tanstack/react-query';
import { Clock, Smartphone, UserCheck, Users, UserX, type LucideIcon } from 'lucide-react';
import Link from 'next/link';
import { useTranslation } from 'react-i18next';
import { DotPattern, HalfCircles } from '@/components/decor/decor';
import { Page } from '@/components/page';
import { Button } from '@/components/ui/button';
import { Card } from '@/components/ui/card';
import { Skeleton } from '@/components/ui/skeleton';
import { errorMessage, proxyApi, unwrap } from '@/lib/api-client';
import { useMe } from '@/lib/me';
import { cn } from '@/lib/utils';

const GRID = 'grid gap-4 sm:grid-cols-2 lg:grid-cols-4';

function Stat({
  label,
  testId,
  value,
  icon: Icon,
  warning = false,
  children,
}: {
  label: string;
  testId: string;
  value: number;
  icon: LucideIcon;
  warning?: boolean;
  children?: ReactNode;
}) {
  return (
    <Card role="group" aria-label={label} className="flex items-start gap-3">
      <span
        className={cn(
          'flex size-10 shrink-0 items-center justify-center rounded-full',
          warning ? 'bg-warning-subtle text-warning' : 'bg-raised text-muted-foreground',
        )}
      >
        <Icon aria-hidden="true" className="size-5" />
      </span>
      <div className="min-w-0 flex-1">
        <p className="text-small text-muted-foreground">{label}</p>
        <p data-testid={testId} className="text-h1 tabular-nums">
          {value}
        </p>
      </div>
      {children}
    </Card>
  );
}

// Only mounted when the user may call the endpoint, so a Task Assigner never triggers a 403.
function Stats({ canReview }: { canReview: boolean }) {
  const { t } = useTranslation();
  const { data, error, isPending, refetch } = useQuery({
    queryKey: ['dashboard'],
    queryFn: () => unwrap(proxyApi().GET('/api/v1/admin/dashboard')),
  });

  if (error) {
    return (
      <Card className="space-y-3">
        <p role="alert" className="text-danger">
          {errorMessage(t, error)}
        </p>
        <Button variant="outline" onClick={() => void refetch()}>
          {t('common.retry')}
        </Button>
      </Card>
    );
  }
  if (isPending) {
    return (
      <div role="status" className={GRID}>
        <span className="sr-only">{t('common.loading')}</span>
        {[0, 1, 2, 3].map((card) => (
          <Card key={card} className="flex items-start gap-3">
            <Skeleton className="size-10 rounded-full" />
            <div className="flex-1 space-y-2">
              <Skeleton className="h-4 w-28" />
              <Skeleton className="h-8 w-16" />
            </div>
          </Card>
        ))}
      </div>
    );
  }

  const pending = data.pending_devices > 0;
  return (
    <div className={GRID}>
      <Stat
        label={t('dashboard.total')}
        testId="stat-total"
        value={data.employees_total}
        icon={Users}
      />
      <Stat
        label={t('dashboard.active')}
        testId="stat-active"
        value={data.employees_active}
        icon={UserCheck}
      />
      <Stat
        label={t('dashboard.inactive')}
        testId="stat-inactive"
        value={data.employees_inactive}
        icon={UserX}
      />
      <Stat
        label={t('dashboard.pendingDevices')}
        testId="stat-pending-devices"
        value={data.pending_devices}
        // Warning (pending) treatment only while something is actually waiting.
        icon={pending ? Clock : Smartphone}
        warning={pending}
      >
        {canReview && (
          <Button asChild variant="outline" size="sm">
            <Link href="/devices">{t('dashboard.review')}</Link>
          </Button>
        )}
      </Stat>
    </div>
  );
}

export function DashboardPage() {
  const { t } = useTranslation();
  const { data: me } = useMe();
  if (!me) return null;
  const canSeeStats = me.permissions.includes('employees.manage');

  return (
    <Page>
      <header className="relative overflow-hidden rounded-xl border bg-card p-6 shadow-sm">
        <DotPattern className="absolute inset-y-0 right-0 h-full w-1/3 text-muted-foreground/25" />
        <HalfCircles className="absolute right-6 bottom-0 w-40 text-primary/25" />
        <h1 className="relative text-h1">{t('dashboard.greeting', { name: me.name })}</h1>
        {!canSeeStats && (
          <p className="relative max-w-xl text-muted-foreground">{t('dashboard.noStats')}</p>
        )}
      </header>
      {canSeeStats && <Stats canReview={me.permissions.includes('devices.manage')} />}
    </Page>
  );
}
