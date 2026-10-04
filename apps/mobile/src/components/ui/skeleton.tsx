import { useEffect, useState } from 'react';
import { Animated } from 'react-native';
import type { DimensionValue } from 'react-native';
import { useReducedMotion } from '@/lib/reduced-motion';
import { useTheme } from '@/lib/theme';

type Props = { width?: DimensionValue; height?: number; accessibilityLabel?: string };

export function Skeleton({ width = '100%', height = 16, accessibilityLabel }: Props) {
  const { colors, radius, motion } = useTheme();
  const reduced = useReducedMotion();
  const [opacity] = useState(() => new Animated.Value(1));

  useEffect(() => {
    // Reduce Motion: a still placeholder, no pulsing.
    if (reduced) return;
    const half = { duration: motion.slow * 3, useNativeDriver: true };
    const pulse = Animated.loop(
      Animated.sequence([
        Animated.timing(opacity, { toValue: 0.45, ...half }),
        Animated.timing(opacity, { toValue: 1, ...half }),
      ]),
    );
    pulse.start();
    return () => {
      pulse.stop();
      opacity.setValue(1);
    };
  }, [reduced, opacity, motion.slow]);

  return (
    <Animated.View
      accessible={accessibilityLabel !== undefined}
      accessibilityRole={accessibilityLabel ? 'progressbar' : undefined}
      accessibilityLabel={accessibilityLabel}
      style={{ width, height, opacity, borderRadius: radius.sm, backgroundColor: colors.raised }}
    />
  );
}
