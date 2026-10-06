import type { Schemas } from '@/lib/api-client';

export const ALL = ['web.access', 'employees.manage', 'devices.manage', 'team.view'];
// The Super Admin of M2: everything above plus branches, shifts, holidays and settings.
export const ADMIN = [...ALL, 'branches.manage', 'settings.view', 'settings.manage'];

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
    home_branch: null,
    shift: null,
    restrict_to_home_branch: false,
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

export const BRANCHES: Schemas['Ref'][] = [
  { id: 1, name: 'Head Office' },
  { id: 2, name: 'Warehouse' },
];
export const SHIFTS: Schemas['Ref'][] = [{ id: 1, name: 'General' }];

export function makeBranch(overrides: Partial<Schemas['BranchOut']> = {}): Schemas['BranchOut'] {
  return {
    id: 1,
    name: 'Head Office',
    address: '12 MG Road, Bhubaneswar',
    lat: 20.2961,
    lng: 85.8245,
    radius_m: 100,
    is_active: true,
    ...overrides,
  };
}

export function makeShift(overrides: Partial<Schemas['ShiftOut']> = {}): Schemas['ShiftOut'] {
  return {
    id: 1,
    name: 'General',
    start_time: '09:30:00',
    end_time: '18:30:00',
    grace_min: 10,
    half_day_hours: 4,
    full_day_hours: 8,
    weekly_offs: [
      { weekday: 6, weeks: null },
      { weekday: 5, weeks: [2, 4] },
    ],
    is_active: true,
    ...overrides,
  };
}

export const SETTINGS: Schemas['OrgSettings'] = {
  geofence_default_radius_m: 120,
  home_default_radius_m: 80,
  gps_max_accuracy_m: 50,
  geofence_accuracy_buffer_cap_m: 30,
  punch_out_approval_levels: 1,
  regularization_approval_levels: 1,
  min_app_version: '1.0.0',
  face_verify_threshold: 0.4,
  face_review_threshold: 0.3,
  face_min_detection_confidence: 0.9,
  face_min_face_px: 80,
  face_min_sharpness: 60,
  face_min_brightness: 50,
  face_max_brightness: 200,
  face_retention_days_after_exit: 30,
  attendance_cutoff_time: '23:59',
  punch_reminder_after_shift_end_min: 30,
  punch_out_request_expiry_hours: 48,
  punch_max_speed_kmh: 150,
  offline_punch_max_age_hours: 12,
};

export function makeEnrollment(
  overrides: Partial<Schemas['EnrollmentItem']> = {},
): Schemas['EnrollmentItem'] {
  return {
    id: 51,
    employee: { id: 2, emp_code: 'EMP-001', name: 'Asha Rao' },
    status: 'pending',
    consent_at: '2026-02-01T04:30:00Z',
    submitted_at: '2026-02-01T04:31:00Z',
    decided_at: null,
    ...overrides,
  };
}

export function makeEnrollmentDetail(
  overrides: Partial<Schemas['EnrollmentDetail']> = {},
): Schemas['EnrollmentDetail'] {
  return {
    ...makeEnrollment(),
    photos: ['/api/v1/files/tok.one', '/api/v1/files/tok.two', '/api/v1/files/tok.three'],
    qualities: [281, 276, 290].map((px) => ({
      confidence: 0.94,
      face_px: px,
      sharpness: 312.4,
      brightness: 128.6,
    })),
    consistency_score: 0.83,
    model_version: 'yunet-2023mar+sface-2021dec',
    decided_by: null,
    reason: null,
    ...overrides,
  };
}

export function makeHomeRequest(
  overrides: Partial<Schemas['HomeRequestItem']> = {},
): Schemas['HomeRequestItem'] {
  return {
    id: 31,
    employee: { id: 2, emp_code: 'EMP-001', name: 'Asha Rao' },
    status: 'pending',
    accuracy_m: 12,
    created_at: '2026-02-01T04:30:00Z',
    ...overrides,
  };
}

// Everything the attendance screens use: the three permissions of M4 on top of the admin set.
export const ATTENDANCE_ADMIN = [
  ...ADMIN,
  'attendance.view_all',
  'attendance.override',
  'punchout.approve',
  'face.review',
];

const ASHA = { id: 2, emp_code: 'EMP-001', name: 'Asha Rao' };
const RAVI = { id: 3, emp_code: 'EMP-002', name: 'Ravi Kumar' };
export const PEOPLE = { ASHA, RAVI };

export function makeRegisterRow(
  overrides: Partial<Schemas['RegisterRow']> = {},
): Schemas['RegisterRow'] {
  return {
    employee: ASHA,
    status: 'present',
    day_id: 81,
    branch: 'Head Office',
    first_in_at: '2026-02-03T04:05:00Z',
    last_out_at: '2026-02-03T12:40:00Z',
    worked_minutes: 515,
    late_minutes: 0,
    flags: [],
    ...overrides,
  };
}

export function makePunchDetail(
  overrides: Partial<Schemas['PunchDetail']> = {},
): Schemas['PunchDetail'] {
  return {
    id: 501,
    type: 'in',
    time: '2026-02-03T04:05:00Z',
    server_time: '2026-02-03T04:05:00Z',
    device_time: '2026-02-03T04:04:30Z',
    review_status: 'verified',
    review_reasons: [],
    face_decision: 'VERIFIED',
    face_score: 0.71,
    place: { type: 'branch', branch: 'Head Office', distance_m: 12 },
    accuracy_m: 9,
    offline: false,
    integrity_flags: [],
    selfie_url: '/api/v1/files/tok.in',
    reviewed_by: null,
    review_remarks: null,
    ...overrides,
  };
}

export function makeDayDetail(overrides: Partial<Schemas['DayDetail']> = {}): Schemas['DayDetail'] {
  return {
    employee: ASHA,
    day: {
      id: 81,
      date: '2026-02-03',
      status: 'present',
      first_in_at: '2026-02-03T04:05:00Z',
      last_out_at: '2026-02-03T12:40:00Z',
      worked_minutes: 515,
      late_minutes: 0,
      overtime_minutes: 35,
      flags: [],
    },
    punches: [
      makePunchDetail(),
      makePunchDetail({
        id: 502,
        type: 'out',
        time: '2026-02-03T12:40:00Z',
        server_time: '2026-02-03T12:40:00Z',
        face_score: 0.66,
        selfie_url: '/api/v1/files/tok.out',
      }),
    ],
    overrides: [],
    ...overrides,
  };
}

export function makeRequest(
  overrides: Partial<Schemas['RequestItem']> = {},
): Schemas['RequestItem'] {
  return {
    id: 71,
    employee: ASHA,
    date: '2026-02-03',
    status: 'pending',
    requested_time: '2026-02-03T11:30:00Z',
    reason: 'Client site visit',
    created_at: '2026-02-03T11:31:00Z',
    expires_at: '2026-02-05T11:31:00Z',
    ...overrides,
  };
}

export function makeRequestDetail(
  overrides: Partial<Schemas['RequestDetail']> = {},
): Schemas['RequestDetail'] {
  return {
    ...makeRequest(),
    note: 'Visited the Cuttack depot',
    punched_in_at: '2026-02-03T04:05:00Z',
    lat: 20.4625,
    lng: 85.883,
    nearest_branch: 'Head Office',
    distance_m: 24500,
    accuracy_m: 14,
    face_decision: 'VERIFIED',
    face_score: 0.69,
    offline: false,
    review_reasons: [],
    selfie_url: '/api/v1/files/tok.request',
    first_approver: null,
    approver: null,
    approved_time: null,
    remarks: null,
    decided_at: null,
    can_decide: true,
    final_by_admin: false,
    ...overrides,
  };
}

export function makeReview(overrides: Partial<Schemas['ReviewItem']> = {}): Schemas['ReviewItem'] {
  return {
    id: 91,
    employee: ASHA,
    date: '2026-02-03',
    type: 'in',
    time: '2026-02-03T04:05:00Z',
    review_status: 'pending',
    review_reasons: ['face_mismatch'],
    face_decision: 'MISMATCH',
    face_score: 0.12,
    offline: false,
    ...overrides,
  };
}

export function makeReviewDetail(
  overrides: Partial<Schemas['ReviewDetail']> = {},
): Schemas['ReviewDetail'] {
  return {
    ...makeReview(),
    server_time: '2026-02-03T04:05:00Z',
    device_time: '2026-02-03T04:04:30Z',
    place: { type: 'branch', branch: 'Head Office', distance_m: 18 },
    accuracy_m: 11,
    integrity_flags: [],
    thresholds: { verify: 0.4, review: 0.3 },
    model_version: 'yunet-2023mar+sface-2021dec',
    selfie_url: '/api/v1/files/tok.review',
    reviewed_by: null,
    review_remarks: null,
    can_decide: true,
    ...overrides,
  };
}

export function makeException(
  overrides: Partial<Schemas['ExceptionItem']> = {},
): Schemas['ExceptionItem'] {
  return {
    id: 301,
    at: '2026-02-03T04:10:00Z',
    employee: ASHA,
    kind: 'OUTSIDE_GEOFENCE',
    nearest_branch: 'Head Office',
    distance_m: 1830,
    punch_event_id: null,
    details: null,
    ...overrides,
  };
}
