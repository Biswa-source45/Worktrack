import { View } from 'react-native';
import { AppText } from './app-text';

export function DetailRow({ label, value }: { label: string; value: string }) {
  return (
    <View>
      <AppText variant="small" color="muted">
        {label}
      </AppText>
      <AppText variant="body" weight={500}>
        {value}
      </AppText>
    </View>
  );
}
