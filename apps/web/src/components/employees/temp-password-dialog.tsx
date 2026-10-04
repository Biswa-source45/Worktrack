'use client';

import { useState } from 'react';
import { Check, Copy } from 'lucide-react';
import { useTranslation } from 'react-i18next';
import { AlertNote } from '@/components/alert-note';
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
        <AlertNote>{t('temporaryPassword.warning')}</AlertNote>
        <div className="flex items-center gap-2">
          <code
            aria-label={t('temporaryPassword.label')}
            className="flex-1 rounded-md bg-raised px-3 py-2 font-mono text-large select-all"
          >
            {value.password}
          </code>
          <Button variant="outline" onClick={() => void copy()}>
            {copied ? <Check aria-hidden="true" /> : <Copy aria-hidden="true" />}
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
