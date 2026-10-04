import { View } from 'react-native';
import Svg, { Path } from 'react-native-svg';
import { useTheme } from '@/lib/theme';

const HEIGHT = 28;

/** The rounded top edge of a surface panel; sits at the bottom of the area above the panel. */
export function CurvedEdge() {
  const { colors } = useTheme();
  return (
    <View
      pointerEvents="none"
      accessibilityElementsHidden
      importantForAccessibility="no-hide-descendants"
      // 1px lower than the edge so no hairline shows between the curve and the panel.
      style={{ position: 'absolute', right: 0, bottom: -1, left: 0, height: HEIGHT }}
    >
      <Svg width="100%" height={HEIGHT} viewBox="0 0 400 28" preserveAspectRatio="none">
        <Path d="M0 28 C90 0 310 0 400 28 Z" fill={colors.surface} />
      </Svg>
    </View>
  );
}
