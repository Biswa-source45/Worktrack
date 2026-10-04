import { TriangleAlert } from '@/components/icons';
import { useTranslation } from 'react-i18next';
import { Platform, View } from 'react-native';
import { AppText } from '@/components/ui/app-text';
import { Banner } from '@/components/ui/banner';
import { Button } from '@/components/ui/button';
import { Dialog } from '@/components/ui/dialog';
import { useTheme } from '@/lib/theme';

// The two platforms name their built-in fixed-width font differently, and no such font is bundled.
const MONOSPACE = Platform.select({ ios: 'Menlo', default: 'monospace' });

type Props = { name: string; empCode: string; password: string; onClose: () => void };

// The password lives only in the caller's state and these props; closing drops both.
export function TempPasswordDialog({ name, empCode, password, onClose }: Props) {
  const { t } = useTranslation();
  const { colors, radius, space } = useTheme();

  return (
    <Dialog title={t('temporaryPassword.title')} onRequestClose={onClose}>
      <AppText color="muted">
        {name} ({empCode})
      </AppText>
      <Banner status="danger" icon={TriangleAlert} message={t('temporaryPassword.warning')} />
      <View style={{ padding: space[4], borderRadius: radius.md, backgroundColor: colors.raised }}>
        <AppText
          testID="temp-password"
          selectable
          variant="large"
          style={{ fontFamily: MONOSPACE, fontWeight: 'normal' }}
        >
          {password}
        </AppText>
      </View>
      <Button label={t('common.close')} onPress={onClose} />
    </Dialog>
  );
}
