import { useQuery } from '@tanstack/react-query';
import { useRouter } from 'expo-router';
import { useEffect, useState } from 'react';
import { useTranslation } from 'react-i18next';
import { View } from 'react-native';
import { AttendanceBadge } from '@/components/attendance-status';
import { FACE_KEY, fetchFaceEnrollment } from '@/components/face-enrollment-card';
import {
  Camera,
  CircleMinus,
  Clock,
  MapPin,
  RefreshCw,
  ScanFace,
  TriangleAlert,
} from '@/components/icons';
import { AppText } from '@/components/ui/app-text';
import { Badge } from '@/components/ui/badge';
import { Banner } from '@/components/ui/banner';
import { Button } from '@/components/ui/button';
import { Card } from '@/components/ui/card';
import { Skeleton } from '@/components/ui/skeleton';
import { ApiError, errorDetail, errorText } from '@/lib/api-error';
import { getIntegrity } from '@/lib/integrity';
import { clockOffset, formatIstClock, formatIstTime } from '@/lib/ist';
import { LocationError, getCurrentFix } from '@/lib/location';
import { fetchToday, isOffline, precheck } from '@/lib/punch';
import type { Precheck } from '@/lib/punch';
import { punchErrorText, startFlow } from '@/lib/punch-flow';
import { useTheme } from '@/lib/theme';
import { useRefetchOnFocus } from '@/lib/use-refetch-on-focus';

export const TODAY_KEY = ['attendance-today'];

type Problem = { message: string; detail?: string };

/** The time on the server's clock, ticking, from one answer of the server and the phone's clock. */
function ServerClock({ serverTime, receivedAt }: { serverTime: string; receivedAt: number }) {
  const { t } = useTranslation();
  const { space, colors } = useTheme();
  const offset = clockOffset(serverTime, receivedAt);
  const [now, setNow] = useState(() => Date.now());
  useEffect(() => {
    const timer = setInterval(() => setNow(Date.now()), 1000);
    return () => clearInterval(timer);
  }, []);

  return (
    <View
      accessible
      accessibilityLabel={`${t('punch.serverTime')} ${formatIstClock(now + offset)}`}
      style={{ flexDirection: 'row', alignItems: 'center', gap: space[2] }}
    >
      <Clock size={20} strokeWidth={1.75} color={colors.muted} />
      <AppText variant="h2" testID="server-clock">
        {formatIstClock(now + offset)}
      </AppText>
      <AppText variant="small" color="muted">
        {t('punch.serverTime')}
      </AppText>
    </View>
  );
}

/** Today's attendance and the one thing the employee can do about it now. */
export function PunchCard() {
  const { t } = useTranslation();
  const { space } = useTheme();
  const router = useRouter();
  const today = useQuery({ queryKey: TODAY_KEY, queryFn: fetchToday, retry: false });
  useRefetchOnFocus(today.refetch);
  // Same query as the Face card below (one request, shared); it must use the real fetcher.
  const face = useQuery({ queryKey: FACE_KEY, queryFn: fetchFaceEnrollment, retry: false });

  const [busy, setBusy] = useState(false);
  const [problem, setProblem] = useState<Problem | null>(null);
  const [check, setCheck] = useState<Precheck | null>(null);
  const data = today.data;

  async function start() {
    if (!data) return;
    setBusy(true);
    setProblem(null);
    setCheck(null);
    try {
      const fix = await getCurrentFix();
      const integrity = await getIntegrity();
      let answer: Precheck | null = null;
      try {
        answer = await precheck(fix);
      } catch (error) {
        // Without a connection the server cannot judge the position: the punch is taken and kept
        // on the phone, and the server checks it when it arrives.
        if (!(await isOffline(error))) throw error;
      }
      setCheck(answer);
      if (answer && !answer.allowed) return;
      if (answer?.action === 'request_punch_out') {
        startFlow({ kind: 'request', fix, integrity });
        return;
      }
      const kind = (answer?.action ?? data.action) === 'punch_in' ? 'in' : 'out';
      startFlow({ kind, fix, integrity });
      router.push('/punch/capture');
    } catch (error) {
      if (error instanceof LocationError)
        setProblem({ message: t(`location.errors.${error.code}`) });
      else if (error instanceof ApiError) setProblem({ message: punchErrorText(t, error) });
      else setProblem({ message: errorText(t, error), detail: errorDetail(error) });
    } finally {
      setBusy(false);
    }
  }

  const away =
    check?.nearest_branch && check.distance_m != null
      ? t('punch.awayFrom', { distance: check.distance_m, branch: check.nearest_branch })
      : null;
  const requesting = check?.allowed === true && check.action === 'request_punch_out';
  const refused = check && !check.allowed ? (check.message ?? t('errors.generic')) : null;
  const hasIn = data?.punches.some((punch) => punch.type === 'in') ?? false;
  const minutes = data?.minutes_so_far ?? (data?.day?.worked_minutes || null);
  const faceStatus = face.data?.status;

  return (
    <Card testID="punch-card">
      <AppText variant="h3" accessibilityRole="header">
        {t('punch.title')}
      </AppText>
      {today.isPending ? (
        <Skeleton height={space[16]} accessibilityLabel={t('common.loading')} />
      ) : null}
      {today.isError && !data ? (
        <Banner status="danger" icon={TriangleAlert} message={errorText(t, today.error)}>
          <Button
            variant="secondary"
            icon={RefreshCw}
            label={t('common.retry')}
            onPress={() => void today.refetch()}
            disabled={today.isFetching}
          />
        </Banner>
      ) : null}
      {data ? (
        <>
          {today.isError ? (
            <AppText variant="small" color="muted">
              {t('punch.stale')}
            </AppText>
          ) : null}
          <ServerClock serverTime={data.server_time} receivedAt={today.dataUpdatedAt} />
          <AppText variant="small" color="muted">
            {data.shift
              ? t('punch.shift', {
                  name: data.shift,
                  start: data.shift_start?.slice(0, 5),
                  end: data.shift_end?.slice(0, 5),
                })
              : t('punch.noShift')}
          </AppText>
          {data.day ? (
            <AttendanceBadge status={data.day.status} testID="punch-status" />
          ) : (
            <Badge
              testID="punch-status"
              status="neutral"
              icon={CircleMinus}
              label={t('punch.notPunched')}
            />
          )}
          {minutes ? (
            <AppText variant="small" testID="punch-hours">
              {t(data.minutes_so_far == null ? 'punch.worked' : 'punch.workedSoFar')}:{' '}
              {t('punch.duration', { hours: Math.floor(minutes / 60), minutes: minutes % 60 })}
            </AppText>
          ) : null}
          {data.punches.map((punch) => (
            <AppText key={punch.id} variant="small" color="muted">
              {t(`queue.kind.${punch.type}`)} {formatIstTime(punch.time)}
              {punch.in_review ? ` (${t('attendance.flag.face_review').toLowerCase()})` : ''}
            </AppText>
          ))}

          {data.blocked ? (
            <Banner
              status={data.blocked === 'done' ? 'success' : 'warning'}
              icon={data.blocked === 'face_not_approved' ? ScanFace : Clock}
              message={t(`punch.blocked.${data.blocked}`, { defaultValue: data.blocked })}
            >
              {data.blocked === 'face_not_approved' && faceStatus !== 'pending' ? (
                <Button
                  variant="secondary"
                  icon={ScanFace}
                  label={t('punch.faceSetup')}
                  onPress={() =>
                    router.push(faceStatus === 'consented' ? '/face/capture' : '/face/consent')
                  }
                />
              ) : null}
            </Banner>
          ) : null}
          {problem ? (
            <>
              <Banner status="danger" icon={TriangleAlert} message={problem.message} />
              {problem.detail ? (
                <AppText variant="small" color="muted" selectable>
                  {problem.detail}
                </AppText>
              ) : null}
            </>
          ) : null}
          {away ? (
            <AppText variant="small" testID="punch-away">
              {away}
            </AppText>
          ) : null}
          {refused ? <Banner status="danger" icon={TriangleAlert} message={refused} /> : null}

          {data.action === 'none' ? (
            data.blocked === 'done' ? null : (
              <Button
                icon={Camera}
                label={t(hasIn ? 'punch.action.punch_out' : 'punch.action.punch_in')}
                onPress={() => undefined}
                disabled
              />
            )
          ) : requesting ? (
            <>
              <Button
                icon={Camera}
                label={t('punch.action.request_punch_out')}
                onPress={() => router.push('/punch/request')}
              />
              <Button
                variant="ghost"
                icon={MapPin}
                label={t('punch.recheck')}
                onPress={() => void start()}
                loading={busy}
              />
            </>
          ) : (
            <Button
              icon={Camera}
              label={t(`punch.action.${data.action}`)}
              onPress={() => void start()}
              loading={busy}
            />
          )}
          {busy ? (
            <AppText variant="small" color="muted">
              {t('punch.checking')}
            </AppText>
          ) : null}
        </>
      ) : null}
    </Card>
  );
}
