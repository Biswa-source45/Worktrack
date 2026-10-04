import { fireEvent, screen, waitFor, within } from '@testing-library/react-native';
import { renderRouter } from 'expo-router/testing-library';
import { setTokens } from '@/lib/token-store';
import { bodyOf, calls, employeeBody, failure, meBody, mockApi } from '@/test/fake-api';
import { resetSecureStore } from '@/test/secure-store-mock';

type Employee = ReturnType<typeof employeeBody>;
type Routes = Parameters<typeof mockApi>[0];

const LIST = 'GET /api/v1/admin/employees';
const ONE = 'GET /api/v1/admin/employees/1';
const SCHEDULE = 'GET /api/v1/admin/employees/1/schedule';
const HOME = 'GET /api/v1/admin/employees/1/home-location';
const SEARCH = 'Search by name, code or mobile';
const WARNING =
  'Share this temporary password with the employee securely. It is shown only once and cannot be retrieved later. The employee must change it at first sign in.';
const HOUR_MS = 3_600_000;

const button = (name: string | RegExp) => screen.getByRole('button', { name });
const dialog = () => within(screen.getByTestId('dialog'));
const listCalls = () => calls.filter((call) => new URL(call.url).pathname.endsWith('/employees'));
const lastQuery = () => new URL(listCalls().at(-1)!.url).searchParams;
const sent = (method: string) => calls.filter((call) => call.method === method);

const RAVI = employeeBody({
  id: 2,
  emp_code: 'EMP-9',
  name: 'Ravi Kumar',
  designation: { id: 5, name: 'Supervisor' },
  role: { id: 6, name: 'Manager' },
  status: 'inactive',
});

let employees: Employee[];

// Answers like the server: q and status narrow the rows.
function page(request: Request) {
  const { searchParams } = new URL(request.url);
  const q = searchParams.get('q')?.toLowerCase();
  const status = searchParams.get('status');
  return Response.json({
    items: employees.filter(
      (employee) =>
        (!q || employee.name.toLowerCase().includes(q)) && (!status || employee.status === status),
    ),
    next_cursor: null,
  });
}

const one = () => Response.json(employees.find((employee) => employee.id === 1));

// The seven days the screen asked for: a weekly off, a holiday, one day at home, the rest at office.
function schedule(request: Request) {
  const from = new Date(new URL(request.url).searchParams.get('from')!).getTime();
  const plans = [
    ['off', 'weekly_off'],
    ['off', 'holiday'],
    ['home', 'schedule'],
    ['office', 'schedule'],
    ['office', 'shift'],
    ['office', 'schedule'],
    ['office', 'schedule'],
  ];
  return Response.json({
    rows: [],
    resolved: plans.map(([kind, reason], index) => ({
      date: new Date(from + index * 86_400_000).toISOString().slice(0, 10),
      kind,
      reason,
    })),
  });
}

const APPROVED_HOME = {
  id: 31,
  lat: 20.123456,
  lng: 85.654321,
  radius_m: 100,
  source: 'request',
  decided_at: '2026-10-02T06:00:00Z',
};
const PENDING_HOME = {
  id: 32,
  lat: 20.987654,
  lng: 85.456789,
  radius_m: 100,
  accuracy_m: 14,
  created_at: '2026-10-04T09:12:00Z',
};
const homeLocation = (approved: unknown, pending: unknown) => () =>
  Response.json({ approved, pending });

function change(over: Record<string, unknown>) {
  employees = employees.map((employee) =>
    employee.id === 1 ? { ...employee, ...over } : employee,
  );
}

function signIn(routes: Routes = {}) {
  mockApi({
    'GET /api/v1/me': () =>
      Response.json(meBody({ id: 99, emp_code: 'ADM-1', permissions: ['employees.manage'] })),
    'GET /api/v1/me/sessions': () => Response.json([]),
    'POST /api/v1/auth/logout': () => new Response(null, { status: 204 }),
    [LIST]: page,
    [ONE]: one,
    [SCHEDULE]: schedule,
    [HOME]: homeLocation(APPROVED_HOME, null),
    ...routes,
  });
}

async function openEmployees() {
  await renderRouter('./src/app');
  await screen.findByText('Test Phone');
  await fireEvent.press(screen.getByRole('tab', { name: 'Admin' }));
  await screen.findByRole('header', { name: 'Employees' });
  await screen.findByRole('button', { name: /^Asha Rao \(EMP-7\)/ });
}

async function openAsha() {
  await openEmployees();
  await fireEvent.press(button(/^Asha Rao \(EMP-7\)/));
  await screen.findByText('Edit on the web portal');
}

describe('Admin employees', () => {
  beforeEach(async () => {
    resetSecureStore();
    await setTokens({ access: 'access-1', refresh: 'refresh-1' });
    employees = [employeeBody(), RAVI];
  });

  // The app keeps one query cache for its whole life. Signing out empties it, as on a real phone,
  // so the next test does not start with this test's employees. (Inside the describe so that it
  // runs before the testing library unmounts the app.)
  afterEach(async () => {
    await fireEvent.press(screen.getByRole('tab', { name: 'Profile & Settings' }));
    await fireEvent.press(await screen.findByRole('button', { name: 'Sign out' }));
    await screen.findByLabelText('Employee ID or mobile number');
  });

  describe('Employees section', () => {
    it('lists employees with code, designation, role and status', async () => {
      signIn();
      await openEmployees();
      expect(screen.getByText('EMP-7 · Technician · Employee')).toBeOnTheScreen();
      expect(screen.getByText('EMP-9 · Supervisor · Manager')).toBeOnTheScreen();
      expect(button('Asha Rao (EMP-7), Technician, Employee, Active')).toBeOnTheScreen();
      expect(button('Ravi Kumar (EMP-9), Supervisor, Manager, Inactive')).toBeOnTheScreen();
      expect(lastQuery().get('q')).toBeNull();
      expect(lastQuery().get('status')).toBeNull();
    });

    it('marks a locked employee, and not one whose lock has passed', async () => {
      employees = [
        employeeBody({ locked_until: new Date(Date.now() + HOUR_MS).toISOString() }),
        { ...RAVI, locked_until: new Date(Date.now() - HOUR_MS).toISOString() },
      ];
      signIn();
      await openEmployees();
      expect(button('Asha Rao (EMP-7), Technician, Employee, Active, Locked')).toBeOnTheScreen();
      expect(button('Ravi Kumar (EMP-9), Supervisor, Manager, Inactive')).toBeOnTheScreen();
      expect(screen.getAllByText('Locked')).toHaveLength(1);
    });

    it('searches with q once typing has paused, not on every key', async () => {
      signIn();
      await openEmployees();
      const before = listCalls().length;
      const field = screen.getByLabelText(SEARCH);
      await fireEvent.changeText(field, 'r');
      await fireEvent.changeText(field, 'ra');
      await fireEvent.changeText(field, ' ravi ');
      expect(listCalls()).toHaveLength(before);

      await waitFor(() => expect(lastQuery().get('q')).toBe('ravi'));
      expect(listCalls()).toHaveLength(before + 1);
      expect(
        await screen.findByRole('button', { name: /^Ravi Kumar \(EMP-9\)/ }),
      ).toBeOnTheScreen();
      expect(screen.queryByRole('button', { name: /^Asha Rao \(EMP-7\)/ })).toBeNull();
    });

    it('filters by status and shows the empty state', async () => {
      signIn();
      await openEmployees();
      expect(button('All').props.accessibilityState.selected).toBe(true);

      await fireEvent.press(button('Inactive'));
      await waitFor(() => expect(lastQuery().get('status')).toBe('inactive'));
      expect(
        await screen.findByRole('button', { name: /^Ravi Kumar \(EMP-9\)/ }),
      ).toBeOnTheScreen();
      expect(screen.queryByRole('button', { name: /^Asha Rao \(EMP-7\)/ })).toBeNull();

      employees = [RAVI];
      await fireEvent.press(button('Active'));
      await waitFor(() => expect(lastQuery().get('status')).toBe('active'));
      expect(await screen.findByText('No employees found.')).toBeOnTheScreen();
    });
  });

  describe('Employee detail', () => {
    it('opens from the list with the details and goes back', async () => {
      signIn();
      await openAsha();
      expect(screen.getByRole('header', { name: 'Asha Rao' })).toBeOnTheScreen();
      for (const text of [
        'EMP-7',
        '9000000000',
        'Not set',
        'Technician',
        'Employee',
        'Service',
        '15 Jan 2026',
        'Edit on the web portal',
      ]) {
        expect(screen.getByText(text)).toBeOnTheScreen();
      }
      // Field-eligible: Yes; Must change password: No.
      expect(screen.getByText('Yes')).toBeOnTheScreen();
      expect(screen.getByText('No')).toBeOnTheScreen();
      expect(sent('GET').some((call) => call.url.endsWith('/admin/employees/1'))).toBe(true);

      await fireEvent.press(button('Back'));
      expect(await screen.findByLabelText(SEARCH)).toBeOnTheScreen();
      expect(screen.queryByText('Edit on the web portal')).toBeNull();
    });

    it('shows the email, and Not assigned without a department', async () => {
      change({ email: 'asha@example.com', department: null, must_change_password: true });
      signIn();
      await openAsha();
      expect(screen.getByText('asha@example.com')).toBeOnTheScreen();
      expect(screen.getByText('Not assigned')).toBeOnTheScreen();
      expect(screen.queryByText('Not set')).toBeNull();
      expect(screen.getAllByText('Yes')).toHaveLength(2);
    });

    it('deactivates after asking and then offers Reactivate', async () => {
      signIn({
        'PATCH /api/v1/admin/employees/1': () => {
          change({ status: 'inactive' });
          return one();
        },
      });
      await openAsha();
      expect(screen.queryByRole('button', { name: 'Reactivate' })).toBeNull();
      await fireEvent.press(button('Deactivate'));
      expect(
        dialog().getByText(
          'Deactivate Asha Rao? They will be signed out and cannot sign in again until reactivated.',
        ),
      ).toBeOnTheScreen();
      expect(sent('PATCH')).toHaveLength(0);

      await fireEvent.press(dialog().getByRole('button', { name: 'Deactivate' }));
      await waitFor(() => expect(screen.queryByTestId('dialog')).toBeNull());
      expect(sent('PATCH')).toHaveLength(1);
      expect(new URL(sent('PATCH')[0].url).pathname).toBe('/api/v1/admin/employees/1');
      expect(await bodyOf(sent('PATCH')[0])).toEqual({ status: 'inactive' });

      expect(await screen.findByRole('button', { name: 'Reactivate' })).toBeOnTheScreen();
      expect(screen.queryByRole('button', { name: 'Deactivate' })).toBeNull();
      expect(screen.getByText('Inactive')).toBeOnTheScreen();

      // The list behind the detail was refreshed too.
      await fireEvent.press(button('Back'));
      expect(
        await screen.findByRole('button', {
          name: 'Asha Rao (EMP-7), Technician, Employee, Inactive',
        }),
      ).toBeOnTheScreen();
    });

    it('reactivates an inactive employee after asking', async () => {
      change({ status: 'inactive' });
      signIn({
        'PATCH /api/v1/admin/employees/1': () => {
          change({ status: 'active' });
          return one();
        },
      });
      await openAsha();
      await fireEvent.press(button('Reactivate'));
      expect(
        dialog().getByText('Reactivate Asha Rao? They will be able to sign in again.'),
      ).toBeOnTheScreen();
      await fireEvent.press(dialog().getByRole('button', { name: 'Reactivate' }));
      await waitFor(() => expect(screen.queryByTestId('dialog')).toBeNull());
      expect(await bodyOf(sent('PATCH')[0])).toEqual({ status: 'active' });
      expect(await screen.findByRole('button', { name: 'Deactivate' })).toBeOnTheScreen();
    });

    it('shows the server message when the admin may not manage this employee', async () => {
      signIn({
        'PATCH /api/v1/admin/employees/1': () =>
          failure(403, 'FORBIDDEN', 'You may not manage this employee.'),
      });
      await openAsha();
      const before = sent('GET').length;
      await fireEvent.press(button('Deactivate'));
      await fireEvent.press(dialog().getByRole('button', { name: 'Deactivate' }));
      expect(await dialog().findByText('You may not manage this employee.')).toBeOnTheScreen();
      await waitFor(() => expect(sent('GET').length).toBeGreaterThan(before));

      await fireEvent.press(dialog().getByRole('button', { name: 'Cancel' }));
      expect(button('Deactivate')).toBeOnTheScreen();
    });

    it('has no Unlock for an employee who is not locked', async () => {
      signIn();
      await openAsha();
      expect(screen.queryByRole('button', { name: 'Unlock' })).toBeNull();
      expect(screen.queryByText('Locked')).toBeNull();
    });

    it('unlocks a locked employee', async () => {
      change({ locked_until: new Date(Date.now() + HOUR_MS).toISOString() });
      signIn({
        'POST /api/v1/admin/employees/1/unlock': () => {
          change({ locked_until: null });
          return one();
        },
      });
      await openAsha();
      expect(screen.getByText('Locked')).toBeOnTheScreen();
      await fireEvent.press(button('Unlock'));

      await waitFor(() => expect(screen.queryByRole('button', { name: 'Unlock' })).toBeNull());
      expect(sent('POST').map((call) => new URL(call.url).pathname)).toEqual([
        '/api/v1/admin/employees/1/unlock',
      ]);
      expect(screen.queryByText('Locked')).toBeNull();
    });

    it('shows the server message when unlocking fails', async () => {
      change({ locked_until: new Date(Date.now() + HOUR_MS).toISOString() });
      signIn({
        'POST /api/v1/admin/employees/1/unlock': () =>
          failure(403, 'FORBIDDEN', 'You may not manage this employee.'),
      });
      await openAsha();
      await fireEvent.press(button('Unlock'));
      expect(await screen.findByText('You may not manage this employee.')).toBeOnTheScreen();
      expect(button('Unlock')).toBeOnTheScreen();
    });

    it('resets the password: shows the temporary password once, and a new one the next time', async () => {
      let issued = 0;
      signIn({
        'POST /api/v1/admin/employees/1/reset-password': () => {
          issued += 1;
          change({ must_change_password: true });
          return Response.json({ temporary_password: `Temp-pass-${issued}` });
        },
      });
      await openAsha();
      await fireEvent.press(button('Reset password'));
      expect(
        dialog().getByText(
          'Generate a new temporary password for Asha Rao? Their current password stops working and they are signed out.',
        ),
      ).toBeOnTheScreen();
      expect(sent('POST')).toHaveLength(0);
      expect(screen.queryByTestId('temp-password')).toBeNull();

      await fireEvent.press(dialog().getByRole('button', { name: 'Reset password' }));
      const shown = await screen.findByTestId('temp-password');
      expect(shown).toHaveTextContent('Temp-pass-1');
      expect(shown.props.selectable).toBe(true);
      expect(dialog().getByRole('header', { name: 'Temporary password' })).toBeOnTheScreen();
      expect(dialog().getByText('Asha Rao (EMP-7)')).toBeOnTheScreen();
      expect(dialog().getByRole('alert')).toHaveTextContent(WARNING);
      expect(new URL(sent('POST')[0].url).pathname).toBe(
        '/api/v1/admin/employees/1/reset-password',
      );

      await fireEvent.press(dialog().getByRole('button', { name: 'Close' }));
      expect(screen.queryByTestId('dialog')).toBeNull();
      expect(screen.queryByTestId('temp-password')).toBeNull();
      expect(screen.queryByText(/Temp-pass/)).toBeNull();
      // Going away and coming back does not bring it back either.
      await fireEvent.press(button('Back'));
      await fireEvent.press(await screen.findByRole('button', { name: /^Asha Rao \(EMP-7\)/ }));
      await screen.findByText('Edit on the web portal');
      expect(screen.queryByText(/Temp-pass/)).toBeNull();

      // Asking again goes to the server again and shows only the new value.
      await fireEvent.press(button('Reset password'));
      expect(screen.queryByTestId('temp-password')).toBeNull();
      expect(sent('POST')).toHaveLength(1);
      await fireEvent.press(dialog().getByRole('button', { name: 'Reset password' }));
      expect(await screen.findByTestId('temp-password')).toHaveTextContent('Temp-pass-2');
      expect(screen.queryByText('Temp-pass-1')).toBeNull();
      expect(sent('POST')).toHaveLength(2);
      await fireEvent.press(dialog().getByRole('button', { name: 'Close' }));
      expect(screen.queryByText(/Temp-pass/)).toBeNull();
    });

    it('shows no password when the reset is refused', async () => {
      signIn({
        'POST /api/v1/admin/employees/1/reset-password': () =>
          failure(403, 'FORBIDDEN', 'You may not manage this employee.'),
      });
      await openAsha();
      await fireEvent.press(button('Reset password'));
      await fireEvent.press(dialog().getByRole('button', { name: 'Reset password' }));
      expect(await dialog().findByText('You may not manage this employee.')).toBeOnTheScreen();
      expect(screen.queryByTestId('temp-password')).toBeNull();
      await fireEvent.press(dialog().getByRole('button', { name: 'Cancel' }));
    });

    it('shows the home branch and the shift, and no branch restriction by default', async () => {
      signIn();
      await openAsha();
      expect(screen.getByText('Home branch')).toBeOnTheScreen();
      expect(screen.getByText('Head Office')).toBeOnTheScreen();
      expect(screen.getByText('Shift')).toBeOnTheScreen();
      expect(screen.getByText('General')).toBeOnTheScreen();
      expect(screen.queryByText('Only at home branch')).toBeNull();
    });

    it('says Not set without a home branch or shift, and shows the branch restriction', async () => {
      change({
        email: 'asha@example.com',
        home_branch: null,
        shift: null,
        restrict_to_home_branch: true,
      });
      signIn();
      await openAsha();
      expect(screen.getAllByText('Not set')).toHaveLength(2);
      expect(screen.getByText('Only at home branch')).toBeOnTheScreen();
      // Field-eligible and the restriction.
      expect(screen.getAllByText('Yes')).toHaveLength(2);
    });

    it('lists the next 7 days from today in IST with the kind and the reason', async () => {
      signIn();
      await openAsha();
      expect(await screen.findByRole('header', { name: 'Next 7 days' })).toBeOnTheScreen();

      const asked = new URL(
        sent('GET').find((call) => call.url.includes('/employees/1/schedule'))!.url,
      ).searchParams;
      const from = asked.get('from')!;
      const today = new Intl.DateTimeFormat('en-CA', { timeZone: 'Asia/Kolkata' }).format(
        new Date(),
      );
      expect(from).toBe(today);
      const day = (index: number) =>
        new Date(new Date(from).getTime() + index * 86_400_000).toISOString().slice(0, 10);
      expect(asked.get('to')).toBe(day(6));

      const expected = [
        ['Off', 'Weekly off'],
        ['Off', 'Holiday'],
        ['Home', 'Weekly schedule'],
        ['Office', 'Weekly schedule'],
        ['Office', 'As per shift'],
        ['Office', 'Weekly schedule'],
        ['Office', 'Weekly schedule'],
      ];
      for (const [index, [kind, reason]] of expected.entries()) {
        const row = within(screen.getByTestId(`day-${day(index)}`));
        expect(row.getByText(kind)).toBeOnTheScreen();
        expect(row.getByText(reason)).toBeOnTheScreen();
        const label = new Intl.DateTimeFormat('en-IN', {
          timeZone: 'UTC',
          weekday: 'short',
          day: 'numeric',
          month: 'short',
        }).format(new Date(day(index)));
        expect(row.getByText(label)).toBeOnTheScreen();
      }
    });

    it.each([
      ['Approved (100 m)', APPROVED_HOME, null],
      ['Request pending', null, PENDING_HOME],
      ['Approved (100 m) · Request pending', APPROVED_HOME, PENDING_HOME],
      ['Not set', null, null],
    ])(
      'shows the home location as "%s" and never its coordinates',
      async (status, approved, pending) => {
        change({ email: 'asha@example.com' });
        signIn({ [HOME]: homeLocation(approved, pending) });
        await openAsha();
        expect(await screen.findByText('Home location')).toBeOnTheScreen();
        expect(screen.getByText(status)).toBeOnTheScreen();
        expect(screen.queryByText(/20\.\d|85\.\d/)).toBeNull();
        expect(screen.queryByText(/123456|654321|987654|456789/)).toBeNull();
      },
    );

    it('hides the schedule and the home location quietly when the viewer may not manage the employee', async () => {
      const forbidden = () => failure(403, 'FORBIDDEN', 'You may not manage this employee.');
      signIn({ [SCHEDULE]: forbidden, [HOME]: forbidden });
      await openAsha();
      await waitFor(() =>
        expect(sent('GET').some((call) => call.url.includes('/home-location'))).toBe(true),
      );
      await waitFor(() => expect(screen.queryByLabelText('Loading...')).toBeNull());
      expect(screen.queryByText('Next 7 days')).toBeNull();
      expect(screen.queryByText('Home location')).toBeNull();
      expect(screen.queryByText('You may not manage this employee.')).toBeNull();
      expect(screen.queryByRole('alert')).toBeNull();
      expect(screen.queryByRole('button', { name: 'Retry' })).toBeNull();
      // The rest of the page is untouched.
      expect(screen.getByText('Head Office')).toBeOnTheScreen();
      expect(button('Reset password')).toBeOnTheScreen();
    });

    it('keeps the home location when only the schedule is closed to the viewer', async () => {
      signIn({ [SCHEDULE]: () => failure(403, 'FORBIDDEN', 'You may not manage this employee.') });
      await openAsha();
      expect(await screen.findByText('Approved (100 m)')).toBeOnTheScreen();
      expect(screen.queryByText('Next 7 days')).toBeNull();
      expect(screen.queryByRole('alert')).toBeNull();
    });

    it('offers Retry when the schedule fails for another reason', async () => {
      let fail = true;
      signIn({
        [SCHEDULE]: (request) =>
          fail ? failure(500, 'INTERNAL', 'The server had a problem.') : schedule(request),
      });
      await openAsha();
      expect(
        await screen.findByText('Could not load the schedule and home location.'),
      ).toBeOnTheScreen();
      expect(screen.getByText('Approved (100 m)')).toBeOnTheScreen();
      fail = false;
      await fireEvent.press(button('Retry'));
      expect(await screen.findByRole('header', { name: 'Next 7 days' })).toBeOnTheScreen();
      expect(screen.queryByText('Could not load the schedule and home location.')).toBeNull();
    });

    it('shows the server message with Retry when the employee cannot be loaded', async () => {
      let fail = true;
      signIn({
        [ONE]: () =>
          fail ? failure(403, 'FORBIDDEN', 'You may not manage this employee.') : one(),
      });
      await openEmployees();
      await fireEvent.press(button(/^Asha Rao \(EMP-7\)/));
      expect(await screen.findByText('You may not manage this employee.')).toBeOnTheScreen();
      expect(button('Back')).toBeOnTheScreen();
      expect(screen.queryByRole('button', { name: 'Reset password' })).toBeNull();

      fail = false;
      await fireEvent.press(button('Retry'));
      expect(await screen.findByText('Edit on the web portal')).toBeOnTheScreen();
    });
  });
});
