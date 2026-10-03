import { ActivityIndicator, View } from 'react-native';

export default function LoadingScreen() {
  return (
    <View style={{ flex: 1, alignItems: 'center', justifyContent: 'center' }}>
      <ActivityIndicator />
    </View>
  );
}
