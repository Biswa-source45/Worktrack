import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { Stack } from 'expo-router';
import { StatusBar } from 'expo-status-bar';
import { I18nextProvider } from 'react-i18next';
import i18n from '@/lib/i18n';

const queryClient = new QueryClient();

export default function RootLayout() {
  return (
    <I18nextProvider i18n={i18n}>
      <QueryClientProvider client={queryClient}>
        <StatusBar style="auto" />
        <Stack screenOptions={{ headerShown: false }} />
      </QueryClientProvider>
    </I18nextProvider>
  );
}
