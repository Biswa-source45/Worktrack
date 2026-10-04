import type { components } from 'api-types';
import { Monitor, Smartphone } from '@/components/icons';
import { useTranslation } from 'react-i18next';
import { View } from 'react-native';
import { AppText } from '@/components/ui/app-text';
import { useTheme } from '@/lib/theme';

export type Session = components['schemas']['SessionOut'];

/** The browser of a web session or the phone model of a mobile one; never the raw user agent. */
export function useSessionDevice() {
  const { t } = useTranslation();
  return (session: Session) =>
    session.client === 'web'
      ? (session.browser ?? t('sessions.unknownBrowser'))
      : (session.device_model ?? t('sessions.unknownPhone'));
}

/** Type (icon + label) and what the session runs on. */
export function SessionClient({ session }: { session: Session }) {
  const { t } = useTranslation();
  const { colors, space } = useTheme();
  const device = useSessionDevice();
  const Icon = session.client === 'web' ? Monitor : Smartphone;

  return (
    <View style={{ flexDirection: 'row', gap: space[2] }}>
      {/* Nudged down to sit on the first text line (24 high) when the text wraps. */}
      <Icon size={20} strokeWidth={1.75} color={colors.muted} style={{ marginTop: 2 }} />
      <AppText weight={500} style={{ flex: 1 }}>
        {t(`sessions.client.${session.client}`)} · {device(session)}
      </AppText>
    </View>
  );
}
