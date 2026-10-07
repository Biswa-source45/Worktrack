import { ArrowLeft } from '@/components/icons';
import { useRouter } from 'expo-router';
import { useTranslation } from 'react-i18next';
import { Pressable } from 'react-native';
import { useTheme } from '@/lib/theme';

/** Goes back one screen; a screen that must do something else first passes its own `onPress`. */
export function BackButton({ onPress }: { onPress?: () => void }) {
  const { t } = useTranslation();
  const router = useRouter();
  const { colors, space, minTouchTarget } = useTheme();

  return (
    <Pressable
      accessibilityRole="button"
      accessibilityLabel={t('common.back')}
      onPress={onPress ?? (() => router.back())}
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
  );
}
