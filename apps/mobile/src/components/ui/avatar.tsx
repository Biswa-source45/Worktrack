import { View } from 'react-native';
import { useTheme } from '@/lib/theme';
import { AppText } from './app-text';

/** First letters of the first and last word of a name, at most two. */
export function initials(name: string): string {
  const words = name.trim().split(/\s+/).filter(Boolean);
  const picked = words.length > 1 ? [words[0], words[words.length - 1]] : words;
  return picked.map((word) => word.charAt(0).toUpperCase()).join('');
}

// Decorative: the name is always shown as text next to it.
export function Avatar({ name, size = 48 }: { name: string; size?: number }) {
  const { colors } = useTheme();
  return (
    <View
      accessibilityElementsHidden
      importantForAccessibility="no-hide-descendants"
      style={{
        width: size,
        height: size,
        borderRadius: size / 2,
        alignItems: 'center',
        justifyContent: 'center',
        backgroundColor: colors.raised,
        borderWidth: 1,
        borderColor: colors.border,
      }}
    >
      {/* Fixed circle: scaled text would clip, and the full name next to it does scale. */}
      <AppText variant={size >= 64 ? 'h3' : 'body'} weight={600} allowFontScaling={false}>
        {initials(name)}
      </AppText>
    </View>
  );
}
