import type { ReactNode } from 'react';
import { useTranslation } from 'react-i18next';
import { KeyboardAvoidingView, ScrollView, View } from 'react-native';
import { SafeAreaView } from 'react-native-safe-area-context';
import { CurvedEdge } from '@/components/decor/curved-edge';
import { HeroDecor } from '@/components/decor/hero-decor';
import { AppText } from '@/components/ui/app-text';
import { useTheme } from '@/lib/theme';

type Props = {
  title: string;
  intro?: string;
  /** The form fields and inline errors. */
  children: ReactNode;
  /** The submit button and anything under it; kept at the bottom, in reach of the thumb. */
  footer: ReactNode;
};

/** Signed-out layout: a decorated hero with the product name over a curved panel with a form. */
export function AuthShell({ title, intro, children, footer }: Props) {
  const { t } = useTranslation();
  const { colors, space } = useTheme();

  return (
    // Padding on both platforms: Android draws edge to edge, so the window does not resize for
    // the keyboard on its own.
    <KeyboardAvoidingView behavior="padding" style={{ flex: 1, backgroundColor: colors.surface }}>
      <ScrollView
        bounces={false}
        contentContainerStyle={{ flexGrow: 1 }}
        keyboardShouldPersistTaps="handled"
      >
        <SafeAreaView
          edges={['top', 'left', 'right']}
          style={{ backgroundColor: colors.background }}
        >
          <HeroDecor />
          <View
            style={{
              gap: space[1],
              paddingHorizontal: space[5],
              paddingTop: space[12],
              paddingBottom: space[12],
            }}
          >
            <AppText variant="h1">{t('app.title')}</AppText>
            <AppText color="muted">{t('app.tagline')}</AppText>
          </View>
          <CurvedEdge />
        </SafeAreaView>
        <SafeAreaView
          edges={['bottom', 'left', 'right']}
          style={{
            flexGrow: 1,
            gap: space[4],
            padding: space[5],
            backgroundColor: colors.surface,
          }}
        >
          <View style={{ gap: space[1] }}>
            <AppText variant="h2" accessibilityRole="header">
              {title}
            </AppText>
            {intro ? <AppText color="muted">{intro}</AppText> : null}
          </View>
          {children}
          <View style={{ flexGrow: 1, justifyContent: 'flex-end', gap: space[3] }}>{footer}</View>
        </SafeAreaView>
      </ScrollView>
    </KeyboardAvoidingView>
  );
}
