import { randomBytes, randomInt } from 'node:crypto';
import { expect, type Page } from '@playwright/test';

export const API = 'http://127.0.0.1:8001/api/v1';

type Json = Record<string, unknown>;

async function call<T>(method: string, path: string, token?: string, body?: Json): Promise<T> {
  const response = await fetch(`${API}${path}`, {
    method,
    headers: {
      ...(body ? { 'Content-Type': 'application/json' } : {}),
      ...(token ? { Authorization: `Bearer ${token}` } : {}),
    },
    body: body ? JSON.stringify(body) : undefined,
  });
  if (!response.ok) {
    throw new Error(`${method} ${path} -> ${response.status} ${await response.text()}`);
  }
  return (response.status === 204 ? undefined : await response.json()) as T;
}

export type Tokens = {
  access_token: string;
  refresh_token: string;
  must_change_password: boolean;
};
export type Device = { device_id: string; model: string; os: string; app_version: string };
export type Counts = { pending: number; active: number; revoked: number };
export type Dashboard = {
  employees_total: number;
  employees_active: number;
  employees_inactive: number;
  pending_devices: number;
};
export type Created = { id: number; code: string; name: string; mobile: string; password: string };

export const apiLogin = (
  identifier: string,
  password: string,
  client: 'web' | 'mobile' = 'web',
  device?: Device,
) => call<Tokens>('POST', '/auth/login', undefined, { identifier, password, client, device });

export const changePassword = (token: string, current: string, next: string) =>
  call<Tokens>('POST', '/auth/change-password', token, {
    current_password: current,
    new_password: next,
  });

/** The ready-to-use Super Admin made by global setup (password change already done). */
export const readyAdmin = () => ({
  code: process.env.E2E_READY_ADMIN_CODE as string,
  password: process.env.E2E_READY_ADMIN_PASSWORD as string,
  name: process.env.E2E_READY_ADMIN_NAME as string,
});

export async function adminToken(): Promise<string> {
  const { code, password } = readyAdmin();
  return (await apiLogin(code, password)).access_token;
}

/** Ten digits starting with 9; the e2e database keeps users across runs, so draw a fresh one. */
export const uniqueMobile = () => `9${String(randomInt(0, 1_000_000_000)).padStart(9, '0')}`;

export const uniqueSuffix = () =>
  `${Date.now().toString(36).toUpperCase()}${randomBytes(2).toString('hex').toUpperCase()}`;

export async function createEmployee(
  token: string,
  name?: string,
  roleName = 'Office Employee',
): Promise<Created> {
  const [designations, roles] = await Promise.all([
    call<{ id: number }[]>('GET', '/admin/masters/designations', token),
    call<{ id: number; name: string }[]>('GET', '/admin/roles', token),
  ]);
  const role = roles.find((r) => r.name === roleName);
  if (!role || designations.length === 0) throw new Error('Seed roles or designations missing');

  const code = `EMP${uniqueSuffix()}`;
  const full = name ?? `E2E Employee ${code}`;
  const mobile = uniqueMobile();
  const created = await call<{
    employee: { id: number; mobile: string };
    temporary_password: string;
  }>('POST', '/admin/employees', token, {
    emp_code: code,
    name: full,
    mobile,
    designation_id: designations[0].id,
    role_id: role.id,
    joined_on: new Date().toISOString().slice(0, 10),
  });
  return {
    id: created.employee.id,
    code,
    name: full,
    mobile: created.employee.mobile,
    password: created.temporary_password,
  };
}

export const setEmployeeStatus = (token: string, id: number, status: 'active' | 'inactive') =>
  call('PATCH', `/admin/employees/${id}`, token, { status });

export const dashboard = (token: string) => call<Dashboard>('GET', '/admin/dashboard', token);

export const deviceCounts = async (token: string) =>
  (await call<{ counts: Counts }>('GET', '/admin/devices?limit=1', token)).counts;

export const sessionCounts = async (token: string) =>
  (
    await call<{ counts: { active: number; ended: number } }>(
      'GET',
      '/admin/sessions?limit=1',
      token,
    )
  ).counts;

/** HTTP status of trying to refresh with this token (401 once its session is over). */
export const refreshStatus = async (refreshToken: string) =>
  (
    await fetch(`${API}/auth/refresh`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ refresh_token: refreshToken }),
    })
  ).status;

export const listEmployees = (token: string, q: string) =>
  call<{ items: { emp_code: string }[] }>(
    'GET',
    `/admin/employees?q=${encodeURIComponent(q)}`,
    token,
  );

export async function uiLogin(page: Page, identifier: string, password: string) {
  await page.goto('/login');
  await page.getByLabel('Employee ID or mobile number').fill(identifier);
  await page.getByLabel('Password', { exact: true }).fill(password);
  await page.getByRole('button', { name: 'Sign in' }).click();
  await expect(page).toHaveURL(/localhost:3100\/$/);
}

export async function uiLoginAsReadyAdmin(page: Page) {
  const { code, password } = readyAdmin();
  await uiLogin(page, code, password);
}
