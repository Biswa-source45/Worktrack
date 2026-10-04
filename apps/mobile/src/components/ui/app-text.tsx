import type { TypeToken } from 'design-tokens';
import { Text } from 'react-native';
import type { TextProps } from 'react-native';
import type { FontWeight } from '@/lib/fonts';
import { useTheme } from '@/lib/theme';
import type { ColorRole } from '@/lib/theme';

type Props = TextProps & { variant?: TypeToken; color?: ColorRole; weight?: FontWeight };

export function AppText({ variant = 'body', color = 'text', weight, style, ...rest }: Props) {
  const { colors, text } = useTheme();
  return <Text style={[text(variant, weight), { color: colors[color] }, style]} {...rest} />;
}
