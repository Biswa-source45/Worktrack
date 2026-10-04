'use client';

import { useState, type ChangeEvent } from 'react';
import { useQueryClient } from '@tanstack/react-query';
import { CircleCheck, Download } from 'lucide-react';
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
import { Input } from '@/components/ui/input';
import { Label } from '@/components/ui/label';
import {
  Table,
  TableBody,
  TableCell,
  TableHead,
  TableHeader,
  TableRow,
} from '@/components/ui/table';
import { errorMessage, toApiError, type Schemas } from '@/lib/api-client';
import { credentialsCsv, downloadCsv } from './credentials-csv';

type ImportResult = Schemas['ImportResult'];

const IMPORT_URL = '/api/proxy/api/v1/admin/employees/import';
const TEMPLATE_URL = `${IMPORT_URL}/template`;

async function upload(file: File, dryRun: boolean): Promise<ImportResult> {
  const form = new FormData();
  form.append('file', file);
  const response = await fetch(`${IMPORT_URL}?dry_run=${dryRun}`, { method: 'POST', body: form });
  const body: unknown = await response.json().catch(() => null);
  if (!response.ok) throw toApiError(response.status, body);
  return body as ImportResult;
}

function PasswordWarning() {
  const { t } = useTranslation();
  return <AlertNote>{t('import.passwordWarning')}</AlertNote>;
}

// Credentials exist only in this component's state; closing the dialog unmounts and drops them.
export function ImportDialog({ onClose }: { onClose: () => void }) {
  const { t } = useTranslation();
  const queryClient = useQueryClient();
  const [file, setFile] = useState<File | null>(null);
  const [preview, setPreview] = useState<ImportResult | null>(null);
  const [done, setDone] = useState<ImportResult | null>(null);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);

  async function run(next: File, dryRun: boolean) {
    setBusy(true);
    setError(null);
    try {
      const result = await upload(next, dryRun);
      if (dryRun) {
        setPreview(result);
      } else {
        setDone(result);
        await queryClient.invalidateQueries({ queryKey: ['employees'] });
      }
    } catch (err) {
      setError(errorMessage(t, err));
    } finally {
      setBusy(false);
    }
  }

  function choose(event: ChangeEvent<HTMLInputElement>) {
    const chosen = event.target.files?.[0] ?? null;
    setFile(chosen);
    setPreview(null);
    if (chosen) void run(chosen, true);
  }

  const canImport = file && preview && preview.errors.length === 0 && preview.total_rows > 0;

  return (
    <Dialog open onOpenChange={(open) => !open && onClose()}>
      <DialogContent className="max-w-2xl">
        <DialogTitle>{t('import.title')}</DialogTitle>
        <DialogDescription>{t('import.description')}</DialogDescription>

        {done ? (
          <>
            <p className="flex items-center gap-2 font-medium text-success">
              <CircleCheck aria-hidden="true" className="size-5 shrink-0" />
              <span>{t('import.created', { count: done.created })}</span>
            </p>
            <PasswordWarning />
            <Table>
              <TableHeader>
                <TableRow>
                  <TableHead>{t('employees.col.code')}</TableHead>
                  <TableHead>{t('employees.col.name')}</TableHead>
                  <TableHead>{t('import.temporaryPassword')}</TableHead>
                </TableRow>
              </TableHeader>
              <TableBody>
                {done.credentials.map((c) => (
                  <TableRow key={c.emp_code}>
                    <TableCell>{c.emp_code}</TableCell>
                    <TableCell>{c.name}</TableCell>
                    <TableCell className="font-mono">{c.temporary_password}</TableCell>
                  </TableRow>
                ))}
              </TableBody>
            </Table>
            <DialogFooter>
              <Button
                variant="outline"
                onClick={() =>
                  downloadCsv('employee-credentials.csv', credentialsCsv(done.credentials))
                }
              >
                <Download aria-hidden="true" />
                {t('import.downloadCsv')}
              </Button>
              <Button onClick={onClose}>{t('common.close')}</Button>
            </DialogFooter>
          </>
        ) : (
          <>
            <a
              href={TEMPLATE_URL}
              download
              className="inline-flex items-center gap-1.5 justify-self-start rounded-sm text-small font-medium text-primary-text underline underline-offset-4"
            >
              <Download aria-hidden="true" className="size-4" />
              {t('import.downloadTemplate')}
            </a>
            <div className="grid gap-1.5">
              <Label htmlFor="import-file">{t('import.file')}</Label>
              <Input
                id="import-file"
                type="file"
                accept=".xlsx,.csv"
                onChange={choose}
                disabled={busy}
              />
            </div>
            {error && (
              <p role="alert" className="text-small text-danger">
                {error}
              </p>
            )}
            {preview && (
              <section aria-label={t('import.preview')} className="grid gap-3">
                <p>{t('import.totalRows', { count: preview.total_rows })}</p>
                {preview.errors.length > 0 && (
                  <Table>
                    <TableHeader>
                      <TableRow>
                        <TableHead>{t('import.row')}</TableHead>
                        <TableHead>{t('import.problem')}</TableHead>
                      </TableRow>
                    </TableHeader>
                    <TableBody>
                      {preview.errors.map((e, index) => (
                        <TableRow key={`${e.row}-${index}`}>
                          <TableCell>{e.row}</TableCell>
                          <TableCell className="whitespace-normal">{e.message}</TableCell>
                        </TableRow>
                      ))}
                    </TableBody>
                  </Table>
                )}
                {canImport && <PasswordWarning />}
              </section>
            )}
            <DialogFooter>
              <Button variant="outline" onClick={onClose}>
                {t('common.cancel')}
              </Button>
              <Button disabled={!canImport || busy} onClick={() => file && void run(file, false)}>
                {t('import.confirm', { count: preview?.total_rows ?? 0 })}
              </Button>
            </DialogFooter>
          </>
        )}
      </DialogContent>
    </Dialog>
  );
}
