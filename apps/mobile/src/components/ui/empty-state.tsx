import { HeroDecor } from '@/components/decor/hero-decor';
import { useTheme } from '@/lib/theme';
import { AppText } from './app-text';
import { Card } from './card';

export function EmptyState({ message }: { message: string }) {
  const { radius, space } = useTheme();
  return (
    <Card corner="xl" style={{ alignItems: 'center', paddingVertical: space[12] }}>
      <HeroDecor corner={radius.xl} />
      <AppText color="muted" style={{ textAlign: 'center' }}>
        {message}
      </AppText>
    </Card>
  );
}
