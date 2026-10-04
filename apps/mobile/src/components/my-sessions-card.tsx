import { useQuery, useQueryClient } from '@tanstack/react-query';
import { CircleCheck, LogOut, RefreshCw, Smartphone, TriangleAlert } from '@/components/icons';
import { useState } from 'react';
import { useTranslation } from 'react-i18next';
import { View } from 'react-native';
import { SessionClient } from '@/components/session-client';
import { AppText } from '@/components/ui/app-text';
import { Badge } from '@/components/ui/badge';
import { Banner } from '@/components/ui/banner';
import { Button } from '@/components/ui/button';
import { Card } from '@/components/ui/card';
import { ConfirmDialog } from '@/components/ui/confirm-dialog';
import { Skeleton } from '@/components/ui/skeleton';
import { api } from '@/lib/api';
import { unwrap } from '@/lib/api-error';
import { formatIst } from '@/lib/ist';
import { useTheme } from '@/lib/theme';

const KEY = ['my-sessions'];

/** Where this account is signed in right now, with one button to sign the other places out. */
export function MySessionsCard() {
  const { t } = useTranslation();
  const { colors, space } = useTheme();
  const queryClient = useQueryClient();
  const [asking, setAsking] = useState(false);
  const [signedOut, setSignedOut] = useState<number | null>(null);
  const sessions = useQuery({
    queryKey: KEY,
    queryFn: () => unwrap(api.GET('/api/v1/me/sessions')),
    // No silent retries: the card shows its own Retry.
    retry: false,
  });

  async function signOutOthers() {
    const { revoked } = await unwrap(api.POST('/api/v1/me/sessions/revoke-others'));
    setSignedOut(revoked);
    await queryClient.invalidateQueries({ queryKey: KEY });
  }

  return (
    <Card>
      <AppText variant="h3" accessibilityRole="header">
        {t('mySessions.title')}
      </AppText>
      {sessions.isPending ? (
        <Skeleton height={space[12]} accessibilityLabel={t('common.loading')} />
      ) : null}
      {sessions.isError ? (
        <Banner status="danger" icon={TriangleAlert} message={t('mySessions.loadFailed')}>
          <Button
            variant="secondary"
            icon={RefreshCw}
            label={t('common.retry')}
            onPress={() => void sessions.refetch()}
            disabled={sessions.isFetching}
          />
        </Banner>
      ) : null}
      {sessions.data?.map((session, index) => (
        <View
          key={session.id}
          testID={`my-session-${session.id}`}
          style={{
            gap: space[1],
            paddingTop: index === 0 ? 0 : space[3],
            borderTopWidth: index === 0 ? 0 : 1,
            borderTopColor: colors.border,
          }}
        >
          <SessionClient session={session} />
          <AppText variant="small" color="muted">
            {[session.os, t('mySessions.lastSeen', { when: formatIst(session.last_seen_at) })]
              .filter(Boolean)
              .join(' · ')}
          </AppText>
          {session.current ? (
            <Badge status="info" icon={Smartphone} label={t('mySessions.thisDevice')} />
          ) : null}
        </View>
      ))}
      {signedOut === null ? null : (
        <Banner
          status="success"
          icon={CircleCheck}
          message={t('mySessions.signedOut', { count: signedOut })}
        />
      )}
      {sessions.data && sessions.data.length > 1 ? (
        <Button
          variant="destructive"
          icon={LogOut}
          label={t('mySessions.signOutOthers')}
          onPress={() => setAsking(true)}
        />
      ) : null}
      {asking ? (
        <ConfirmDialog
          title={t('mySessions.signOutOthers')}
          message={t('mySessions.signOutOthersConfirm')}
          confirmLabel={t('mySessions.signOutOthers')}
          destructive
          onConfirm={signOutOthers}
          onClose={() => setAsking(false)}
        />
      ) : null}
    </Card>
  );
}
