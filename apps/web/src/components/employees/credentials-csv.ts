import type { Schemas } from '@/lib/api-client';

type Credential = Schemas['ImportCredential'];

// Spreadsheet apps run cells that start with these characters as formulas.
const FORMULA_START = /^[=+\-@\t\r]/;

function cell(value: string, guardFormula: boolean) {
  const safe = guardFormula && FORMULA_START.test(value) ? `'${value}` : value;
  return /[",\r\n]/.test(safe) ? `"${safe.replaceAll('"', '""')}"` : safe;
}

// Passwords are written verbatim: a quote prefix would corrupt them (the generated alphabet has
// no formula characters).
export function credentialsCsv(credentials: Credential[]): string {
  const rows = credentials.map((c) =>
    [cell(c.emp_code, true), cell(c.name, true), cell(c.temporary_password, false)].join(','),
  );
  return ['emp_code,name,temporary_password', ...rows].join('\r\n') + '\r\n';
}

export function downloadCsv(filename: string, csv: string) {
  const url = URL.createObjectURL(new Blob([csv], { type: 'text/csv;charset=utf-8' }));
  const link = document.createElement('a');
  link.href = url;
  link.download = filename;
  link.click();
  URL.revokeObjectURL(url);
}
