'use client';

import { useState } from 'react';
import { useTranslation } from 'react-i18next';
import { Button } from '@/components/ui/button';
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogTitle,
} from '@/components/ui/dialog';
import type { TemporaryPassword } from './employee-dialog';

// The password only ever lives in this component's props and state; closing unmounts it.
export function TemporaryPasswordDialog({
  value,
  onClose,
}: {
  value: TemporaryPassword;
  onClose: () => void;
}) {
  const { t } = useTranslation();
  const [copied, setCopied] = useState(false);

  async function copy() {
    await navigator.clipboard.writeText(value.password);
    setCopied(true);
  }

  return (
    <Dialog open onOpenChange={(open) => !open && onClose()}>
      <DialogContent>
        <DialogTitle>{t('temporaryPassword.title')}</DialogTitle>
        <DialogDescription>
          {value.name} ({value.empCode})
        </DialogDescription>
        <p
          role="alert"
          className="rounded-lg border border-destructive/40 bg-destructive/10 p-3 text-sm"
        >
          {t('temporaryPassword.warning')}
        </p>
        <div className="flex items-center gap-2">
          <code
            aria-label={t('temporaryPassword.label')}
            className="flex-1 rounded-lg bg-muted px-3 py-2 font-mono text-base select-all"
          >
            {value.password}
          </code>
          <Button variant="outline" onClick={() => void copy()}>
            {copied ? t('temporaryPassword.copied') : t('temporaryPassword.copy')}
          </Button>
        </div>
        <DialogFooter>
          <Button onClick={onClose}>{t('common.close')}</Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
}
