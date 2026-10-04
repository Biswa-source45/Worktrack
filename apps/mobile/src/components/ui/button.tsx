import type { LucideIcon } from 'lucide-react-native';
import { useState } from 'react';
import { ActivityIndicator, Animated, Pressable } from 'react-native';
import { useReducedMotion } from '@/lib/reduced-motion';
import { easeOut, useTheme } from '@/lib/theme';
import { AppText } from './app-text';

type Variant = 'primary' | 'secondary' | 'ghost' | 'destructive';

type Props = {
  label: string;
  onPress: () => void;
  variant?: Variant;
  icon?: LucideIcon;
  disabled?: boolean;
  /** Shows a spinner next to the label and blocks presses. */
  loading?: boolean;
  /** Read instead of the label when several buttons on a screen share it. */
  accessibilityLabel?: string;
};

export function Button({
  label,
  onPress,
  variant = 'primary',
  icon: Icon,
  disabled = false,
  loading = false,
  accessibilityLabel,
}: Props) {
  const { colors, radius, space, motion, minTouchTarget } = useTheme();
  const reduced = useReducedMotion();
  const [scale] = useState(() => new Animated.Value(1));
  const blocked = disabled || loading;

  const look = {
    primary: { fill: colors.primary, edge: colors.primary, ink: 'primaryForeground' },
    secondary: { fill: colors.surface, edge: colors.borderStrong, ink: 'text' },
    ghost: { fill: 'transparent', edge: 'transparent', ink: 'primaryText' },
    destructive: { fill: colors.surface, edge: colors.dangerFg, ink: 'dangerFg' },
  } as const;
  const { fill, edge, ink } = look[variant];

  function animateTo(toValue: number) {
    // Reduce Motion: no transform; the pressed opacity below is the only feedback.
    if (reduced) return;
    Animated.timing(scale, {
      toValue,
      duration: motion.fast,
      easing: easeOut,
      useNativeDriver: true,
    }).start();
  }

  return (
    <Animated.View style={{ transform: [{ scale }] }}>
      <Pressable
        accessibilityRole="button"
        accessibilityLabel={accessibilityLabel ?? label}
        accessibilityState={{ disabled: blocked, busy: loading }}
        disabled={blocked}
        onPress={onPress}
        onPressIn={() => animateTo(motion.pressScale)}
        onPressOut={() => animateTo(1)}
        style={({ pressed }) => ({
          minHeight: minTouchTarget,
          flexDirection: 'row',
          alignItems: 'center',
          justifyContent: 'center',
          gap: space[2],
          paddingHorizontal: space[5],
          paddingVertical: space[3],
          borderRadius: radius.pill,
          borderWidth: 1,
          borderColor: edge,
          backgroundColor: fill,
          opacity: blocked ? 0.5 : pressed ? 0.85 : 1,
        })}
      >
        {loading ? (
          <ActivityIndicator color={colors[ink]} />
        ) : Icon ? (
          <Icon size={20} strokeWidth={1.75} color={colors[ink]} />
        ) : null}
        <AppText variant="body" weight={600} color={ink} style={{ flexShrink: 1 }}>
          {label}
        </AppText>
      </Pressable>
    </Animated.View>
  );
}
