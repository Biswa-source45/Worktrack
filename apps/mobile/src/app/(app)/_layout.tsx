import { Tabs } from 'expo-router/js-tabs';
import type { BottomTabBarProps } from 'expo-router/js-tabs';
import { House, ShieldCheck, UserRound } from '@/components/icons';
import type { LucideIcon } from 'lucide-react-native';
import { useTranslation } from 'react-i18next';
import { Pressable, View } from 'react-native';
import { SafeAreaView } from 'react-native-safe-area-context';
import { AppText } from '@/components/ui/app-text';
import { can, useAuth } from '@/lib/auth';
import { useTheme } from '@/lib/theme';

const ICONS: Record<string, LucideIcon> = {
  index: House,
  profile: UserRound,
  admin: ShieldCheck,
};

function TabBar({ state, descriptors, navigation }: BottomTabBarProps) {
  const { colors, radius, space, minTouchTarget } = useTheme();

  return (
    <SafeAreaView
      edges={['bottom', 'left', 'right']}
      style={{
        flexDirection: 'row',
        backgroundColor: colors.surface,
        borderTopWidth: 1,
        borderTopColor: colors.border,
      }}
    >
      {state.routes.map((route, index) => {
        const { title, tabBarAccessibilityLabel } = descriptors[route.key].options;
        const focused = state.index === index;
        const ink = focused ? 'primaryText' : 'muted';
        const Icon = ICONS[route.name];

        function onPress() {
          const event = navigation.emit({
            type: 'tabPress',
            target: route.key,
            canPreventDefault: true,
          });
          if (!focused && !event.defaultPrevented) navigation.navigate(route.name, route.params);
        }

        return (
          <Pressable
            key={route.key}
            accessibilityRole="tab"
            accessibilityLabel={tabBarAccessibilityLabel}
            accessibilityState={{ selected: focused }}
            onPress={onPress}
            style={{
              flex: 1,
              minHeight: minTouchTarget,
              alignItems: 'center',
              gap: space[1],
              paddingBottom: space[2],
            }}
          >
            {/* The pill marks the active tab by shape, so it does not rely on colour alone. */}
            <View
              style={{
                width: space[8],
                height: 3,
                borderRadius: radius.pill,
                marginBottom: space[1],
                backgroundColor: focused ? colors.primary : 'transparent',
              }}
            />
            <Icon size={24} strokeWidth={1.75} color={colors[ink]} />
            <AppText
              variant="caption"
              weight={focused ? 600 : 500}
              color={ink}
              style={{ textAlign: 'center' }}
            >
              {title}
            </AppText>
          </Pressable>
        );
      })}
    </SafeAreaView>
  );
}

export default function AppLayout() {
  const { t } = useTranslation();
  const { colors } = useTheme();
  const { me } = useAuth();
  const admin = can(me, 'devices.manage') || can(me, 'employees.manage');

  return (
    <Tabs
      tabBar={(props) => <TabBar {...props} />}
      screenOptions={{ headerShown: false, sceneStyle: { backgroundColor: colors.background } }}
    >
      <Tabs.Screen
        name="index"
        options={{ title: t('tabs.home'), tabBarAccessibilityLabel: t('tabs.home') }}
      />
      <Tabs.Screen
        name="profile"
        options={{ title: t('tabs.profile'), tabBarAccessibilityLabel: t('tabs.profile') }}
      />
      {/* Without the permission the tab is not built at all, and its route leads back to Home. */}
      <Tabs.Protected guard={admin}>
        <Tabs.Screen
          name="admin"
          options={{ title: t('tabs.admin'), tabBarAccessibilityLabel: t('tabs.admin') }}
        />
      </Tabs.Protected>
    </Tabs>
  );
}
