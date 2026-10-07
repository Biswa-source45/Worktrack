import { Image } from 'react-native';
import { useTranslation } from 'react-i18next';
import compactDark from '../../assets/brand/logo-compact-dark.png';
import compactLight from '../../assets/brand/logo-compact-light.png';
import { useTheme } from '@/lib/theme';

// The compact logo (mark + wordmark, no tagline), one file per theme: a logo with dark text never
// goes on a dark surface. Width / height of each file, for the aspect ratio.
const LOGOS = {
  light: { source: compactLight, ratio: 480 / 96 },
  dark: { source: compactDark, ratio: 480 / 94 },
} as const;

/** The WorkTrack logo for the current theme, `width` points wide. For sign-in screens only. */
export function BrandLogo({ width }: { width: number }) {
  const { t } = useTranslation();
  const { scheme } = useTheme();
  const { source, ratio } = LOGOS[scheme];
  return (
    <Image
      source={source}
      accessible
      accessibilityRole="image"
      accessibilityLabel={t('app.title')}
      resizeMode="contain"
      style={{ width, height: width / ratio }}
    />
  );
}
