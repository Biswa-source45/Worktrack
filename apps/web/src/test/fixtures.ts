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
    ...overrides,
  };
}
