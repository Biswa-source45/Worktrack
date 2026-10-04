import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { Stack } from 'expo-router';
import { StatusBar } from 'expo-status-bar';
import { I18nextProvider } from 'react-i18next';
import { AuthProvider, sessionGuards, useAuth } from '@/lib/auth';
import i18n from '@/lib/i18n';

const queryClient = new QueryClient();

// Protected screens are unmounted when their guard turns false, and expo-router then redirects to
// the first screen that is still available, so no screen navigates by hand after login or logout.
function Gate() {
  const { status, me } = useAuth();
  const guards = sessionGuards(status, me);
  return (
    <Stack screenOptions={{ headerShown: false }}>
      <Stack.Protected guard={guards.loading}>
        <Stack.Screen name="loading" />
      </Stack.Protected>
      <Stack.Protected guard={guards.signedOut}>
        <Stack.Screen name="(auth)/login" />
      </Stack.Protected>
      <Stack.Protected guard={guards.mustChange}>
        <Stack.Screen name="(auth)/change-password" />
      </Stack.Protected>
      <Stack.Protected guard={guards.ready}>
        <Stack.Screen name="(app)/index" />
      </Stack.Protected>
      <Stack.Screen name="health" />
    </Stack>
  );
}

export default function RootLayout() {
  return (
    <I18nextProvider i18n={i18n}>
      <QueryClientProvider client={queryClient}>
        <AuthProvider>
          <StatusBar style="auto" />
          <Gate />
        </AuthProvider>
      </QueryClientProvider>
    </I18nextProvider>
  );
}
