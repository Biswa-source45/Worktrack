import { act, fireEvent, screen, waitFor, within } from '@testing-library/react-native';
import { DevicesSection } from '@/components/admin/devices-section';
import { bodyOf, calls, deviceBody, failure, mockApi } from '@/test/fake-api';
import { renderWithTheme } from '@/test/render';
import { resetSecureStore } from '@/test/secure-store-mock';

type Device = ReturnType<typeof deviceBody>;

const LIST = 'GET /api/v1/admin/devices';
const button = (name: string) => screen.getByRole('button', { name });
const dialog = () => within(screen.getByTestId('dialog'));
const listCalls = () => calls.filter((call) => call.method === 'GET');
const lastQuery = () => new URL(listCalls().at(-1)!.url).searchParams;

const PENDING = deviceBody({
  id: 12,
  user_id: 2,
  emp_code: 'EMP-9',
  user_name: 'Ravi Kumar',
  model: 'Pixel 9',
  os: 'Android 16',
  status: 'pending',
  conflict: { user_id: 1, emp_code: 'EMP-7', name: 'Asha Rao' },
});
const REVOKED = deviceBody({ id: 13, model: 'Old Phone', status: 'revoked' });

let devices: Device[];

// Answers like the server: the status filter narrows the rows, the counts cover every device.
function page(request: Request) {
  const status = new URL(request.url).searchParams.get('status');
  const count = (wanted: string) => devices.filter((device) => device.status === wanted).length;
  return Response.json({
    items: status ? devices.filter((device) => device.status === status) : devices,
    counts: { pending: count('pending'), active: count('active'), revoked: count('revoked') },
    next_cursor: null,
  });
}

function decide(id: number, status: Device['status']) {
  return () => {
    devices = devices.map((device) => (device.id === id ? { ...device, status } : device));
    return Response.json(deviceBody({ id, status }));
  };
}

async function renderDevices() {
  await renderWithTheme(<DevicesSection top={null} />);
  await screen.findByRole('button', { name: /^All: / });
}

beforeEach(() => {
  resetSecureStore();
  devices = [deviceBody(), PENDING, REVOKED];
});

describe('Devices section', () => {
  it('shows every status filter with its count, All being the sum', async () => {
    mockApi({ [LIST]: page });
    await renderDevices();
    for (const name of ['All: 3', 'Pending: 1', 'Active: 1', 'Revoked: 1']) {
      expect(button(name)).toBeOnTheScreen();
    }
    expect(button('All: 3').props.accessibilityState.selected).toBe(true);
    expect(lastQuery().get('status')).toBeNull();
  });

  it('shows a device with its employee, phone, IST last seen and status, never the raw id', async () => {
    mockApi({ [LIST]: page });
    await renderDevices();
    const row = within(screen.getByTestId('device-11'));
    for (const text of ['Asha Rao', 'EMP-7', 'iPhone 15', 'iOS 27.0.1', '1.0.0', 'Active']) {
      expect(row.getByText(text)).toBeOnTheScreen();
    }
    expect(row.getByText('4 Oct 2026, 2:42 pm')).toBeOnTheScreen();
    expect(screen.queryByText(/raw-device-id/)).toBeNull();
  });

  it('offers Approve and Reject on a pending phone, Revoke on an active one, nothing on a revoked one', async () => {
    mockApi({ [LIST]: page });
    await renderDevices();
    expect(button('Approve Pixel 9 for Ravi Kumar')).toBeOnTheScreen();
    expect(button('Reject Pixel 9 for Ravi Kumar')).toBeOnTheScreen();
    expect(button('Revoke iPhone 15 for Asha Rao')).toBeOnTheScreen();
    expect(within(screen.getByTestId('device-13')).queryAllByRole('button')).toEqual([]);
    expect(within(screen.getByTestId('device-13')).getByText('Revoked')).toBeOnTheScreen();
  });

  it('sends the chosen status and keeps the counts while switching', async () => {
    mockApi({ [LIST]: page });
    await renderDevices();
    await fireEvent.press(button('Pending: 1'));
    await waitFor(() => expect(lastQuery().get('status')).toBe('pending'));
    await waitFor(() => expect(screen.queryByTestId('device-11')).toBeNull());
    expect(screen.getByTestId('device-12')).toBeOnTheScreen();
    expect(button('Pending: 1').props.accessibilityState.selected).toBe(true);
    expect(button('All: 3')).toBeOnTheScreen();
  });

  it('warns on a pending phone that is already active for another employee', async () => {
    mockApi({ [LIST]: page });
    await renderDevices();
    expect(
      within(screen.getByTestId('device-12')).getByText(
        'This phone is already active for Asha Rao (EMP-7)',
      ),
    ).toBeOnTheScreen();
    expect(within(screen.getByTestId('device-11')).queryByText(/already active for/)).toBeNull();
  });

  it('approves a conflicting phone after the notice, then refreshes the list and the counts', async () => {
    mockApi({ [LIST]: page, 'PATCH /api/v1/admin/devices/12': decide(12, 'active') });
    await renderDevices();
    await fireEvent.press(button('Approve Pixel 9 for Ravi Kumar'));

    expect(dialog().getByRole('header', { name: 'Approve phone' })).toBeOnTheScreen();
    expect(dialog().getByText('Approve Pixel 9 for Ravi Kumar?')).toBeOnTheScreen();
    expect(dialog().getByRole('alert')).toHaveTextContent(
      "This phone is active for Asha Rao (EMP-7): their access on it is revoked and they are signed out at once. Ravi Kumar's current phone, if any, is revoked too.",
    );
    expect(calls.some((call) => call.method === 'PATCH')).toBe(false);

    await fireEvent.press(dialog().getByRole('button', { name: 'Approve' }));
    await waitFor(() => expect(screen.queryByTestId('dialog')).toBeNull());
    const patch = calls.find((call) => call.method === 'PATCH');
    expect(new URL(patch!.url).pathname).toBe('/api/v1/admin/devices/12');
    expect(await bodyOf(patch!)).toEqual({ action: 'approve' });

    expect(await screen.findByRole('button', { name: 'Active: 2' })).toBeOnTheScreen();
    expect(button('Pending: 0')).toBeOnTheScreen();
    expect(screen.queryByRole('button', { name: 'Approve Pixel 9 for Ravi Kumar' })).toBeNull();
    expect(button('Revoke Pixel 9 for Ravi Kumar')).toBeOnTheScreen();
  });

  it('approves a phone without a conflict with the plain web wording and no notice', async () => {
    devices = [{ ...PENDING, conflict: null }];
    mockApi({ [LIST]: page, 'PATCH /api/v1/admin/devices/12': decide(12, 'active') });
    await renderDevices();
    await fireEvent.press(button('Approve Pixel 9 for Ravi Kumar'));
    expect(
      dialog().getByText(
        "Approve Pixel 9 for Ravi Kumar? This revokes the employee's current phone, which is signed out at once.",
      ),
    ).toBeOnTheScreen();
    expect(dialog().queryByRole('alert')).toBeNull();
    await fireEvent.press(dialog().getByRole('button', { name: 'Cancel' }));
    expect(screen.queryByTestId('dialog')).toBeNull();
    expect(calls.some((call) => call.method === 'PATCH')).toBe(false);
  });

  it.each([
    [
      'Reject',
      12,
      'Reject Pixel 9 for Ravi Kumar',
      'Reject the request for Pixel 9 from Ravi Kumar?',
    ],
    [
      'Revoke',
      11,
      'Revoke iPhone 15 for Asha Rao',
      'Revoke iPhone 15 for Asha Rao? The phone is signed out and cannot punch in.',
    ],
  ])('%s asks first, then sends its action', async (label, id, rowButton, question) => {
    const route = `PATCH /api/v1/admin/devices/${id}`;
    mockApi({ [LIST]: page, [route]: decide(id, 'revoked') });
    await renderDevices();
    await fireEvent.press(button(rowButton));
    expect(dialog().getByText(question)).toBeOnTheScreen();

    await fireEvent.press(dialog().getByRole('button', { name: label }));
    await waitFor(() => expect(screen.queryByTestId('dialog')).toBeNull());
    const patch = calls.find((call) => call.method === 'PATCH');
    expect(new URL(patch!.url).pathname).toBe(`/api/v1/admin/devices/${id}`);
    expect(await bodyOf(patch!)).toEqual({ action: label.toLowerCase() });
    expect(await screen.findByRole('button', { name: 'Revoked: 2' })).toBeOnTheScreen();
  });

  it('keeps the dialog open with the server message on a 409 and reloads the list', async () => {
    mockApi({
      [LIST]: page,
      'PATCH /api/v1/admin/devices/12': () =>
        failure(409, 'CONFLICT', 'This phone is no longer waiting for approval.'),
    });
    await renderDevices();
    const before = listCalls().length;
    await fireEvent.press(button('Approve Pixel 9 for Ravi Kumar'));
    await fireEvent.press(dialog().getByRole('button', { name: 'Approve' }));

    expect(
      await dialog().findByText('This phone is no longer waiting for approval.'),
    ).toBeOnTheScreen();
    expect(dialog().getByRole('header', { name: 'Approve phone' })).toBeOnTheScreen();
    await waitFor(() => expect(listCalls().length).toBeGreaterThan(before));
  });

  it('shows the server message when the admin may not manage devices', async () => {
    mockApi({ [LIST]: () => failure(403, 'FORBIDDEN', 'You may not manage devices.') });
    await renderWithTheme(<DevicesSection top={null} />);
    expect(await screen.findByRole('alert')).toHaveTextContent('You may not manage devices.');
    expect(button('Retry')).toBeOnTheScreen();
  });

  it('retries after a failed load', async () => {
    let fail = true;
    mockApi({
      [LIST]: (request) =>
        fail ? failure(500, 'INTERNAL', 'The server had a problem.') : page(request),
    });
    await renderWithTheme(<DevicesSection top={null} />);
    expect(await screen.findByText('The server had a problem.')).toBeOnTheScreen();
    fail = false;
    await fireEvent.press(button('Retry'));
    expect(await screen.findByTestId('device-11')).toBeOnTheScreen();
    expect(screen.queryByText('The server had a problem.')).toBeNull();
  });

  it('shows a skeleton while the first page loads', async () => {
    let answer: (response: Response) => void = () => undefined;
    mockApi({ [LIST]: () => new Promise<Response>((resolve) => (answer = resolve)) });
    await renderWithTheme(<DevicesSection top={null} />);
    expect(await screen.findByLabelText('Loading...')).toBeOnTheScreen();
    expect(screen.queryByText('No devices found.')).toBeNull();

    devices = [];
    await act(async () => answer(page(new Request('https://api.test/api/v1/admin/devices'))));
    expect(await screen.findByText('No devices found.')).toBeOnTheScreen();
    expect(screen.queryByLabelText('Loading...')).toBeNull();
  });

  it('shows the empty state of the chosen filter', async () => {
    devices = [deviceBody()];
    mockApi({ [LIST]: page });
    await renderDevices();
    await fireEvent.press(button('Revoked: 0'));
    expect(await screen.findByText('No revoked devices found.')).toBeOnTheScreen();
  });

  it('reloads on pull to refresh', async () => {
    mockApi({ [LIST]: page });
    await renderDevices();
    const before = listCalls().length;
    devices = [...devices, deviceBody({ id: 14, model: 'New Phone', status: 'pending' })];

    const { refreshControl } = screen.getByTestId('admin-list').props;
    await act(async () => refreshControl.props.onRefresh());
    expect(await screen.findByRole('button', { name: 'Pending: 2' })).toBeOnTheScreen();
    expect(listCalls()).toHaveLength(before + 1);
    expect(screen.getByTestId('device-14')).toBeOnTheScreen();
  });

  it('loads the next page from Load more with the cursor', async () => {
    mockApi({
      [LIST]: (request) => {
        const cursor = new URL(request.url).searchParams.get('cursor');
        return Response.json({
          items: cursor ? [REVOKED] : [deviceBody()],
          counts: { pending: 0, active: 1, revoked: 1 },
          next_cursor: cursor ? null : 'page-2',
        });
      },
    });
    await renderDevices();
    expect(screen.queryByTestId('device-13')).toBeNull();
    await fireEvent.press(button('Load more'));
    expect(await screen.findByTestId('device-13')).toBeOnTheScreen();
    expect(lastQuery().get('cursor')).toBe('page-2');
    expect(screen.getByTestId('device-11')).toBeOnTheScreen();
    expect(screen.queryByRole('button', { name: 'Load more' })).toBeNull();
  });
});
