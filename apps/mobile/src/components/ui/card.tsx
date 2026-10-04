import { View } from 'react-native';
import type { ViewProps } from 'react-native';
import { useTheme } from '@/lib/theme';

type Props = ViewProps & { corner?: 'lg' | 'xl' };

export function Card({ corner = 'lg', style, ...rest }: Props) {
  const { colors, radius, space, shadow } = useTheme();
  return (
    <View
      style={[
        {
          backgroundColor: colors.surface,
          borderColor: colors.border,
          borderWidth: 1,
          borderRadius: radius[corner],
          padding: space[5],
          gap: space[3],
        },
        shadow('sm'),
        style,
      ]}
      {...rest}
    />
  );
}
