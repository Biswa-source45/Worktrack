import type { components } from 'api-types';
import { CircleCheck, CircleMinus, Lock } from '@/components/icons';
import { useTranslation } from 'react-i18next';
import { View } from 'react-native';
import { Badge } from '@/components/ui/badge';
import { useTheme } from '@/lib/theme';

export type Employee = components['schemas']['EmployeeOut'];

// The phone's clock only decides whether to show the badge and the Unlock button; the server
// decides whether the account is really locked.
export const isLocked = (employee: Employee) =>
  employee.locked_until !== null && new Date(employee.locked_until).getTime() > Date.now();

export function EmployeeBadges({ employee }: { employee: Employee }) {
  const { t } = useTranslation();
  const { space } = useTheme();
  const active = employee.status === 'active';

  return (
    <View style={{ flexDirection: 'row', flexWrap: 'wrap', gap: space[2] }}>
      <Badge
        status={active ? 'success' : 'neutral'}
        icon={active ? CircleCheck : CircleMinus}
        label={t(active ? 'employees.status.active' : 'employees.status.inactive')}
      />
      {isLocked(employee) ? (
        <Badge status="warning" icon={Lock} label={t('employees.locked')} />
      ) : null}
    </View>
  );
}
