import { AppText } from '@/components/ui/app-text';

/** One compact "label value" line of a list row; wraps instead of clipping at large text sizes. */
export function Meta({ label, value }: { label: string; value: string }) {
  return (
    <AppText variant="small" color="muted">
      {label}{' '}
      <AppText variant="small" weight={500}>
        {value}
      </AppText>
    </AppText>
  );
}
