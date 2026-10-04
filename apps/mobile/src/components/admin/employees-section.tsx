import { keepPreviousData, useInfiniteQuery } from '@tanstack/react-query';
import { ChevronRight } from '@/components/icons';
import { useRouter } from 'expo-router';
import type { Href } from 'expo-router';
import { useEffect, useState } from 'react';
import type { ReactNode } from 'react';
import { useTranslation } from 'react-i18next';
import { Pressable, View } from 'react-native';
import { AppText } from '@/components/ui/app-text';
import { Avatar } from '@/components/ui/avatar';
import { Card } from '@/components/ui/card';
import { Field } from '@/components/ui/field';
import { FilterPills } from '@/components/ui/filter-pills';
import { api } from '@/lib/api';
import { unwrap } from '@/lib/api-error';
import { useTheme } from '@/lib/theme';
import { EmployeeBadges, isLocked } from './employee-badges';
import type { Employee } from './employee-badges';
import { PagedList } from './paged-list';

type Filter = 'all' | 'active' | 'inactive';

const FILTERS = ['all', 'active', 'inactive'] as const;
const SEARCH_DELAY_MS = 300;

function EmployeeRow({ employee, onOpen }: { employee: Employee; onOpen: () => void }) {
  const { t } = useTranslation();
  const { colors, space } = useTheme();
  const active = employee.status === 'active';
  // One spoken sentence for the whole row: the parts inside a button are not read one by one.
  const spoken = [
    `${employee.name} (${employee.emp_code})`,
    employee.designation.name,
    employee.role.name,
    t(active ? 'employees.status.active' : 'employees.status.inactive'),
    isLocked(employee) ? t('employees.locked') : null,
  ]
    .filter(Boolean)
    .join(', ');

  return (
    <Pressable
      accessibilityRole="button"
      accessibilityLabel={spoken}
      onPress={onOpen}
      style={({ pressed }) => ({ opacity: pressed ? 0.85 : 1 })}
    >
      <Card style={{ flexDirection: 'row', alignItems: 'center' }}>
        <Avatar name={employee.name} />
        <View style={{ flex: 1, gap: space[1] }}>
          <AppText weight={600}>{employee.name}</AppText>
          <AppText variant="small" color="muted">
            {employee.emp_code} · {employee.designation.name} · {employee.role.name}
          </AppText>
          <EmployeeBadges employee={employee} />
        </View>
        <ChevronRight size={20} strokeWidth={1.75} color={colors.muted} />
      </Card>
    </Pressable>
  );
}

export function EmployeesSection({ top }: { top: ReactNode }) {
  const { t } = useTranslation();
  const router = useRouter();
  const [filter, setFilter] = useState<Filter>('all');
  const [typed, setTyped] = useState('');
  const [q, setQ] = useState('');

  // Waits for a pause in typing, so each keystroke is not a request.
  useEffect(() => {
    const timer = setTimeout(() => setQ(typed.trim()), SEARCH_DELAY_MS);
    return () => clearTimeout(timer);
  }, [typed]);

  const list = useInfiniteQuery({
    queryKey: ['admin', 'employees', filter, q],
    initialPageParam: undefined as string | undefined,
    queryFn: ({ pageParam }) =>
      unwrap(
        api.GET('/api/v1/admin/employees', {
          params: {
            query: {
              q: q || undefined,
              status: filter === 'all' ? undefined : filter,
              limit: 20,
              cursor: pageParam,
            },
          },
        }),
      ),
    getNextPageParam: (page) => page.next_cursor ?? undefined,
    placeholderData: keepPreviousData,
    // No silent retries: a 403 shows at once, and Retry and pull to refresh are on screen.
    retry: false,
  });

  return (
    <PagedList
      query={list}
      empty={t('employees.empty')}
      renderItem={(employee) => (
        <EmployeeRow
          employee={employee}
          // The route types are generated when Expo starts; until that run has seen the admin
          // routes, only the cast lets this path through the type check.
          onOpen={() => router.push(`/admin/employees/${employee.id}` as Href)}
        />
      )}
      header={
        <>
          {top}
          <Field
            label={t('employees.search')}
            value={typed}
            onChangeText={setTyped}
            returnKeyType="search"
          />
          <FilterPills
            value={filter}
            onChange={setFilter}
            options={FILTERS.map((option) => ({
              value: option,
              label: t(`employees.status.${option}`),
            }))}
          />
        </>
      }
    />
  );
}
