import type { Status } from 'design-tokens';
import type { LucideIcon } from 'lucide-react-native';
import { View } from 'react-native';
import { useTheme } from '@/lib/theme';
import { AppText } from './app-text';

export type BadgeStatus = Status | 'neutral';

type Props = {
  status: BadgeStatus;
  icon: LucideIcon;
  label: string;
  /** Read instead of the label when the pill alone would lack context. */
  accessibilityLabel?: string;
  testID?: string;
  iconTestID?: string;
};

/** Status is always icon + label + colour, never colour alone. */
export function Badge({
  status,
  icon: Icon,
  label,
  accessibilityLabel,
  testID,
  iconTestID,
}: Props) {
  const { colors, radius, space } = useTheme();
  const ink = status === 'neutral' ? 'muted' : (`${status}Fg` as const);
  const fill = status === 'neutral' ? colors.raised : colors[`${status}Subtle`];

  return (
    <View
      testID={testID}
      accessible
      accessibilityLabel={accessibilityLabel ?? label}
      style={{
        flexDirection: 'row',
        alignItems: 'center',
        alignSelf: 'flex-start',
        gap: space[1],
        paddingHorizontal: space[3],
        paddingVertical: space[1],
        borderRadius: radius.pill,
        backgroundColor: fill,
      }}
    >
      <Icon testID={iconTestID} size={16} strokeWidth={1.75} color={colors[ink]} />
      <AppText variant="small" weight={600} color={ink} style={{ flexShrink: 1 }}>
        {label}
      </AppText>
    </View>
  );
}
