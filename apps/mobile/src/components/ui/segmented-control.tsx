import type { LucideIcon } from 'lucide-react-native';
import { Pressable, View } from 'react-native';
import { useTheme } from '@/lib/theme';
import { AppText } from './app-text';

type Option<T extends string> = { value: T; label: string; icon: LucideIcon };

type Props<T extends string> = {
  options: readonly Option<T>[];
  value: T;
  onChange: (value: T) => void;
};

export function SegmentedControl<T extends string>({ options, value, onChange }: Props<T>) {
  const { colors, radius, space, minTouchTarget } = useTheme();

  return (
    <View
      style={{
        flexDirection: 'row',
        gap: space[1],
        padding: space[1],
        borderRadius: radius.lg,
        borderWidth: 1,
        borderColor: colors.border,
      }}
    >
      {options.map(({ value: option, label, icon: Icon }) => {
        const selected = option === value;
        const ink = selected ? 'text' : 'muted';
        return (
          <Pressable
            key={option}
            accessibilityRole="button"
            accessibilityLabel={label}
            accessibilityState={{ selected }}
            onPress={() => onChange(option)}
            // Icon above label: three segments stay readable at large system font sizes.
            style={{
              flex: 1,
              minHeight: minTouchTarget,
              alignItems: 'center',
              justifyContent: 'center',
              gap: space[1],
              paddingVertical: space[2],
              paddingHorizontal: space[1],
              borderRadius: radius.md,
              borderWidth: 1,
              borderColor: selected ? colors.borderStrong : 'transparent',
              backgroundColor: selected ? colors.raised : 'transparent',
            }}
          >
            <Icon size={20} strokeWidth={1.75} color={colors[ink]} />
            <AppText
              variant="small"
              weight={selected ? 600 : 500}
              color={ink}
              style={{ textAlign: 'center' }}
            >
              {label}
            </AppText>
          </Pressable>
        );
      })}
    </View>
  );
}
