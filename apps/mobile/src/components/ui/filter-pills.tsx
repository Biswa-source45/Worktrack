import { useTranslation } from 'react-i18next';
import { Pressable, ScrollView } from 'react-native';
import { useTheme } from '@/lib/theme';
import { AppText } from './app-text';

type Option<T extends string> = { value: T; label: string; count?: number };

type Props<T extends string> = {
  options: readonly Option<T>[];
  value: T;
  onChange: (value: T) => void;
};

/** A row of filter pills that scrolls sideways, so long labels and large text never wrap or clip. */
export function FilterPills<T extends string>({ options, value, onChange }: Props<T>) {
  const { t } = useTranslation();
  const { colors, radius, space, minTouchTarget } = useTheme();

  return (
    <ScrollView
      horizontal
      showsHorizontalScrollIndicator={false}
      keyboardShouldPersistTaps="handled"
      style={{ flexGrow: 0 }}
      contentContainerStyle={{ gap: space[2] }}
    >
      {options.map(({ value: option, label, count }) => {
        const selected = option === value;
        const ink = selected ? 'primaryForeground' : 'text';
        return (
          <Pressable
            key={option}
            accessibilityRole="button"
            accessibilityLabel={
              count === undefined ? label : t('common.labelWithCount', { label, count })
            }
            accessibilityState={{ selected }}
            onPress={() => onChange(option)}
            // Selected is a filled pill, the others are outlined: the state shows by shape too.
            style={{
              minHeight: minTouchTarget,
              flexDirection: 'row',
              alignItems: 'center',
              gap: space[2],
              paddingHorizontal: space[4],
              borderRadius: radius.pill,
              borderWidth: 1,
              borderColor: selected ? colors.primary : colors.borderStrong,
              backgroundColor: selected ? colors.primary : colors.surface,
            }}
          >
            <AppText variant="small" weight={600} color={ink}>
              {label}
            </AppText>
            {count === undefined ? null : (
              <AppText
                variant="small"
                weight={selected ? 600 : 500}
                color={selected ? ink : 'muted'}
              >
                {count}
              </AppText>
            )}
          </Pressable>
        );
      })}
    </ScrollView>
  );
}
