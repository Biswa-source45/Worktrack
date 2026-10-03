import { useState } from 'react';
import { useTranslation } from 'react-i18next';
import { ActivityIndicator, Button, ScrollView, Text, View } from 'react-native';
import { useAuth } from '@/lib/auth';

export default function HomeScreen() {
  const { t } = useTranslation();
  const { me, meError, refetchMe, signOut } = useAuth();
  const [checking, setChecking] = useState(false);

  async function checkAgain() {
    setChecking(true);
    try {
      await refetchMe();
    } finally {
      setChecking(false);
    }
  }

  if (!me) {
    return (
      <View style={{ flex: 1, justifyContent: 'center', gap: 12, padding: 24 }}>
        {meError ? <Text>{t('home.loadFailed')}</Text> : <ActivityIndicator />}
        <Button title={t('home.retry')} onPress={() => void checkAgain()} disabled={checking} />
        <Button title={t('home.signOut')} onPress={() => void signOut()} />
      </View>
    );
  }

  const rows: [string, string][] = [
    [t('home.employeeCode'), me.emp_code],
    [t('home.designation'), me.designation.name],
    [t('home.role'), me.role.name],
    [t('home.department'), me.department?.name ?? t('home.noDepartment')],
  ];

  return (
    <ScrollView
      contentContainerStyle={{ flexGrow: 1, justifyContent: 'center', gap: 16, padding: 24 }}
    >
      <Text accessibilityRole="header" style={{ fontSize: 28, fontWeight: '600' }}>
        {me.name}
      </Text>
      {me.device?.status === 'pending' ? (
        <View
          accessibilityRole="alert"
          style={{ backgroundColor: '#fff3cd', padding: 12, borderRadius: 6, gap: 8 }}
        >
          <Text style={{ fontWeight: '600' }}>{t('home.devicePending')}</Text>
          <Button
            title={t('home.checkAgain')}
            onPress={() => void checkAgain()}
            disabled={checking}
          />
        </View>
      ) : null}
      {me.device?.status === 'revoked' ? (
        <View
          accessibilityRole="alert"
          style={{ backgroundColor: '#f8d7da', padding: 12, borderRadius: 6 }}
        >
          <Text style={{ fontWeight: '600' }}>{t('home.deviceRevoked')}</Text>
        </View>
      ) : null}
      {rows.map(([label, value]) => (
        <View key={label}>
          <Text style={{ color: '#666' }}>{label}</Text>
          <Text style={{ fontSize: 18 }}>{value}</Text>
        </View>
      ))}
      <Button title={t('home.signOut')} onPress={() => void signOut()} />
    </ScrollView>
  );
}
