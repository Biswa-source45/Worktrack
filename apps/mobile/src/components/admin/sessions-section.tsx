import { keepPreviousData, useInfiniteQuery } from '@tanstack/react-query';
import { CircleCheck, CircleMinus, LogOut, Smartphone } from '@/components/icons';
import { useState } from 'react';
import type { ReactNode } from 'react';
import { useTranslation } from 'react-i18next';
import { View } from 'react-native';
import { SessionClient, useSessionDevice } from '@/components/session-client';
import type { Session } from '@/components/session-client';
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

type Filter = Session['status'] | 'all';

const FILTERS = ['active', 'ended', 'all'] as const;

function SessionRow({ session, onSignOut }: { session: Session; onSignOut: (s: Session) => void }) {
  const { t } = useTranslation();
  const { space } = useTheme();
  const ended = t('sessions.endReason.unknown');

  return (
    <Card testID={`session-${session.id}`}>
      <View>
        <AppText weight={600}>{session.user_name}</AppText>
        <AppText variant="small" color="muted">
          {session.emp_code}
        </AppText>
      </View>
      <View style={{ flexDirection: 'row', flexWrap: 'wrap', gap: space[2] }}>
        {session.status === 'active' ? (
          <Badge status="success" icon={CircleCheck} label={t('sessions.status.active')} />
        ) : (
          <Badge
            status="neutral"
            icon={CircleMinus}
            label={t(`sessions.endReason.${session.end_reason}`, { defaultValue: ended })}
          />
        )}
        {session.current ? (
          <Badge status="info" icon={Smartphone} label={t('sessions.thisSession')} />
        ) : null}
      </View>
      <SessionClient session={session} />
      <View>
        <Meta label={t('sessions.os')} value={session.os ?? t('sessions.notRecorded')} />
        <Meta label={t('sessions.ip')} value={session.ip ?? t('sessions.notRecorded')} />
        <Meta label={t('sessions.signedIn')} value={formatIst(session.created_at)} />
        <Meta label={t('sessions.lastSeen')} value={formatIst(session.last_seen_at)} />
      </View>
      {session.status === 'active' ? (
        <Button
          variant="destructive"
          icon={LogOut}
          label={t('common.signOut')}
          accessibilityLabel={t('sessions.signOutA11y', { name: session.user_name })}
          onPress={() => onSignOut(session)}
        />
      ) : null}
    </Card>
  );
}

export function SessionsSection({ top }: { top: ReactNode }) {
  const { t } = useTranslation();
  const run = useAdminAction();
  const device = useSessionDevice();
  const [filter, setFilter] = useState<Filter>('active');
  const [leaving, setLeaving] = useState<Session | null>(null);

  const list = useInfiniteQuery({
    queryKey: ['admin', 'sessions', filter],
    initialPageParam: undefined as string | undefined,
    queryFn: ({ pageParam }) =>
      unwrap(
        api.GET('/api/v1/admin/sessions', {
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
    counts && (option === 'all' ? counts.active + counts.ended : counts[option]);

  return (
    <>
      <PagedList
        query={list}
        empty={t(`sessions.empty.${filter}`)}
        renderItem={(session) => <SessionRow session={session} onSignOut={setLeaving} />}
        header={
          <>
            {top}
            <FilterPills
              value={filter}
              onChange={setFilter}
              options={FILTERS.map((option) => ({
                value: option,
                label: t(`sessions.status.${option}`),
                count: countOf(option),
              }))}
            />
          </>
        }
      />
      {leaving ? (
        <ConfirmDialog
          title={t('sessions.signOutTitle')}
          message={t('sessions.signOutConfirm', {
            name: leaving.user_name,
            device: device(leaving),
          })}
          notice={leaving.current ? t('sessions.signOutCurrentNotice') : undefined}
          confirmLabel={t('common.signOut')}
          destructive
          onConfirm={async () => {
            await run(
              api.POST('/api/v1/admin/sessions/{session_id}/revoke', {
                params: { path: { session_id: leaving.id } },
              }),
            );
          }}
          onClose={() => setLeaving(null)}
        />
      ) : null}
    </>
  );
}
