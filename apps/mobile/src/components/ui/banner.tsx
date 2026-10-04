import type { LucideIcon } from 'lucide-react-native';
import type { ReactNode } from 'react';
import { View } from 'react-native';
import { useTheme } from '@/lib/theme';
import { AppText } from './app-text';

type Props = {
  status: 'warning' | 'danger';
  icon: LucideIcon;
  message: string;
  /** Actions shown under the message. */
  children?: ReactNode;
};

/** An inline alert: announced by screen readers when it appears. */
export function Banner({ status, icon: Icon, message, children }: Props) {
  const { colors, radius, space } = useTheme();
  const ink = `${status}Fg` as const;

  return (
    <View
      style={{
        gap: space[3],
        padding: space[4],
        borderRadius: radius.lg,
        backgroundColor: colors[`${status}Subtle`],
      }}
    >
      <View style={{ flexDirection: 'row', gap: space[2] }}>
        <Icon size={20} strokeWidth={1.75} color={colors[ink]} />
        {/* The role is on the text, not the box: an accessible box would swallow its buttons. */}
        <AppText
          accessibilityRole="alert"
          variant="small"
          weight={600}
          color={ink}
          style={{ flex: 1 }}
        >
          {message}
        </AppText>
      </View>
      {children}
    </View>
  );
}
