import { z } from 'zod';
import type { Schemas } from '@/lib/api-client';

export type Employee = Schemas['EmployeeOut'];

// These mirror the server rules so people get feedback early; the server remains the authority.
const EMP_CODE = /^[A-Za-z0-9][A-Za-z0-9_\-/]{0,31}$/;
const MOBILE = /^\+?\d{10,15}$/;
const EMAIL = /^[^@\s]+@[^@\s]+\.[^@\s]+$/;

export const stripMobile = (value: string) => value.replace(/[\s\-()]/g, '');

const base = {
  name: z.string().trim().min(1, 'validation.required').max(120, 'validation.tooLong'),
  mobile: z.string().refine((v) => MOBILE.test(stripMobile(v)), 'validation.mobile'),
  email: z
    .string()
    .trim()
    .refine((v) => v === '' || (EMAIL.test(v) && v.length <= 254), 'validation.email'),
  designation_id: z.string().min(1, 'validation.required'),
  department_id: z.string(),
  role_id: z.string().min(1, 'validation.required'),
  manager_id: z.string(),
  joined_on: z.string().min(1, 'validation.required'),
  field_eligible: z.boolean(),
  field_punch_in_allowed: z.boolean(),
  home_branch_id: z.string(),
  shift_id: z.string(),
  restrict_to_home_branch: z.boolean(),
};

export const createSchema = z.object({
  ...base,
  emp_code: z.string().trim().regex(EMP_CODE, 'validation.empCode'),
  // Empty means the server generates a temporary password.
  password: z
    .string()
    .refine((v) => v === '' || (v.length >= 10 && v.length <= 128), 'validation.passwordLength'),
});

// The employee code and password cannot be edited, so they are not validated here.
export const editSchema = z.object({ ...base, emp_code: z.string(), password: z.string() });

export type EmployeeValues = z.infer<typeof createSchema>;

export function toValues(employee: Employee, today: string): EmployeeValues {
  return {
    emp_code: employee.emp_code,
    name: employee.name,
    mobile: employee.mobile,
    email: employee.email ?? '',
    designation_id: String(employee.designation.id),
    department_id: employee.department ? String(employee.department.id) : '',
    role_id: String(employee.role.id),
    manager_id: employee.manager_id === null ? '' : String(employee.manager_id),
    joined_on: employee.joined_on || today,
    field_eligible: employee.field_eligible,
    field_punch_in_allowed: employee.field_punch_in_allowed,
    home_branch_id: employee.home_branch ? String(employee.home_branch.id) : '',
    shift_id: employee.shift ? String(employee.shift.id) : '',
    restrict_to_home_branch: employee.restrict_to_home_branch,
    password: '',
  };
}

export const emptyValues = (today: string): EmployeeValues => ({
  emp_code: '',
  name: '',
  mobile: '',
  email: '',
  designation_id: '',
  department_id: '',
  role_id: '',
  manager_id: '',
  joined_on: today,
  field_eligible: false,
  field_punch_in_allowed: false,
  home_branch_id: '',
  shift_id: '',
  restrict_to_home_branch: false,
  password: '',
});

const optionalId = (value: string) => (value === '' ? null : Number(value));

export function toCreate(v: EmployeeValues): Schemas['EmployeeCreate'] {
  return {
    emp_code: v.emp_code.trim(),
    name: v.name.trim(),
    mobile: stripMobile(v.mobile),
    email: v.email.trim() || null,
    designation_id: Number(v.designation_id),
    department_id: optionalId(v.department_id),
    role_id: Number(v.role_id),
    manager_id: optionalId(v.manager_id),
    joined_on: v.joined_on,
    field_eligible: v.field_eligible,
    home_branch_id: optionalId(v.home_branch_id),
    shift_id: optionalId(v.shift_id),
    // The restriction means nothing without a home branch.
    restrict_to_home_branch: v.home_branch_id !== '' && v.restrict_to_home_branch,
    password: v.password || null,
  };
}

// Only changed fields are sent: the server rejects any mention of role or status on one's own
// account, even when the value is the same.
export function toUpdate(v: EmployeeValues, e: Employee): Schemas['EmployeeUpdate'] {
  const next = toCreate(v);
  const update: Schemas['EmployeeUpdate'] = {};
  if (next.name !== e.name) update.name = next.name;
  if (next.mobile !== e.mobile) update.mobile = next.mobile;
  if (next.email !== e.email) update.email = next.email;
  if (next.designation_id !== e.designation.id) update.designation_id = next.designation_id;
  if (next.department_id !== (e.department?.id ?? null)) update.department_id = next.department_id;
  if (next.role_id !== e.role.id) update.role_id = next.role_id;
  if (next.manager_id !== e.manager_id) update.manager_id = next.manager_id;
  if (next.joined_on !== e.joined_on) update.joined_on = next.joined_on;
  if (next.field_eligible !== e.field_eligible) update.field_eligible = next.field_eligible;
  if (v.field_punch_in_allowed !== e.field_punch_in_allowed) {
    update.field_punch_in_allowed = v.field_punch_in_allowed;
  }
  if (next.home_branch_id !== (e.home_branch?.id ?? null))
    update.home_branch_id = next.home_branch_id;
  if (next.shift_id !== (e.shift?.id ?? null)) update.shift_id = next.shift_id;
  if (next.restrict_to_home_branch !== e.restrict_to_home_branch)
    update.restrict_to_home_branch = next.restrict_to_home_branch;
  return update;
}
