'use client';

import type { ReactNode } from 'react';
import { useTranslation } from 'react-i18next';
import { useMe } from '@/lib/me';

// The server enforces every permission; this only keeps people off screens they cannot use.
export function RequirePermission({
  permission,
  children,
}: {
  permission: string;
  children: ReactNode;
}) {
  const { t } = useTranslation();
  const { data } = useMe();
  if (!data) return null;
  if (!data.permissions.includes(permission)) return <p>{t('shell.noAccess')}</p>;
  return children;
}
