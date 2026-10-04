'use client';

import type { ReactNode } from 'react';
import { useTranslation } from 'react-i18next';
import { EmptyState } from '@/components/empty-state';
import { Card } from '@/components/ui/card';
import { useMe } from '@/lib/me';

export function NoAccess() {
  const { t } = useTranslation();
  return (
    <Card>
      <EmptyState text={t('shell.noAccess')} />
    </Card>
  );
}

// The server enforces every permission; this only keeps people off screens they cannot use.
export function RequirePermission({
  permission,
  children,
}: {
  permission: string;
  children: ReactNode;
}) {
  const { data } = useMe();
  if (!data) return null;
  if (!data.permissions.includes(permission)) return <NoAccess />;
  return children;
}
