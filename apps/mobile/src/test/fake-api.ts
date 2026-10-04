import { act } from '@testing-library/react-native';
import type { components } from 'api-types';

type Schemas = components['schemas'];

// Routes fetch by "METHOD /path" so screen tests can script backend answers.
type Handler = (request: Request) => Response | Promise<Response>;

export const calls: Request[] = [];

// Profile & Settings asks for this on every visit, and most tests only pass through there.
const DEFAULT_ROUTES: Record<string, Handler> = {
  'GET /api/v1/me/home-location': () =>
    Response.json({ approved: null, pending: null, last_rejected: null }),
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
