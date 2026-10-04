import type { ReactNode } from 'react';
import { Modal, ScrollView, StyleSheet, View } from 'react-native';
import { useTheme } from '@/lib/theme';
import { AppText } from './app-text';

type Props = {
  title: string;
  /** The Android back button; the dialog's own buttons close it otherwise. */
  onRequestClose: () => void;
  children: ReactNode;
};

/**
 * A centred modal card. It fades in (opacity only, so it needs no Reduce Motion branch) and a
 * tap on the dimmed area does not close it: a stray tap must not lose a one-time password.
 */
export function Dialog({ title, onRequestClose, children }: Props) {
  const { colors, radius, space, shadow } = useTheme();
  const lifted = shadow('lg');

  return (
    <Modal
      testID="dialog-modal"
      visible
      transparent
      statusBarTranslucent
      animationType="fade"
      onRequestClose={onRequestClose}
    >
      <View style={{ flex: 1, justifyContent: 'center', padding: space[5] }}>
        {/* The dimming uses the theme's shadow colour: black in dark, warm brown in light. */}
        <View
          pointerEvents="none"
          style={[StyleSheet.absoluteFill, { backgroundColor: lifted.shadowColor, opacity: 0.6 }]}
        />
        <View
          testID="dialog"
          accessibilityViewIsModal
          style={[
            {
              maxHeight: '100%',
              backgroundColor: colors.surface,
              borderColor: colors.border,
              borderWidth: 1,
              borderRadius: radius.lg,
            },
            lifted,
          ]}
        >
          {/* Scrolls when large text makes the content taller than the screen. */}
          <ScrollView contentContainerStyle={{ padding: space[5], gap: space[4] }}>
            <AppText variant="h3" accessibilityRole="header">
              {title}
            </AppText>
            {children}
          </ScrollView>
        </View>
      </View>
    </Modal>
  );
}
