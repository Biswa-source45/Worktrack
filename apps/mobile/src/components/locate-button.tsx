import { CircleX, MapPin } from '@/components/icons';
import { useState } from 'react';
import { useTranslation } from 'react-i18next';
import { Banner } from '@/components/ui/banner';
import { Button } from '@/components/ui/button';
import { LocationError, getCurrentFix } from '@/lib/location';
import type { Fix } from '@/lib/location';

/** The phone's position on request. The fix lives only in this state; `clear` drops it. */
export function useCurrentFix() {
  const { t } = useTranslation();
  const [fix, setFix] = useState<Fix | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [locating, setLocating] = useState(false);

  async function locate() {
    setLocating(true);
    setError(null);
    try {
      setFix(await getCurrentFix());
    } catch (failure) {
      const code = failure instanceof LocationError ? failure.code : 'unavailable';
      setError(t(`location.errors.${code}`));
    } finally {
      setLocating(false);
    }
  }

  return { fix, error, locating, locate, clear: () => setFix(null) };
}

type Props = {
  state: ReturnType<typeof useCurrentFix>;
  label: string;
  variant?: 'primary' | 'secondary';
};

/** The button that asks for the position, with the reason above it when that failed. */
export function LocateButton({ state, label, variant = 'primary' }: Props) {
  return (
    <>
      {state.error ? <Banner status="danger" icon={CircleX} message={state.error} /> : null}
      <Button
        variant={variant}
        icon={MapPin}
        label={label}
        onPress={() => void state.locate()}
        loading={state.locating}
      />
    </>
  );
}
