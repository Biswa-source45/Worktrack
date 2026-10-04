import { Stack } from 'expo-router';
import { can, useAuth } from '@/lib/auth';
import { useTheme } from '@/lib/theme';

// A link straight to an employee still gets the Admin home underneath, so Back has a target.
export const unstable_settings = { initialRouteName: 'index' };

export default function AdminLayout() {
  const { me } = useAuth();
  const { colors } = useTheme();

  return (
    <Stack
      screenOptions={{ headerShown: false, contentStyle: { backgroundColor: colors.background } }}
    >
      <Stack.Screen name="index" />
      <Stack.Protected guard={can(me, 'employees.manage')}>
        <Stack.Screen name="employees/[id]" />
      </Stack.Protected>
    </Stack>
  );
}
