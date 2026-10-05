'use client';

import { useQuery } from '@tanstack/react-query';
import { ArrowLeft } from 'lucide-react';
import Link from 'next/link';
import { useTranslation } from 'react-i18next';
import { Page } from '@/components/page';
import { NoAccess, RequirePermission } from '@/components/require-permission';
import { Avatar } from '@/components/ui/avatar';
import { Skeleton } from '@/components/ui/skeleton';
import { ApiError, errorMessage, proxyApi, unwrap } from '@/lib/api-client';
import { HomeCard } from './home-card';
import { ScheduleCard } from './schedule-card';

function EmployeeDetailView({ employeeId }: { employeeId: number }) {
  const { t } = useTranslation();
  const employee = useQuery({
    queryKey: ['employees', employeeId, 'detail'],
    queryFn: () =>
      unwrap(
        proxyApi().GET('/api/v1/admin/employees/{employee_id}', {
          params: { path: { employee_id: employeeId } },
        }),
      ),
  });
  // The actor may manage employees in general but not this one (outside their scope).
  if (employee.error instanceof ApiError && employee.error.status === 403) return <NoAccess />;

  return (
    <Page>
      <Link
        href="/employees"
        className="inline-flex items-center gap-1.5 rounded-sm text-small font-medium text-primary-text underline-offset-4 hover:underline"
      >
        <ArrowLeft aria-hidden="true" className="size-4" />
        {t('employees.back')}
      </Link>
      {employee.error && (
        <p role="alert" className="text-small text-danger">
          {errorMessage(t, employee.error)}
        </p>
      )}
      {employee.isPending && (
        <div role="status">
          <span className="sr-only">{t('common.loading')}</span>
          <Skeleton className="h-12 w-72" />
        </div>
      )}
      {employee.data && (
        <>
          <div className="flex items-center gap-3">
            <Avatar name={employee.data.name} className="size-10 text-small" />
            <div>
              <h1 className="text-h1">{employee.data.name}</h1>
              <p className="text-small text-muted-foreground">
                {[
                  employee.data.emp_code,
                  employee.data.home_branch?.name ?? t('employees.noBranch'),
                  employee.data.shift?.name ?? t('employees.noShift'),
                ].join(' · ')}
              </p>
            </div>
          </div>
          <ScheduleCard employeeId={employeeId} />
          <HomeCard employeeId={employeeId} name={employee.data.name} />
        </>
      )}
    </Page>
  );
}

export function EmployeeDetailPage({ employeeId }: { employeeId: number }) {
  return (
    <RequirePermission permission="employees.manage">
      <EmployeeDetailView employeeId={employeeId} />
    </RequirePermission>
  );
}
