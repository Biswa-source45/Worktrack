import { useQuery } from '@tanstack/react-query';
import {
  ArrowLeft,
  CircleX,
  Info,
  KeyRound,
  LockOpen,
  RefreshCw,
  TriangleAlert,
  UserRoundCheck,
  UserRoundX,
} from '@/components/icons';
import { useLocalSearchParams, useRouter } from 'expo-router';
import { useState } from 'react';
import { useTranslation } from 'react-i18next';
import { Pressable, View } from 'react-native';
import { EmployeeBadges, isLocked } from '@/components/admin/employee-badges';
import { TempPasswordDialog } from '@/components/admin/temp-password-dialog';
import { useAdminAction } from '@/components/admin/use-admin-action';
import { AppText } from '@/components/ui/app-text';
import { Avatar } from '@/components/ui/avatar';
import { Banner } from '@/components/ui/banner';
import { Button } from '@/components/ui/button';
import { Card } from '@/components/ui/card';
import { ConfirmDialog } from '@/components/ui/confirm-dialog';
import { DetailRow } from '@/components/ui/detail-row';
import { Screen } from '@/components/ui/screen';
import { Skeleton } from '@/components/ui/skeleton';
import { api } from '@/lib/api';
import { errorText, unwrap } from '@/lib/api-error';
import { formatIstDate } from '@/lib/ist';
import { useTheme } from '@/lib/theme';

type Asking = 'deactivate' | 'reactivate' | 'reset';

export default function EmployeeScreen() {
  const { t } = useTranslation();
  const router = useRouter();
  const run = useAdminAction();
  const { colors, space, minTouchTarget } = useTheme();
  const employeeId = Number(useLocalSearchParams<{ id: string }>().id);
  const path = { employee_id: employeeId };

  const [asking, setAsking] = useState<Asking | null>(null);
  const [unlocking, setUnlocking] = useState(false);
  const [unlockError, setUnlockError] = useState<string | null>(null);
  // Plain state, never the query cache: Close drops the only copy of the password.
  const [temporaryPassword, setTemporaryPassword] = useState<string | null>(null);

  const query = useQuery({
    queryKey: ['admin', 'employee', employeeId],
    queryFn: () => unwrap(api.GET('/api/v1/admin/employees/{employee_id}', { params: { path } })),
    // No silent retries: a 403 shows at once, and Retry is on screen.
    retry: false,
  });
  const employee = query.data;

  async function unlock() {
    setUnlocking(true);
    setUnlockError(null);
    try {
      await run(api.POST('/api/v1/admin/employees/{employee_id}/unlock', { params: { path } }));
    } catch (failure) {
      setUnlockError(errorText(t, failure));
    } finally {
      setUnlocking(false);
    }
  }

  async function confirmed(action: Asking) {
    if (action === 'reset') {
      const { temporary_password } = await run(
        api.POST('/api/v1/admin/employees/{employee_id}/reset-password', { params: { path } }),
      );
      setTemporaryPassword(temporary_password);
      return;
    }
    await run(
      api.PATCH('/api/v1/admin/employees/{employee_id}', {
        params: { path },
        body: { status: action === 'deactivate' ? 'inactive' : 'active' },
      }),
    );
  }

  const yesNo = (value: boolean) => t(value ? 'common.yes' : 'common.no');

  return (
    <Screen scroll edges={['top', 'left', 'right']}>
      <Pressable
        accessibilityRole="button"
        accessibilityLabel={t('common.back')}
        onPress={() => router.back()}
        style={{
          width: minTouchTarget,
          height: minTouchTarget,
          justifyContent: 'center',
          // Pulls the arrow to the screen edge of the padded column; the target keeps its full width.
          marginLeft: -space[2],
          alignItems: 'center',
        }}
      >
        <ArrowLeft size={24} strokeWidth={1.75} color={colors.text} />
      </Pressable>

      {query.isPending ? (
        <Card>
          <Skeleton width="60%" height={space[6]} accessibilityLabel={t('common.loading')} />
          <Skeleton />
          <Skeleton width="80%" />
        </Card>
      ) : null}
      {query.isError ? (
        <Banner status="danger" icon={TriangleAlert} message={errorText(t, query.error)}>
          <Button
            variant="secondary"
            icon={RefreshCw}
            label={t('common.retry')}
            onPress={() => void query.refetch()}
            disabled={query.isFetching}
          />
        </Banner>
      ) : null}

      {employee ? (
        <>
          <View style={{ flexDirection: 'row', alignItems: 'center', gap: space[3] }}>
            <Avatar name={employee.name} size={64} />
            <View style={{ flex: 1, gap: space[1] }}>
              <AppText variant="h2" accessibilityRole="header">
                {employee.name}
              </AppText>
              <AppText color="muted">{employee.emp_code}</AppText>
            </View>
          </View>
          <EmployeeBadges employee={employee} />

          <Card>
            <DetailRow label={t('employees.mobile')} value={employee.mobile} />
            <DetailRow
              label={t('employees.email')}
              value={employee.email ?? t('employees.notSet')}
            />
            <DetailRow label={t('profile.designation')} value={employee.designation.name} />
            <DetailRow label={t('profile.role')} value={employee.role.name} />
            <DetailRow
              label={t('profile.department')}
              value={employee.department?.name ?? t('profile.noDepartment')}
            />
            <DetailRow label={t('employees.joinedOn')} value={formatIstDate(employee.joined_on)} />
            <DetailRow
              label={t('employees.fieldEligible')}
              value={yesNo(employee.field_eligible)}
            />
            <DetailRow
              label={t('employees.mustChangePassword')}
              value={yesNo(employee.must_change_password)}
            />
          </Card>

          <View style={{ flexDirection: 'row', gap: space[2] }}>
            <Info size={16} strokeWidth={1.75} color={colors.muted} style={{ marginTop: 2 }} />
            <AppText variant="small" color="muted" style={{ flex: 1 }}>
              {t('employees.editOnWeb')}
            </AppText>
          </View>

          {/* Actions sit last, low on the screen, in reach of the thumb. */}
          <View style={{ flexGrow: 1, justifyContent: 'flex-end', gap: space[3] }}>
            {unlockError ? <Banner status="danger" icon={CircleX} message={unlockError} /> : null}
            {isLocked(employee) ? (
              <Button
                variant="secondary"
                icon={LockOpen}
                label={t('employees.unlock')}
                onPress={() => void unlock()}
                loading={unlocking}
              />
            ) : null}
            <Button
              variant="secondary"
              icon={KeyRound}
              label={t('employees.resetPassword')}
              onPress={() => setAsking('reset')}
            />
            {employee.status === 'active' ? (
              <Button
                variant="destructive"
                icon={UserRoundX}
                label={t('employees.deactivate')}
                onPress={() => setAsking('deactivate')}
              />
            ) : (
              <Button
                variant="secondary"
                icon={UserRoundCheck}
                label={t('employees.reactivate')}
                onPress={() => setAsking('reactivate')}
              />
            )}
          </View>

          {asking ? (
            <ConfirmDialog
              title={t(asking === 'reset' ? 'employees.resetPassword' : `employees.${asking}`)}
              message={t(`employees.${asking}Confirm`, { name: employee.name })}
              confirmLabel={t(
                asking === 'reset' ? 'employees.resetPassword' : `employees.${asking}`,
              )}
              destructive={asking !== 'reactivate'}
              onConfirm={() => confirmed(asking)}
              onClose={() => setAsking(null)}
            />
          ) : null}
          {temporaryPassword && !asking ? (
            <TempPasswordDialog
              name={employee.name}
              empCode={employee.emp_code}
              password={temporaryPassword}
              onClose={() => setTemporaryPassword(null)}
            />
          ) : null}
        </>
      ) : null}
    </Screen>
  );
}
