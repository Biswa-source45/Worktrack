import { useState } from 'react';
import { screen, waitFor, within } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { describe, expect, it, vi } from 'vitest';
import { apiError, mockApi, renderWithClient } from '@/test/render';
import { credentialsCsv } from './credentials-csv';
import { ImportDialog } from './import-dialog';

const WARNING =
  'This file contains temporary passwords. Delete the downloaded file after you have distributed the passwords. The passwords are shown only once, are not stored by the system and cannot be retrieved later.';

const credentials = [
  { emp_code: 'EMP-1', name: 'Asha Rao', temporary_password: 'Pw1abcdefghj' },
  { emp_code: 'EMP-2', name: 'Ravi, "Rocky" Kumar', temporary_password: 'Pw2abcdefghj' },
];
const dryRunOk = { dry_run: true, total_rows: 2, created: 0, errors: [], credentials: [] };
const dryRunBad = {
  dry_run: true,
  total_rows: 3,
  created: 0,
  errors: [
    { row: 3, message: 'mobile: Enter a valid mobile number' },
    { row: 4, message: 'role: unknown role' },
  ],
  credentials: [],
};
const committed = { dry_run: false, total_rows: 2, created: 2, errors: [], credentials };

const csvFile = () =>
  new File(['emp_code,name\nEMP-1,Asha\n'], 'employees.csv', { type: 'text/csv' });

function Harness() {
  const [open, setOpen] = useState(true);
  return open ? <ImportDialog onClose={() => setOpen(false)} /> : <p>closed</p>;
}

describe('ImportDialog', () => {
  it('offers the template download through the proxy', () => {
    mockApi({});
    renderWithClient(<ImportDialog onClose={() => {}} />);
    expect(screen.getByRole('link', { name: 'Download template' })).toHaveAttribute(
      'href',
      '/api/proxy/api/v1/admin/employees/import/template',
    );
  });

  it('runs a dry run on selection and lists errors with row numbers; import stays disabled', async () => {
    const calls = mockApi({ 'POST /api/proxy/api/v1/admin/employees/import': dryRunBad });
    renderWithClient(<ImportDialog onClose={() => {}} />);
    await userEvent.upload(screen.getByLabelText('File'), csvFile());

    const preview = await screen.findByRole('region', { name: 'Preview' });
    expect(within(preview).getByText('3 row(s) found.')).toBeInTheDocument();
    const rows = within(preview).getAllByRole('row').slice(1);
    expect(rows.map((r) => r.textContent)).toEqual([
      '3mobile: Enter a valid mobile number',
      '4role: unknown role',
    ]);
    expect(screen.getByRole('button', { name: /^Import \d+ employees$/ })).toBeDisabled();
    expect(calls).toHaveLength(1);
    expect(calls[0].search.get('dry_run')).toBe('true');
    expect((calls[0].body as FormData).get('file')).toBeInstanceOf(File);
    expect(screen.queryByText(WARNING)).not.toBeInTheDocument();
  });

  it('shows a server error for an unreadable file', async () => {
    mockApi({
      'POST /api/proxy/api/v1/admin/employees/import': () => apiError(422, 'INVALID_FILE'),
    });
    renderWithClient(<ImportDialog onClose={() => {}} />);
    await userEvent.upload(screen.getByLabelText('File'), csvFile());
    expect(await screen.findByRole('alert')).toHaveTextContent('could not be read');
  });

  it('imports after a clean dry run, then shows credentials with the warning', async () => {
    const calls = mockApi({
      'POST /api/proxy/api/v1/admin/employees/import': (call: { search: URLSearchParams }) =>
        call.search.get('dry_run') === 'true' ? dryRunOk : committed,
      'GET /admin/employees': { items: [], next_cursor: null },
    });
    const user = userEvent.setup();
    renderWithClient(<ImportDialog onClose={() => {}} />);
    await user.upload(screen.getByLabelText('File'), csvFile());

    expect(await screen.findByText(WARNING)).toBeInTheDocument();
    await user.click(await screen.findByRole('button', { name: 'Import 2 employees' }));

    expect(await screen.findByText('2 employee(s) imported.')).toBeInTheDocument();
    expect(calls.map((c) => c.search.get('dry_run')).filter(Boolean)).toEqual(['true', 'false']);
    expect(screen.getByText('Pw1abcdefghj')).toBeInTheDocument();
    expect(screen.getByText(WARNING)).toBeInTheDocument();
  });

  it('downloads a CSV of the credentials built in the browser', async () => {
    mockApi({
      'POST /api/proxy/api/v1/admin/employees/import': (call: { search: URLSearchParams }) =>
        call.search.get('dry_run') === 'true' ? dryRunOk : committed,
    });
    const createObjectURL = vi.fn(() => 'blob:test');
    const revokeObjectURL = vi.fn();
    // jsdom has no object URLs; patch them in for this test only.
    Object.assign(URL, { createObjectURL, revokeObjectURL });
    const click = vi.spyOn(HTMLAnchorElement.prototype, 'click').mockImplementation(() => {});

    const user = userEvent.setup();
    renderWithClient(<ImportDialog onClose={() => {}} />);
    await user.upload(screen.getByLabelText('File'), csvFile());
    await user.click(await screen.findByRole('button', { name: 'Import 2 employees' }));
    await user.click(await screen.findByRole('button', { name: 'Download CSV' }));

    expect(createObjectURL).toHaveBeenCalledTimes(1);
    const blob = (createObjectURL.mock.calls[0] as unknown as [Blob])[0];
    expect(blob.type).toBe('text/csv;charset=utf-8');
    expect(await blob.text()).toBe(
      'emp_code,name,temporary_password\r\n' +
        'EMP-1,Asha Rao,Pw1abcdefghj\r\n' +
        'EMP-2,"Ravi, ""Rocky"" Kumar",Pw2abcdefghj\r\n',
    );
    expect(click).toHaveBeenCalled();
    expect(revokeObjectURL).toHaveBeenCalledWith('blob:test');
    click.mockRestore();
    Reflect.deleteProperty(URL, 'createObjectURL');
    Reflect.deleteProperty(URL, 'revokeObjectURL');
  });

  it('drops the credentials when the dialog is closed', async () => {
    mockApi({
      'POST /api/proxy/api/v1/admin/employees/import': (call: { search: URLSearchParams }) =>
        call.search.get('dry_run') === 'true' ? dryRunOk : committed,
    });
    const user = userEvent.setup();
    const { client } = renderWithClient(<Harness />);
    await user.upload(screen.getByLabelText('File'), csvFile());
    await user.click(await screen.findByRole('button', { name: 'Import 2 employees' }));
    expect(await screen.findByText('Pw1abcdefghj')).toBeInTheDocument();
    expect(
      JSON.stringify(
        client
          .getQueryCache()
          .getAll()
          .map((q) => q.state.data),
      ),
    ).not.toContain('Pw1abcdefghj');

    await user.click(screen.getByRole('button', { name: 'Close' }));
    await waitFor(() => expect(screen.getByText('closed')).toBeInTheDocument());
    expect(document.body).not.toHaveTextContent('Pw1abcdefghj');
    expect(document.body).not.toHaveTextContent('Pw2abcdefghj');
  });
});

describe('credentialsCsv', () => {
  it('neutralises spreadsheet formulas in names and codes but keeps passwords verbatim', () => {
    const csv = credentialsCsv([
      { emp_code: '=1+1', name: '@SUM(A1)', temporary_password: 'Abc12345678x' },
      { emp_code: 'E3', name: '-cmd', temporary_password: 'Zz99999999yy' },
    ]);
    expect(csv).toBe(
      "emp_code,name,temporary_password\r\n'=1+1,'@SUM(A1),Abc12345678x\r\nE3,'-cmd,Zz99999999yy\r\n",
    );
  });
});
