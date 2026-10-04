import type { ReactNode } from 'react';
import { useTranslation } from 'react-i18next';
import { Label } from '@/components/ui/label';

type Props = { id: string; label: string; error?: string; children: ReactNode };

// `error` is an i18n key (zod messages are keys). The control sets `invalid` to link to it.
export function Field({ id, label, error, children }: Props) {
  const { t } = useTranslation();
  return (
    <div className="grid content-start gap-1.5">
      <Label htmlFor={id}>{label}</Label>
      {children}
      {error && (
        <p id={`${id}-error`} role="alert" className="text-caption text-danger">
          {t(error)}
        </p>
      )}
    </div>
  );
}
