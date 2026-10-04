import { CircleX, TriangleAlert } from '@/components/icons';
import { useState } from 'react';
import { useTranslation } from 'react-i18next';
import { errorText } from '@/lib/api-error';
import { AppText } from './app-text';
import { Banner } from './banner';
import { Button } from './button';
import { Dialog } from './dialog';

type Props = {
  title: string;
  message: string;
  /** A consequence the admin must not miss, shown as a warning. */
  notice?: string;
  confirmLabel: string;
  destructive?: boolean;
  onConfirm: () => Promise<void>;
  onClose: () => void;
};

// Closes itself on success; a failure stays in the dialog so it can be read and retried.
export function ConfirmDialog({
  title,
  message,
  notice,
  confirmLabel,
  destructive = false,
  onConfirm,
  onClose,
}: Props) {
  const { t } = useTranslation();
  const [pending, setPending] = useState(false);
  const [error, setError] = useState<string | null>(null);

  async function confirm() {
    setPending(true);
    setError(null);
    try {
      await onConfirm();
      onClose();
    } catch (failure) {
      setError(errorText(t, failure));
      setPending(false);
    }
  }

  return (
    <Dialog title={title} onRequestClose={() => (pending ? undefined : onClose())}>
      <AppText>{message}</AppText>
      {notice ? <Banner status="warning" icon={TriangleAlert} message={notice} /> : null}
      {error ? <Banner status="danger" icon={CircleX} message={error} /> : null}
      <Button
        variant={destructive ? 'destructive' : 'primary'}
        label={confirmLabel}
        onPress={() => void confirm()}
        loading={pending}
      />
      <Button variant="ghost" label={t('common.cancel')} onPress={onClose} disabled={pending} />
    </Dialog>
  );
}
