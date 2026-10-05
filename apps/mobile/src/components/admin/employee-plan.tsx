import { useQuery } from '@tanstack/react-query';
import { Building, CircleMinus, House, RefreshCw, TriangleAlert } from '@/components/icons';
import { useTranslation } from 'react-i18next';
import { View } from 'react-native';
import { AppText } from '@/components/ui/app-text';
import { Badge } from '@/components/ui/badge';
import { Banner } from '@/components/ui/banner';
import { Button } from '@/components/ui/button';
import { Card } from '@/components/ui/card';
import { DetailRow } from '@/components/ui/detail-row';
import { Skeleton } from '@/components/ui/skeleton';
import { api } from '@/lib/api';
import { ApiError, unwrap } from '@/lib/api-error';
import { formatIstDay, istDay } from '@/lib/ist';
import { useTheme } from '@/lib/theme';

const KINDS = {
  office: { status: 'info', icon: Building },
  home: { status: 'success', icon: House },
  off: { status: 'neutral', icon: CircleMinus },
} as const;

// The viewer may open the employee but not manage them: those parts are simply not shown.
const forbidden = (error: unknown) => error instanceof ApiError && error.status === 403;

/** Where the employee works on each of the next 7 days, and the state of their home location. */
export function EmployeePlan({ employeeId }: { employeeId: number }) {
  const { t } = useTranslation();
  const { colors, space } = useTheme();
  const path = { employee_id: employeeId };
  const from = istDay();

  const schedule = useQuery({
    queryKey: ['admin', 'employee', employeeId, 'schedule', from],
    queryFn: () =>
      unwrap(
        api.GET('/api/v1/admin/employees/{employee_id}/schedule', {
          params: { path, query: { from, to: istDay(6) } },
        }),
      ),
    retry: false,
  });
  const home = useQuery({
    queryKey: ['admin', 'employee', employeeId, 'home-location'],
    queryFn: () =>
      unwrap(api.GET('/api/v1/admin/employees/{employee_id}/home-location', { params: { path } })),
    // Only the state reaches the screen: the coordinates in the answer are dropped here.
    select: ({ approved, pending }) => ({
      radius: approved?.radius_m ?? null,
      pending: pending !== null,
    }),
    retry: false,
  });

  const queries = [schedule, home];
  if (queries.every((query) => forbidden(query.error))) return null;
  const failed = queries.filter((query) => query.isError && !forbidden(query.error));
  const homeStatus =
    home.data &&
    ([
      home.data.radius === null ? null : t('employees.homeApproved', { count: home.data.radius }),
      home.data.pending ? t('employees.homePending') : null,
    ]
      .filter(Boolean)
      .join(' · ') ||
      t('employees.notSet'));

  return (
    <Card>
      {queries.some((query) => query.isPending) ? (
        <Skeleton height={space[12]} accessibilityLabel={t('common.loading')} />
      ) : null}
      {schedule.data ? (
        <>
          <AppText variant="h3" accessibilityRole="header">
            {t('employees.nextDays')}
          </AppText>
          {schedule.data.resolved.map(({ date, kind, reason }, index) => (
            <View
              key={date}
              testID={`day-${date}`}
              style={{
                flexDirection: 'row',
                alignItems: 'center',
                gap: space[3],
                paddingTop: index === 0 ? 0 : space[3],
                borderTopWidth: index === 0 ? 0 : 1,
                borderTopColor: colors.border,
              }}
            >
              <View style={{ flex: 1 }}>
                <AppText weight={500}>{formatIstDay(date)}</AppText>
                <AppText variant="small" color="muted">
                  {t(`employees.dayReason.${reason}`)}
                </AppText>
              </View>
              <Badge
                status={KINDS[kind].status}
                icon={KINDS[kind].icon}
                label={t(`employees.dayKind.${kind}`)}
              />
            </View>
          ))}
        </>
      ) : null}
      {homeStatus ? <DetailRow label={t('employees.homeLocation')} value={homeStatus} /> : null}
      {failed.length > 0 ? (
        <Banner status="danger" icon={TriangleAlert} message={t('employees.planLoadFailed')}>
          <Button
            variant="secondary"
            icon={RefreshCw}
            label={t('common.retry')}
            onPress={() => failed.forEach((query) => void query.refetch())}
          />
        </Banner>
      ) : null}
    </Card>
  );
}
