import { View } from 'react-native';
import Svg, { Circle, Path } from 'react-native-svg';
import { useTheme } from '@/lib/theme';

const DOT_COLUMNS = [0, 1, 2, 3, 4, 5];
const DOT_ROWS = [0, 1, 2, 3];

/**
 * Backdrop for heroes, headers and calm states: a soft blob, half circles at the edges and a
 * small dot grid. Fills its parent; never put it behind a form or dense data.
 * `corner` is the parent's radius: clipping here keeps the parent's own shadow, which
 * `overflow: hidden` on the parent would cut off on iOS.
 */
export function HeroDecor({ corner = 0 }: { corner?: number }) {
  const { colors } = useTheme();
  return (
    <View
      pointerEvents="none"
      accessibilityElementsHidden
      importantForAccessibility="no-hide-descendants"
      style={{
        position: 'absolute',
        top: 0,
        right: 0,
        bottom: 0,
        left: 0,
        overflow: 'hidden',
        borderRadius: corner,
      }}
    >
      <Svg width="100%" height="100%" viewBox="0 0 400 300" preserveAspectRatio="xMaxYMin slice">
        <Path
          d="M300 -30 C370 -40 440 10 430 80 C422 138 368 168 318 150 C262 130 222 84 240 30 C250 0 272 -24 300 -30 Z"
          fill={colors.primary}
          fillOpacity={0.14}
        />
        <Circle cx={400} cy={210} r={64} fill={colors.raised} fillOpacity={0.7} />
        <Circle
          cx={0}
          cy={40}
          r={46}
          fill="none"
          stroke={colors.primary}
          strokeOpacity={0.3}
          strokeWidth={1.5}
        />
        {DOT_ROWS.map((row) =>
          DOT_COLUMNS.map((column) => (
            <Circle
              key={`${row}-${column}`}
              cx={36 + column * 16}
              cy={150 + row * 16}
              r={1.5}
              fill={colors.borderStrong}
              fillOpacity={0.5}
            />
          )),
        )}
      </Svg>
    </View>
  );
}
