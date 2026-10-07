import { act } from '@testing-library/react-native';
import type { components } from 'api-types';

type Schemas = components['schemas'];

// Routes fetch by "METHOD /path" so screen tests can script backend answers.
type Handler = (request: Request) => Response | Promise<Response>;

export const calls: Request[] = [];

// Profile & Settings asks for this on every visit, and most tests only pass through there.
const DEFAULT_ROUTES: Record<string, Handler> = {
  'GET /api/v1/attendance/today': () => Response.json(todayBody()),
  'GET /api/v1/me/home-location': () =>
    Response.json({ approved: null, pending: null, last_rejected: null }),
  'GET /api/v1/me/face-enrollment': () =>
    Response.json({
      status: 'none',
      consent_at: null,
      submitted_at: null,
      decided_at: null,
      reason: null,
    }),
};

export function mockApi(routes: Record<string, Handler>) {
  calls.length = 0;
  jest.mocked(fetch).mockImplementation(async (input) => {
    const request = input as Request;
    calls.push(request.clone());
    const key = `${request.method} ${new URL(request.url).pathname}`;
    const handler = routes[key] ?? DEFAULT_ROUTES[key];
    if (!handler) throw new Error(`Unmocked request: ${key}`);
    return handler(request);
  });
}

/**
 * The JSON body of a recorded call. Read inside act: the read lets timers run, and a list that is
 * still batching its rows would otherwise update outside act and log a warning.
 */
export const bodyOf = (call: Request): Promise<unknown> => act(() => call.json());

export const errorBody = (code: string, details: unknown = null, status = 400) =>
  Response.json({ error: { code, message: code, details } }, { status });

export const tokenBody = (over: Record<string, unknown> = {}) => ({
  access_token: 'access-1',
  refresh_token: 'refresh-1',
  token_type: 'bearer',
  expires_in: 900,
  must_change_password: false,
  device_status: 'active',
  ...over,
});

export const meBody = (over: Record<string, unknown> = {}) => ({
  id: 1,
  emp_code: 'EMP-7',
  name: 'Asha Rao',
  mobile: '9000000000',
  email: null,
  role: { id: 2, name: 'Employee' },
  permissions: [],
  designation: { id: 3, name: 'Technician' },
  department: { id: 4, name: 'Service' },
  manager_id: null,
  field_eligible: true,
  must_change_password: false,
  client: 'mobile',
  device: { id: 9, status: 'active', pending_reason: null },
  ...over,
});

/** A failed call with the server's own message, as the admin endpoints answer. */
export const failure = (status: number, code: string, message: string) =>
  Response.json({ error: { code, message, details: null } }, { status });

export const deviceBody = (over: Partial<Schemas['DeviceOut']> = {}): Schemas['DeviceOut'] => ({
  id: 11,
  user_id: 1,
  emp_code: 'EMP-7',
  user_name: 'Asha Rao',
  device_id: 'raw-device-id-11',
  model: 'iPhone 15',
  os: 'iOS 27.0.1',
  app_version: '1.0.0',
  status: 'active',
  approved_by: null,
  created_at: '2026-10-01T04:30:00Z',
  updated_at: '2026-10-01T04:30:00Z',
  last_seen_at: '2026-10-04T09:12:00Z',
  conflict: null,
  ...over,
});

export const employeeBody = (
  over: Partial<Schemas['EmployeeOut']> = {},
): Schemas['EmployeeOut'] => ({
  id: 1,
  emp_code: 'EMP-7',
  name: 'Asha Rao',
  mobile: '9000000000',
  email: null,
  role: { id: 2, name: 'Employee' },
  designation: { id: 3, name: 'Technician' },
  department: { id: 4, name: 'Service' },
  manager_id: null,
  field_eligible: true,
  field_punch_in_allowed: false,
  home_branch: { id: 7, name: 'Head Office' },
  shift: { id: 8, name: 'General' },
  restrict_to_home_branch: false,
  status: 'active',
  joined_on: '2026-01-15',
  must_change_password: false,
  locked_until: null,
  created_at: '2026-01-15T04:30:00Z',
  ...over,
});

export const sessionBody = (over: Partial<Schemas['SessionOut']> = {}): Schemas['SessionOut'] => ({
  id: 21,
  user_id: 1,
  emp_code: 'EMP-7',
  user_name: 'Asha Rao',
  client: 'mobile',
  browser: null,
  os: 'iOS 27.0.1',
  device_model: 'iPhone 15',
  ip: '203.0.113.7',
  created_at: '2026-10-03T04:30:00Z',
  last_seen_at: '2026-10-04T09:12:00Z',
  status: 'active',
  ended_at: null,
  end_reason: null,
  current: false,
  ...over,
});

export const branchBody = (over: Partial<Schemas['BranchOut']> = {}): Schemas['BranchOut'] => ({
  id: 7,
  name: 'Head Office',
  address: '12 Station Road',
  lat: 20.2961,
  lng: 85.8245,
  radius_m: 150,
  is_active: true,
  ...over,
});

/** Today as the server reports it before the first punch of a working day. */
export const todayBody = (over: Partial<Schemas['TodayOut']> = {}): Schemas['TodayOut'] => ({
  server_time: '2026-10-05T04:30:00Z',
  date: '2026-10-05',
  kind: 'office',
  reason: 'shift',
  shift: 'General',
  shift_start: '09:00:00',
  shift_end: '18:00:00',
  day: null,
  punches: [],
  action: 'punch_in',
  blocked: null,
  minutes_so_far: null,
  ...over,
});

export const dayBody = (over: Partial<Schemas['DayOut']> = {}): Schemas['DayOut'] => ({
  id: 5,
  date: '2026-10-05',
  status: 'present',
  first_in_at: '2026-10-05T03:35:00Z',
  last_out_at: null,
  worked_minutes: 0,
  late_minutes: 0,
  overtime_minutes: 0,
  flags: [],
  ...over,
});

export const punchBody = (over: Partial<Schemas['PunchBrief']> = {}): Schemas['PunchBrief'] => ({
  id: 31,
  type: 'in',
  time: '2026-10-05T03:35:00Z',
  review_status: 'verified',
  in_review: false,
  out_of_office: false,
  offline: false,
  place: { type: 'branch', branch: 'Head Office', distance_m: 20 },
  ...over,
});

export const punchResultBody = (
  over: Partial<Schemas['PunchResult']> = {},
): Schemas['PunchResult'] => ({
  punch: punchBody(),
  day: dayBody(),
  result: 'verified',
  replayed: false,
  ...over,
});

export const precheckBody = (
  over: Partial<Schemas['PrecheckOut']> = {},
): Schemas['PrecheckOut'] => ({
  allowed: true,
  action: 'punch_in',
  place: { type: 'branch', branch: 'Head Office', distance_m: 20 },
  nearest_branch: 'Head Office',
  distance_m: 20,
  ...over,
});

/**
 * Records what is appended to FormData instead of building a real form: the FormData of Node (in
 * Jest) is stricter than the phone's, which takes expo-file-system Files. Call `restore` when done.
 */
export function recordForms() {
  const parts: [string, unknown][] = [];
  const spy = jest
    .spyOn(FormData.prototype, 'append')
    .mockImplementation((name: string, value: unknown) => {
      parts.push([name, value]);
    });
  return {
    parts,
    /** The text fields of the form, by name. */
    fields: () => Object.fromEntries(parts.filter(([, value]) => typeof value === 'string')),
    restore: () => spy.mockRestore(),
  };
}

const TASK_TYPE: Schemas['TaskTypeOut'] = {
  id: 1,
  name: 'Site Visit',
  is_active: true,
  proof_photo_required: true,
  proof_kind: 'photo',
};
const ASSIGNER: Schemas['UserBrief'] = { id: 5, name: 'Meera Nair', emp_code: 'EMP-2' };

/** One of my tasks as GET /me/tasks lists it; `status` is my own status. */
export const myTaskBody = (
  over: Partial<Schemas['MyTask']> = {},
  status = 'assigned',
): Schemas['MyTask'] => ({
  id: 41,
  code: 'T-00041',
  title: 'Inspect the pump house',
  type: TASK_TYPE,
  client_name: 'Acme Water',
  site: { address: 'Plot 4, Patia, Bhubaneswar', lat: 20.3547, lng: 85.8197, radius_m: 200 },
  contact_name: 'Ravi Kumar',
  contact_phone: '+919876543210',
  priority: 'normal',
  scheduled_at: '2026-10-06T05:30:00Z',
  expected_minutes: 90,
  description: 'Check the valves and photograph the meter.',
  status,
  created_by: ASSIGNER,
  my: {
    status,
    assigned_at: '2026-10-05T10:00:00Z',
    accepted_at: null,
    started_at: null,
    completed_at: null,
    reached_at: null,
    declined_reason: null,
    reach_flags: [],
    reach_review: 'none',
  },
  ...over,
});

/** The same task as GET /tasks/{id} (and every action) answers it, with me as the one assignee. */
export const taskDetailBody = (
  over: Partial<Schemas['TaskDetail']> = {},
  status = 'assigned',
  reach: Schemas['ReachOut'] | null = null,
): Schemas['TaskDetail'] => {
  const { my: _my, ...task } = myTaskBody({}, status);
  return {
    ...task,
    created_at: '2026-10-05T10:00:00Z',
    closed_by: null,
    closed_at: null,
    close_remarks: null,
    cancelled_by: null,
    cancelled_at: null,
    cancel_reason: null,
    can_manage: false,
    assignees: [
      {
        user: { id: 1, name: 'Asha Rao', emp_code: 'EMP-7' },
        status,
        assigned_at: '2026-10-05T10:00:00Z',
        accepted_at: null,
        escalated_at: null,
        started_at: null,
        completed_at: null,
        declined_reason: null,
        completion_remarks: null,
        reach,
        metrics: {
          time_to_accept_min: null,
          accept_to_reached_min: null,
          time_on_site_min: null,
          straight_line_m: null,
        },
      },
    ],
    events: [],
    attachments: [],
    comments: [],
    ...over,
  };
};
