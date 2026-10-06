import { useQuery } from '@tanstack/react-query';
import { useState } from 'react';
import { useTranslation } from 'react-i18next';
import { Pressable, View } from 'react-native';
import type { components } from 'api-types';
import { AttendanceBadge, dayLook, dayStatus } from '@/components/attendance-status';
import { ChevronLeft, ChevronRight, RefreshCw, TriangleAlert } from '@/components/icons';
import { AppText } from '@/components/ui/app-text';
import { Banner } from '@/components/ui/banner';
import { Button } from '@/components/ui/button';
import { Card } from '@/components/ui/card';
import { EmptyState } from '@/components/ui/empty-state';
import { Skeleton } from '@/components/ui/skeleton';
import { api } from '@/lib/api';
import { unwrap } from '@/lib/api-error';
import {
  dayTitle,
  leadingBlanks,
  monthLimits,
  monthOf,
  monthTitle,
  shiftMonth,
} from '@/lib/calendar';
import { formatIstDay, formatIstTime, istDay } from '@/lib/ist';
import { useRefetchOnFocus } from '@/lib/use-refetch-on-focus';
import { useTheme } from '@/lib/theme';
import type { ColorRole } from '@/lib/theme';

type Day = components['schemas']['MonthDay'];

export const MONTH_KEY = ['attendance-month'];

const WEEKDAYS = ['mon', 'tue', 'wed', 'thu', 'fri', 'sat', 'sun'] as const;
const LEGEND = [
  'present',
  'half_day',
  'short_hours',
  'absent',
  'working',
  'pending',
  'missed_punch_out',
  'holiday',
  'weekly_off',
  'leave',
  'work_from_home',
  'on_duty',
] as const;
const FLAGS = ['offline', 'face_review', 'jump', 'mock'];

function useDuration() {
  const { t } = useTranslation();
  return (minutes: number) =>
    t('punch.duration', { hours: Math.floor(minutes / 60), minutes: minutes % 60 });
}

function MonthHeader(props: {
  month: string;
  earliest: string;
  latest: string;
  onChange: (month: string) => void;
}) {
  const { t } = useTranslation();
  const { colors, space, minTouchTarget } = useTheme();
  const { month, earliest, latest, onChange } = props;
  const step = (delta: number, label: string, Icon: typeof ChevronLeft, blocked: boolean) => (
    <Pressable
      accessibilityRole="button"
      accessibilityLabel={label}
      accessibilityState={{ disabled: blocked }}
      disabled={blocked}
      onPress={() => onChange(shiftMonth(month, delta))}
      style={{
        width: minTouchTarget,
        height: minTouchTarget,
        alignItems: 'center',
        justifyContent: 'center',
        opacity: blocked ? 0.4 : 1,
      }}
    >
      <Icon size={24} strokeWidth={1.75} color={colors.text} />
    </Pressable>
  );

  return (
    <View style={{ flexDirection: 'row', alignItems: 'center', gap: space[2] }}>
      {step(-1, t('attendance.previous'), ChevronLeft, month <= earliest)}
      <AppText variant="h3" accessibilityRole="header" style={{ flex: 1, textAlign: 'center' }}>
        {monthTitle(month)}
      </AppText>
      {step(1, t('attendance.next'), ChevronRight, month >= latest)}
    </View>
  );
}

function DayCell({
  day,
  selected,
  today,
  onPress,
}: {
  day: Day;
  selected: boolean;
  today: boolean;
  onPress: () => void;
}) {
  const { t } = useTranslation();
  const { colors, radius, space, minTouchTarget } = useTheme();
  const key = day.status === null ? null : dayStatus(day.status);
  const look = key === null ? null : dayLook(key);
  const tone = look?.status ?? 'neutral';
  const ink: ColorRole = tone === 'neutral' ? 'muted' : `${tone}Fg`;
  const fill = look ? (tone === 'neutral' ? colors.raised : colors[`${tone}Subtle`]) : undefined;
  const Icon = look?.icon;
  const status = t(`attendance.status.${key ?? 'none'}`);

  return (
    <Pressable
      accessibilityRole="button"
      accessibilityLabel={t('attendance.cellA11y', { date: dayTitle(day.date), status })}
      accessibilityState={{ selected }}
      onPress={onPress}
      style={{ width: `${100 / 7}%`, padding: space[1] / 2 }}
    >
      <View
        style={{
          minHeight: minTouchTarget + space[2],
          alignItems: 'center',
          justifyContent: 'center',
          gap: 2,
          borderRadius: radius.md,
          borderWidth: selected ? 2 : 1,
          borderColor: selected ? colors.primary : colors.border,
          backgroundColor: fill,
        }}
      >
        <AppText variant="small" weight={today ? 700 : 500}>
          {Number(day.date.slice(8))}
        </AppText>
        {Icon && key ? (
          <>
            <Icon size={14} strokeWidth={1.75} color={colors[ink]} />
            <AppText variant="caption" color={ink} numberOfLines={1}>
              {t(`attendance.short.${key}`)}
            </AppText>
          </>
        ) : null}
      </View>
    </Pressable>
  );
}

function Detail({ day }: { day: Day }) {
  const { t } = useTranslation();
  const duration = useDuration();
  const flags = [
    ...new Set(
      day.flags.filter((flag) => FLAGS.includes(flag)).map((flag) => t(`attendance.flag.${flag}`)),
    ),
  ];

  return (
    <Card testID="day-detail">
      <AppText variant="h3" accessibilityRole="header">
        {formatIstDay(day.date)}
      </AppText>
      <AttendanceBadge status={day.status} />
      {day.first_in_at ? (
        <>
          <AppText>
            {t('attendance.detail.in')}: {formatIstTime(day.first_in_at)}
          </AppText>
          <AppText>
            {t('attendance.detail.out')}: {day.last_out_at ? formatIstTime(day.last_out_at) : '-'}
          </AppText>
          <AppText>
            {t('attendance.detail.hours')}: {duration(day.worked_minutes)}
          </AppText>
        </>
      ) : (
        <AppText color="muted">{t('attendance.detail.none')}</AppText>
      )}
      {day.late_minutes > 0 ? (
        <AppText color="warningFg">
          {t('attendance.detail.late', { minutes: day.late_minutes })}
        </AppText>
      ) : null}
      {flags.map((flag) => (
        <AppText key={flag} variant="small" color="muted">
          {flag}
        </AppText>
      ))}
    </Card>
  );
}

function Summary({ summary }: { summary: components['schemas']['MonthSummary'] }) {
  const { t } = useTranslation();
  const { space } = useTheme();
  const duration = useDuration();
  const tiles: [string, string][] = [
    [t('attendance.summary.present'), String(summary.present)],
    [t('attendance.summary.half_day'), String(summary.half_day)],
    [t('attendance.summary.short_hours'), String(summary.short_hours)],
    [t('attendance.summary.absent'), String(summary.absent)],
    [t('attendance.summary.late'), String(summary.late)],
    [t('attendance.summary.worked'), duration(summary.worked_minutes)],
  ];
  return (
    <Card testID="month-summary">
      <AppText variant="h3" accessibilityRole="header">
        {t('attendance.summaryTitle')}
      </AppText>
      <View style={{ flexDirection: 'row', flexWrap: 'wrap', rowGap: space[3] }}>
        {tiles.map(([label, value]) => (
          <View
            key={label}
            style={{ width: '33.33%' }}
            accessible
            accessibilityLabel={`${label}: ${value}`}
          >
            <AppText variant="small" color="muted">
              {label}
            </AppText>
            <AppText weight={700}>{value}</AppText>
          </View>
        ))}
      </View>
    </Card>
  );
}

function Legend() {
  const { t } = useTranslation();
  const { space } = useTheme();
  return (
    <Card>
      <AppText variant="h3" accessibilityRole="header">
        {t('attendance.legend')}
      </AppText>
      <View style={{ flexDirection: 'row', flexWrap: 'wrap', gap: space[2] }}>
        {LEGEND.map((status) => (
          <AttendanceBadge key={status} status={status} />
        ))}
      </View>
    </Card>
  );
}

/** The employee's own month: a calendar of day statuses, the chosen day, and the month's totals. */
export function AttendanceCalendar() {
  const { t } = useTranslation();
  const { space } = useTheme();
  const [month, setMonth] = useState(() => monthOf(istDay()));
  const [selected, setSelected] = useState<string | null>(null);
  const history = useQuery({
    queryKey: [...MONTH_KEY, month],
    queryFn: () => unwrap(api.GET('/api/v1/attendance/me', { params: { query: { month } } })),
    retry: false,
  });
  useRefetchOnFocus(history.refetch);
  const data = history.data;
  const { earliest, latest } = monthLimits(data?.today ?? istDay());
  const chosen =
    data?.days.find((day) => day.date === selected) ??
    data?.days.find((day) => day.date === data.today) ??
    data?.days[0];

  return (
    <>
      <MonthHeader
        month={month}
        earliest={earliest}
        latest={latest}
        onChange={(next) => {
          setMonth(next);
          setSelected(null);
        }}
      />
      {history.isPending ? (
        <Skeleton height={space[16] * 5} accessibilityLabel={t('common.loading')} />
      ) : null}
      {history.isError ? (
        <Banner status="danger" icon={TriangleAlert} message={t('attendance.loadFailed')}>
          <Button
            variant="secondary"
            icon={RefreshCw}
            label={t('common.retry')}
            onPress={() => void history.refetch()}
            disabled={history.isFetching}
          />
        </Banner>
      ) : null}
      {data ? (
        <>
          <View>
            <View style={{ flexDirection: 'row' }}>
              {WEEKDAYS.map((weekday) => (
                <View key={weekday} style={{ width: `${100 / 7}%`, alignItems: 'center' }}>
                  <AppText variant="caption" color="muted">
                    {t(`attendance.weekday.${weekday}`)}
                  </AppText>
                </View>
              ))}
            </View>
            <View style={{ flexDirection: 'row', flexWrap: 'wrap' }}>
              {Array.from({ length: leadingBlanks(month) }, (_, index) => (
                <View key={`blank-${index}`} style={{ width: `${100 / 7}%` }} />
              ))}
              {data.days.map((day) => (
                <DayCell
                  key={day.date}
                  day={day}
                  selected={day.date === chosen?.date}
                  today={day.date === data.today}
                  onPress={() => setSelected(day.date)}
                />
              ))}
            </View>
          </View>
          {data.days.every((day) => day.status === null) ? (
            <EmptyState message={t('attendance.empty')} />
          ) : (
            <>
              {chosen ? <Detail day={chosen} /> : null}
              <Summary summary={data.summary} />
            </>
          )}
          <Legend />
        </>
      ) : null}
    </>
  );
}
