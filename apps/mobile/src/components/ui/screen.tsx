import type { ReactNode } from 'react';
import { ScrollView } from 'react-native';
import type { ViewStyle } from 'react-native';
import { SafeAreaView } from 'react-native-safe-area-context';
import type { Edge } from 'react-native-safe-area-context';
import { useTheme } from '@/lib/theme';

type Props = {
  children: ReactNode;
  scroll?: boolean;
  /** Tab screens pass only `top`: the tab bar already covers the bottom inset. */
  edges?: readonly Edge[];
  contentStyle?: ViewStyle;
};

const ALL: readonly Edge[] = ['top', 'bottom', 'left', 'right'];

export function Screen({ children, scroll = false, edges = ALL, contentStyle }: Props) {
  const { colors, space } = useTheme();
  const content: ViewStyle = { flexGrow: 1, padding: space[5], gap: space[4], ...contentStyle };
  const frame: ViewStyle = { flex: 1, backgroundColor: colors.background };

  if (!scroll) {
    return (
      <SafeAreaView edges={edges} style={[frame, content]}>
        {children}
      </SafeAreaView>
    );
  }
  return (
    <SafeAreaView edges={edges} style={frame}>
      <ScrollView contentContainerStyle={content} keyboardShouldPersistTaps="handled">
        {children}
      </ScrollView>
    </SafeAreaView>
  );
}
