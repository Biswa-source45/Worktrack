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

/** True when `held` has the permission, or any of them when a list is given. */
export const hasPermission = (held: readonly string[], needed: string | readonly string[]) =>
  (typeof needed === 'string' ? [needed] : needed).some((p) => held.includes(p));

// The server enforces every permission; this only keeps people off screens they cannot use.
export function RequirePermission({
  permission,
  children,
}: {
  permission: string | readonly string[];
  children: ReactNode;
}) {
  const { data } = useMe();
  if (!data) return null;
  if (!hasPermission(data.permissions, permission)) return <NoAccess />;
  return children;
}
