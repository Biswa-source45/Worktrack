import { keepPreviousData, useInfiniteQuery } from '@tanstack/react-query';
import type { components } from 'api-types';
import { CircleCheck, CircleX, Clock, TriangleAlert } from '@/components/icons';
import { useState } from 'react';
import type { ReactNode } from 'react';
import { useTranslation } from 'react-i18next';
import { View } from 'react-native';
import { AppText } from '@/components/ui/app-text';
import { Badge } from '@/components/ui/badge';
import { Button } from '@/components/ui/button';
import { Card } from '@/components/ui/card';
import { ConfirmDialog } from '@/components/ui/confirm-dialog';
import { FilterPills } from '@/components/ui/filter-pills';
import { api } from '@/lib/api';
import { unwrap } from '@/lib/api-error';
import { formatIst } from '@/lib/ist';
import { useTheme } from '@/lib/theme';
import { Meta } from './meta';
import { PagedList } from './paged-list';
import { useAdminAction } from './use-admin-action';

type Device = components['schemas']['DeviceOut'];
type Action = components['schemas']['DeviceDecision']['action'];
type Filter = Device['status'] | 'all';
type Decision = { device: Device; action: Action };

const FILTERS = ['all', 'pending', 'active', 'revoked'] as const;
const LOOKS = {
  active: { badge: 'success', icon: CircleCheck },
  pending: { badge: 'warning', icon: Clock },
  revoked: { badge: 'danger', icon: CircleX },
} as const;

function DeviceRow({ device, onDecide }: { device: Device; onDecide: (d: Decision) => void }) {
  const { t } = useTranslation();
  const { colors, space } = useTheme();
  const names = { model: device.model, name: device.user_name };
  const action = (name: Action, variant: 'primary' | 'secondary' | 'destructive') => (
    <View style={{ flex: 1 }}>
      <Button
        variant={variant}
        label={t(`devices.${name}`)}
        accessibilityLabel={t(`devices.${name}A11y`, names)}
        onPress={() => onDecide({ device, action: name })}
      />
    </View>
  );

  return (
    <Card testID={`device-${device.id}`}>
      <View>
        <AppText weight={600}>{device.user_name}</AppText>
        <AppText variant="small" color="muted">
          {device.emp_code}
        </AppText>
      </View>
      <Badge
        status={LOOKS[device.status].badge}
        icon={LOOKS[device.status].icon}
        label={t(`devices.status.${device.status}`)}
      />
      {device.conflict ? (
        <View style={{ flexDirection: 'row', gap: space[2] }}>
          <TriangleAlert size={16} strokeWidth={1.75} color={colors.warningFg} />
          <AppText variant="small" weight={600} color="warningFg" style={{ flex: 1 }}>
            {t('devices.conflict', {
              name: device.conflict.name,
              code: device.conflict.emp_code,
            })}
          </AppText>
        </View>
      ) : null}
      <View>
        <AppText weight={500}>{device.model}</AppText>
        <Meta label={t('devices.os')} value={device.os} />
        <Meta label={t('devices.appVersion')} value={device.app_version} />
        <Meta label={t('devices.lastSeen')} value={formatIst(device.last_seen_at)} />
      </View>
      {device.status === 'pending' ? (
        <View style={{ flexDirection: 'row', gap: space[3] }}>
          {action('approve', 'primary')}
          {action('reject', 'secondary')}
        </View>
      ) : null}
      {device.status === 'active' ? (
        <View style={{ flexDirection: 'row' }}>{action('revoke', 'destructive')}</View>
      ) : null}
    </Card>
  );
}

export function DevicesSection({ top }: { top: ReactNode }) {
  const { t } = useTranslation();
  const run = useAdminAction();
  const [filter, setFilter] = useState<Filter>('all');
  const [decision, setDecision] = useState<Decision | null>(null);

  const list = useInfiniteQuery({
    queryKey: ['admin', 'devices', filter],
    initialPageParam: undefined as string | undefined,
    queryFn: ({ pageParam }) =>
      unwrap(
        api.GET('/api/v1/admin/devices', {
          params: {
            query: { status: filter === 'all' ? undefined : filter, limit: 20, cursor: pageParam },
          },
        }),
      ),
    getNextPageParam: (page) => page.next_cursor ?? undefined,
    // Keeps the counts on the pills while another filter loads.
    placeholderData: keepPreviousData,
    // No silent retries: a 403 shows at once, and Retry and pull to refresh are on screen.
    retry: false,
  });
  const counts = list.data?.pages.at(-1)?.counts;
  const countOf = (option: Filter) =>
    counts && (option === 'all' ? counts.pending + counts.active + counts.revoked : counts[option]);

  const conflict = decision?.action === 'approve' ? decision.device.conflict : null;

  return (
    <>
      <PagedList
        query={list}
        empty={t(`devices.empty.${filter}`)}
        renderItem={(device) => <DeviceRow device={device} onDecide={setDecision} />}
        header={
          <>
            {top}
            <FilterPills
              value={filter}
              onChange={setFilter}
              options={FILTERS.map((option) => ({
                value: option,
                label: t(`devices.status.${option}`),
                count: countOf(option),
              }))}
            />
          </>
        }
      />
      {decision ? (
        <ConfirmDialog
          title={t(`devices.${decision.action}Title`)}
          message={t(
            conflict ? 'devices.approveConflictConfirm' : `devices.${decision.action}Confirm`,
            {
              name: decision.device.user_name,
              model: decision.device.model,
            },
          )}
          notice={
            conflict
              ? t('devices.approveConflictNotice', {
                  name: decision.device.user_name,
                  other: conflict.name,
                  code: conflict.emp_code,
                })
              : undefined
          }
          confirmLabel={t(`devices.${decision.action}`)}
          destructive={decision.action !== 'approve'}
          onConfirm={async () => {
            await run(
              api.PATCH('/api/v1/admin/devices/{device_id}', {
                params: { path: { device_id: decision.device.id } },
                body: { action: decision.action },
              }),
            );
          }}
          onClose={() => setDecision(null)}
        />
      ) : null}
    </>
  );
}
