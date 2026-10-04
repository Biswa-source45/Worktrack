import type { Schemas } from '@/lib/api-client';

export const ALL = ['web.access', 'employees.manage', 'devices.manage', 'team.view'];

export function makeMe(overrides: Partial<Schemas['MeResponse']> = {}): Schemas['MeResponse'] {
  return {
    id: 1,
    emp_code: 'ADMIN-1',
    name: 'Demo Admin',
    mobile: '9000000001',
    email: null,
    role: { id: 1, name: 'Super Admin' },
    permissions: ALL,
    designation: { id: 1, name: 'MD' },
    department: null,
    manager_id: null,
    field_eligible: false,
    must_change_password: false,
    client: 'web',
    device: null,
    ...overrides,
  };
}

export function makeEmployee(
  overrides: Partial<Schemas['EmployeeOut']> = {},
): Schemas['EmployeeOut'] {
  return {
    id: 2,
    emp_code: 'EMP-001',
    name: 'Asha Rao',
    mobile: '9876543210',
    email: null,
    role: { id: 3, name: 'Field Employee' },
    designation: { id: 2, name: 'Engineer' },
    department: { id: 1, name: 'Operations' },
    manager_id: 1,
    field_eligible: true,
    status: 'active',
    joined_on: '2026-01-15',
    must_change_password: false,
    locked_until: null,
    created_at: '2026-01-15T04:30:00Z',
    ...overrides,
  };
}

export const ROLES: Schemas['RoleOut'][] = [
  { id: 1, name: 'Super Admin', permissions: [...ALL, 'roles.manage'], is_system: true },
  { id: 3, name: 'Field Employee', permissions: [], is_system: true },
  { id: 4, name: 'HR Admin', permissions: ['web.access', 'employees.manage'], is_system: false },
];

export const DESIGNATIONS = [
  { id: 1, name: 'MD' },
  { id: 2, name: 'Engineer' },
];
export const DEPARTMENTS = [{ id: 1, name: 'Operations' }];

export function makeDevice(overrides: Partial<Schemas['DeviceOut']> = {}): Schemas['DeviceOut'] {
  return {
    id: 7,
    user_id: 2,
    emp_code: 'EMP-001',
    user_name: 'Asha Rao',
    device_id: 'device-abcdef',
    model: 'Pixel 8',
    os: 'Android 15',
    app_version: '1.0.0',
    status: 'pending',
    approved_by: null,
    created_at: '2026-01-15T04:30:00Z',
    updated_at: '2026-01-15T04:30:00Z',
    last_seen_at: '2026-01-15T04:30:00Z',
    conflict: null,
    ...overrides,
  };
}

export function makeSession(overrides: Partial<Schemas['SessionOut']> = {}): Schemas['SessionOut'] {
  return {
    id: 21,
    user_id: 2,
    emp_code: 'EMP-001',
    user_name: 'Asha Rao',
    client: 'web',
    browser: 'Chrome 141',
    os: 'Windows',
    device_model: null,
    ip: '203.0.113.7',
    created_at: '2026-02-01T04:30:00Z',
    last_seen_at: '2026-02-01T18:45:00Z',
    status: 'active',
    ended_at: null,
    end_reason: null,
    current: false,
    ...overrides,
  };
}
