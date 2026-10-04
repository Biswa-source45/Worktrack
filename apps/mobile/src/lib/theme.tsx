import {
  minTouchTarget,
  motion,
  colors as palette,
  radius,
  shadow as shadows,
  spacing,
  typography,
} from 'design-tokens';
import type { Colors, ThemeName, TypeToken } from 'design-tokens';
import * as SecureStore from 'expo-secure-store';
import { StatusBar } from 'expo-status-bar';
import * as SystemUI from 'expo-system-ui';
import {
  createContext,
  useCallback,
  useContext,
  useEffect,
  useMemo,
  useRef,
  useState,
} from 'react';
import type { ReactNode } from 'react';
import { Animated, Easing, useColorScheme } from 'react-native';
import type { TextStyle, ViewStyle } from 'react-native';
import { FAMILY } from './fonts';
import type { FontWeight } from './fonts';
import { useReducedMotion } from './reduced-motion';

export type ThemeChoice = ThemeName | 'system';
export type ColorRole = keyof Colors;
export type ShadowLevel = 'sm' | 'md' | 'lg';

export const THEME_KEY = 'worktrack.theme';
const CHOICES: readonly string[] = ['light', 'dark', 'system'];

const [s4, s8, s12, s16, s20, s24, s32, s40, s48, s64] = spacing;
/** The token spacing scale, keyed by multiples of the 4px base (`space[4]` is 16). */
export const space = {
  1: s4,
  2: s8,
  3: s12,
  4: s16,
  5: s20,
  6: s24,
  8: s32,
  10: s40,
  12: s48,
  16: s64,
} as const;

/** The one ease-out curve of the design system. */
export const easeOut = Easing.bezier(...motion.easeOut);

// Android has no blur/offset shadow, only elevation; these levels look closest to the tokens.
const ELEVATION: Record<ShadowLevel, number> = { sm: 1, md: 4, lg: 12 };

type Theme = {
  choice: ThemeChoice;
  scheme: ThemeName;
  colors: Colors;
  setChoice: (choice: ThemeChoice) => void;
  /** False until the stored choice has been read. */
  ready: boolean;
  radius: typeof radius;
  space: typeof space;
  motion: typeof motion;
  minTouchTarget: number;
  /** Size, line height and font for a type token; components never name a family or size. */
  text: (variant: TypeToken, weight?: FontWeight) => TextStyle;
  shadow: (level: ShadowLevel) => ViewStyle;
};

const ThemeContext = createContext<Theme | null>(null);

type Props = {
  children: ReactNode;
  /** False while Plus Jakarta Sans is not available: text then uses the system font. */
  fontsLoaded?: boolean;
};

export function ThemeProvider({ children, fontsLoaded = false }: Props) {
  const system = useColorScheme();
  const reduced = useReducedMotion();
  const [choice, setChoiceState] = useState<ThemeChoice>('system');
  const [ready, setReady] = useState(false);
  const [fade] = useState(() => new Animated.Value(1));
  const painted = useRef<ThemeName | null>(null);

  useEffect(() => {
    SecureStore.getItemAsync(THEME_KEY)
      .then((stored) => {
        if (stored && CHOICES.includes(stored)) setChoiceState(stored as ThemeChoice);
      })
      .catch(() => {
        // Unreadable store: stay on System; the choice is cosmetic and must not block the app.
      })
      .finally(() => setReady(true));
  }, []);

  const setChoice = useCallback((next: ThemeChoice) => {
    setChoiceState(next);
    SecureStore.setItemAsync(THEME_KEY, next).catch(() => {
      // Not saved: the choice still applies until the app restarts.
    });
  }, []);

  const scheme: ThemeName = choice === 'system' ? (system === 'dark' ? 'dark' : 'light') : choice;
  const colors = palette[scheme];

  useEffect(() => {
    // The native root view shows behind screens during transitions and overscroll.
    SystemUI.setBackgroundColorAsync(colors.background).catch(() => {
      // Cosmetic only.
    });
    const changed = painted.current !== null && painted.current !== scheme;
    painted.current = scheme;
    if (!changed || reduced) return;
    fade.setValue(0);
    Animated.timing(fade, {
      toValue: 1,
      duration: motion.base,
      easing: easeOut,
      useNativeDriver: true,
    }).start();
  }, [scheme, colors.background, reduced, fade]);

  const value = useMemo<Theme>(() => {
    const tokens = shadows[scheme];
    return {
      choice,
      scheme,
      colors,
      setChoice,
      ready,
      radius,
      space,
      motion,
      minTouchTarget,
      text: (variant, weight) => {
        const { size, line, weight: base } = typography.mobile[variant];
        const resolved = weight ?? base;
        return {
          fontSize: size,
          lineHeight: line,
          ...(fontsLoaded
            ? { fontFamily: FAMILY[resolved] }
            : { fontWeight: `${resolved}` as const }),
        };
      },
      shadow: (level) => ({
        shadowColor: tokens.color,
        shadowOffset: { width: 0, height: tokens[level].y },
        shadowOpacity: tokens[level].alpha,
        // iOS shadowRadius is roughly half a CSS blur radius.
        shadowRadius: tokens[level].blur / 2,
        elevation: ELEVATION[level],
      }),
    };
  }, [choice, scheme, colors, setChoice, ready, fontsLoaded]);

  return (
    <ThemeContext.Provider value={value}>
      <StatusBar style={scheme === 'dark' ? 'light' : 'dark'} />
      <Animated.View style={{ flex: 1, opacity: fade, backgroundColor: colors.background }}>
        {children}
      </Animated.View>
    </ThemeContext.Provider>
  );
}

export function useTheme(): Theme {
  const value = useContext(ThemeContext);
  if (!value) throw new Error('useTheme must be used inside ThemeProvider');
  return value;
}
