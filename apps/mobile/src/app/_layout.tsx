import { useFonts } from '@expo-google-fonts/plus-jakarta-sans/useFonts';
import { QueryCache, QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { Stack } from 'expo-router';
import { I18nextProvider } from 'react-i18next';
import { AuthProvider, sessionGuards, useAuth } from '@/lib/auth';
import { fonts } from '@/lib/fonts';
import i18n from '@/lib/i18n';
import { requestSync } from '@/lib/punch-sync';
import { ThemeProvider, useTheme } from '@/lib/theme';
import LoadingScreen from './loading';

// A successful call proves the server is reachable: the moment to send punches saved offline.
const queryClient = new QueryClient({
  queryCache: new QueryCache({ onSuccess: () => void requestSync() }),
});

// Protected screens are unmounted when their guard turns false, and expo-router then redirects to
// the first screen that is still available, so no screen navigates by hand after login or logout.
function Gate({ fontsSettled }: { fontsSettled: boolean }) {
  const { status, me } = useAuth();
  const { colors, ready } = useTheme();
  const guards = sessionGuards(status, me);

  // Held until the stored theme and the fonts are in, so no screen repaints right after it shows.
  if (!ready || !fontsSettled) return <LoadingScreen />;

  return (
    <Stack
      screenOptions={{ headerShown: false, contentStyle: { backgroundColor: colors.background } }}
    >
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
        <Stack.Screen name="(app)" />
        <Stack.Screen name="face/consent" />
        <Stack.Screen name="face/capture" />
        <Stack.Screen name="punch/request" />
        <Stack.Screen name="punch/capture" />
        <Stack.Screen name="punch/result" />
        <Stack.Screen name="punch/queue" />
        <Stack.Screen name="tasks/[id]/index" />
        <Stack.Screen name="tasks/[id]/reach" />
        <Stack.Screen name="tasks/[id]/compose" />
      </Stack.Protected>
      <Stack.Screen name="health" />
    </Stack>
  );
}

export default function RootLayout() {
  // A failed font load is not fatal: text falls back to the system font.
  const [fontsLoaded, fontError] = useFonts(fonts);

  return (
    <I18nextProvider i18n={i18n}>
      <QueryClientProvider client={queryClient}>
        <ThemeProvider fontsLoaded={fontsLoaded}>
          <AuthProvider>
            <Gate fontsSettled={fontsLoaded || fontError !== null} />
          </AuthProvider>
        </ThemeProvider>
      </QueryClientProvider>
    </I18nextProvider>
  );
}
