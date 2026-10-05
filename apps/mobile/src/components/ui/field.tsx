import { TriangleAlert } from '@/components/icons';
import { useState } from 'react';
import type { ReactNode } from 'react';
import { TextInput, View } from 'react-native';
import type { TextInputProps } from 'react-native';
import { useTheme } from '@/lib/theme';
import { AppText } from './app-text';

export type FieldProps = TextInputProps & {
  label: string;
  error?: string;
  /** A control inside the input frame, after the text (the password eye). */
  trailing?: ReactNode;
};

export function Field({ label, error, trailing, onFocus, onBlur, ...input }: FieldProps) {
  const { colors, radius, space, text, minTouchTarget } = useTheme();
  const [focused, setFocused] = useState(false);
  const edge = error ? colors.dangerFg : focused ? colors.ring : colors.borderStrong;
  // The body font without its lineHeight: on iOS a lineHeight pushes single-line input text off
  // centre. The key is left out, never set to undefined: Android's TextInput turns an undefined
  // lineHeight into 0, and once something is typed the text is measured with no height at all.
  const { lineHeight: _lineHeight, ...font } = text('body');

  return (
    <View style={{ gap: space[1] }}>
      <AppText variant="small" weight={500}>
        {label}
      </AppText>
      <View
        style={{
          flexDirection: 'row',
          alignItems: 'center',
          minHeight: minTouchTarget + space[1],
          borderWidth: 1.5,
          borderColor: edge,
          borderRadius: radius.md,
          backgroundColor: colors.raised,
        }}
      >
        <TextInput
          accessibilityLabel={label}
          autoCapitalize="none"
          autoCorrect={false}
          placeholderTextColor={colors.muted}
          selectionColor={colors.primary}
          style={[font, { flex: 1, color: colors.text, padding: space[3] }]}
          onFocus={(event) => {
            setFocused(true);
            onFocus?.(event);
          }}
          onBlur={(event) => {
            setFocused(false);
            onBlur?.(event);
          }}
          {...input}
        />
        {trailing}
      </View>
      {error ? (
        <View style={{ flexDirection: 'row', alignItems: 'flex-start', gap: space[1] }}>
          <TriangleAlert size={16} strokeWidth={1.75} color={colors.dangerFg} />
          <AppText accessibilityRole="alert" variant="small" color="dangerFg" style={{ flex: 1 }}>
            {error}
          </AppText>
        </View>
      ) : null}
    </View>
  );
}
