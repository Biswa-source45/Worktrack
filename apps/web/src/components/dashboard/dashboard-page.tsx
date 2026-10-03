'use client';

import type { ReactNode } from 'react';
import { useQuery } from '@tanstack/react-query';
import Link from 'next/link';
import { useTranslation } from 'react-i18next';
import { Button } from '@/components/ui/button';
import { errorMessage, proxyApi, unwrap } from '@/lib/api-client';
import { useMe } from '@/lib/me';

function Stat({
  label,
  testId,
  value,
  children,
}: {
  label: string;
  testId: string;
  value: number;
  children?: ReactNode;
}) {
  return (
    <div role="group" aria-label={label} className="rounded-xl p-4 ring-1 ring-foreground/10">
      <p className="text-sm text-muted-foreground">{label}</p>
      <p data-testid={testId} className="text-3xl font-semibold tabular-nums">
        {value}
      </p>
      {children}
    </div>
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
      <div className="space-y-2">
        <p role="alert" className="text-sm text-destructive">
          {errorMessage(t, error)}
        </p>
        <Button variant="outline" onClick={() => void refetch()}>
          {t('common.retry')}
        </Button>
      </div>
    );
  }
  if (isPending) return <p>{t('common.loading')}</p>;

  return (
    <div className="grid gap-3 sm:grid-cols-2 lg:grid-cols-4">
      <Stat label={t('dashboard.total')} testId="stat-total" value={data.employees_total} />
      <Stat label={t('dashboard.active')} testId="stat-active" value={data.employees_active} />
      <Stat
        label={t('dashboard.inactive')}
        testId="stat-inactive"
        value={data.employees_inactive}
      />
      <Stat
        label={t('dashboard.pendingDevices')}
        testId="stat-pending-devices"
        value={data.pending_devices}
      >
        {canReview && (
          <Link href="/devices" className="text-sm text-primary underline-offset-4 hover:underline">
            {t('dashboard.review')}
          </Link>
        )}
      </Stat>
    </div>
  );
}

export function DashboardPage() {
  const { t } = useTranslation();
  const { data: me } = useMe();
  if (!me) return null;

  return (
    <section className="space-y-4">
      <h1 className="text-2xl font-semibold">{t('dashboard.greeting', { name: me.name })}</h1>
      {me.permissions.includes('employees.manage') ? (
        <Stats canReview={me.permissions.includes('devices.manage')} />
      ) : (
        <p className="text-muted-foreground">{t('dashboard.noStats')}</p>
      )}
    </section>
  );
}
