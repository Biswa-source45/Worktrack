import { Text, TextInput, View } from 'react-native';
import type { TextInputProps } from 'react-native';

type Props = TextInputProps & { label: string; error?: string };

export function FormField({ label, error, ...input }: Props) {
  return (
    <View style={{ gap: 4 }}>
      <Text style={{ fontWeight: '500' }}>{label}</Text>
      <TextInput
        accessibilityLabel={label}
        autoCapitalize="none"
        autoCorrect={false}
        style={{ borderWidth: 1, borderColor: '#999', borderRadius: 6, padding: 10, fontSize: 16 }}
        {...input}
      />
      {error ? <Text style={{ color: '#b00020' }}>{error}</Text> : null}
    </View>
  );
}
