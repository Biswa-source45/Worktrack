import { randomBytes, randomInt, randomUUID } from 'node:crypto';
import { readFileSync } from 'node:fs';
import path from 'node:path';
import { expect, type Locator, type Page } from '@playwright/test';

export const API = 'http://127.0.0.1:8001/api/v1';

type Json = Record<string, unknown>;

/** One call to the e2e backend's API; throws on any non-2xx answer. */
export async function api<T = unknown>(
  method: string,
  path: string,
  token?: string,
  body?: Json,
): Promise<T> {
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
) => api<Tokens>('POST', '/auth/login', undefined, { identifier, password, client, device });

export const changePassword = (token: string, current: string, next: string) =>
  api<Tokens>('POST', '/auth/change-password', token, {
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
  extra: Json = {},
): Promise<Created> {
  const [designations, roles] = await Promise.all([
    api<{ id: number }[]>('GET', '/admin/masters/designations', token),
    api<{ id: number; name: string }[]>('GET', '/admin/roles', token),
  ]);
  const role = roles.find((r) => r.name === roleName);
  if (!role || designations.length === 0) throw new Error('Seed roles or designations missing');

  const code = `EMP${uniqueSuffix()}`;
  const full = name ?? `E2E Employee ${code}`;
  const mobile = uniqueMobile();
  const created = await api<{
    employee: { id: number; mobile: string };
    temporary_password: string;
  }>('POST', '/admin/employees', token, {
    emp_code: code,
    name: full,
    mobile,
    designation_id: designations[0].id,
    role_id: role.id,
    joined_on: new Date().toISOString().slice(0, 10),
    ...extra,
  });
  return {
    id: created.employee.id,
    code,
    name: full,
    mobile: created.employee.mobile,
    password: created.temporary_password,
  };
}

// Public-domain, computer-generated faces (see the SOURCES.md next to them). Person A is the one
// who enrolls (sent three times); a selfie of person B is a stranger to the enrolled face.
const FACES = path.resolve(__dirname, '../../backend/tests/fixtures/face');
const FACE_PHOTO = path.join(FACES, 'person_a.jpg');

/** The employee signed in on their first phone (approved at once) after the forced password change. */
export async function employeeOnPhone(employee: Created): Promise<string> {
  const phone: Device = {
    device_id: `e2e-face-${employee.code}`.toLowerCase(),
    model: 'Pixel 8',
    os: 'Android 14',
    app_version: '1.0.0',
  };
  const first = await apiLogin(employee.code, employee.password, 'mobile', phone);
  const password = 'E2e-Employee-Pass-9';
  await changePassword(first.access_token, employee.password, password);
  return (await apiLogin(employee.code, password, 'mobile', phone)).access_token;
}

/** Accepts the notice and sends three photos, as the app does: the enrollment waits for review. */
export async function enrollFace(token: string) {
  await api('POST', '/me/face-enrollment/consent', token);
  const form = new FormData();
  const bytes = readFileSync(FACE_PHOTO);
  for (let n = 1; n <= 3; n++) {
    form.append('photos', new Blob([bytes], { type: 'image/jpeg' }), `photo-${n}.jpg`);
  }
  const response = await fetch(`${API}/me/face-enrollment`, {
    method: 'POST',
    headers: { Authorization: `Bearer ${token}` },
    body: form,
  });
  if (!response.ok) throw new Error(`enroll -> ${response.status} ${await response.text()}`);
}

/** The admin approves the enrollment the employee just sent, naming the photos it saw. */
export async function approveFace(token: string, employeeId: number) {
  const list = await api<{
    items: { id: number; submitted_at: string; employee: { id: number } }[];
  }>('GET', '/admin/face-enrollments?limit=200', token);
  const mine = list.items.find((item) => item.employee.id === employeeId);
  if (!mine) throw new Error(`No face enrollment is waiting for employee ${employeeId}`);
  await api('POST', `/admin/face-enrollments/${mine.id}/approve`, token, {
    submitted_at: mine.submitted_at,
  });
}

export const myFaceEnrollment = (token: string) =>
  api<{ status: string; reason: string | null }>('GET', '/me/face-enrollment', token);

export const setEmployeeStatus = (token: string, id: number, status: 'active' | 'inactive') =>
  api('PATCH', `/admin/employees/${id}`, token, { status });

export const dashboard = (token: string) => api<Dashboard>('GET', '/admin/dashboard', token);

export const deviceCounts = async (token: string) =>
  (await api<{ counts: Counts }>('GET', '/admin/devices?limit=1', token)).counts;

export const sessionCounts = async (token: string) =>
  (
    await api<{ counts: { active: number; ended: number } }>(
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
  api<{ items: { emp_code: string }[] }>(
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

// A 1x1 light grey PNG stands in for every map tile, so no run depends on the tile server.
const BLANK_TILE = Buffer.from(
  'iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAIAAACQd1PeAAAADElEQVR4nGO4c/MSAAUcAoi4e3lxAAAAAElFTkSuQmCC',
  'base64',
);

export const stubMapTiles = (page: Page) =>
  page.route('https://tile.openstreetmap.org/**', (route) =>
    route.fulfill({ contentType: 'image/png', body: BLANK_TILE }),
  );

export type Place = { name: string; lat: number; lng: number; shiftId: number };

/**
 * A branch at coordinates no other run uses (the e2e database keeps branches across runs, and a
 * punch is placed at the nearest one) and a shift with no weekly off, so any day is a working day.
 */
export async function createPlace(token: string): Promise<Place> {
  const suffix = uniqueSuffix();
  const lat = 8 + randomInt(0, 25_000) / 1000;
  const lng = 70 + randomInt(0, 25_000) / 1000;
  const name = `E2E Attendance ${suffix}`;
  await api('POST', '/admin/branches', token, { name, lat, lng, radius_m: 200 });
  const shift = await api<{ id: number }>('POST', '/admin/shifts', token, {
    name: `E2E Shift ${suffix}`,
    start_time: '09:00',
    end_time: '18:00',
    grace_min: 10,
    half_day_hours: 4,
    full_day_hours: 8,
    weekly_offs: [],
  });
  return { name, lat, lng, shiftId: shift.id };
}

/** Where the branch is: a punch from here is accepted. */
export const atBranch = (place: Place) => ({ lat: place.lat, lng: place.lng });
/** About 5.5 km north of the branch: well outside the 200 m fence. */
export const awayFrom = (place: Place) => ({ lat: place.lat + 0.05, lng: place.lng });

export type Worker = { employee: Created; phone: string };

/**
 * An employee on the place's shift, on an approved phone, with an approved face: ready to punch.
 */
export async function createWorker(token: string, place: Place, name?: string): Promise<Worker> {
  const employee = await createEmployee(token, name, 'Office Employee', {
    shift_id: place.shiftId,
  });
  const phone = await employeeOnPhone(employee);
  await enrollFace(phone);
  await approveFace(token, employee.id);
  return { employee, phone };
}

export type Punched = {
  punch: { id: number; time: string; review_status: string };
  result: 'verified' | 'in_review';
};

/** One punch, as the app sends it: the selfie, the position and an Idempotency-Key. */
export async function sendPunch(
  phone: string,
  kind: 'punch-in' | 'punch-out' | 'punch-out-requests',
  fix: { lat: number; lng: number },
  options: { face?: 'a' | 'b'; reason?: string } = {},
): Promise<Response> {
  const form = new FormData();
  const photo = readFileSync(
    path.join(FACES, options.face === 'b' ? 'person_b.jpg' : 'person_a.jpg'),
  );
  form.append('selfie', new Blob([photo], { type: 'image/jpeg' }), 'selfie.jpg');
  form.append('lat', String(fix.lat));
  form.append('lng', String(fix.lng));
  form.append('accuracy_m', '10');
  form.append('device_time', new Date().toISOString());
  if (options.reason) form.append('reason', options.reason);
  return fetch(`${API}/attendance/${kind}`, {
    method: 'POST',
    headers: { Authorization: `Bearer ${phone}`, 'Idempotency-Key': randomUUID() },
    body: form,
  });
}

/** A punch that must be accepted (verified or waiting for review). */
export async function punchOk(...args: Parameters<typeof sendPunch>): Promise<Punched> {
  const response = await sendPunch(...args);
  if (!response.ok) throw new Error(`${args[1]} -> ${response.status} ${await response.text()}`);
  return (await response.json()) as Punched;
}

/** The IST wall-clock minute (YYYY-MM-DDTHH:mm) at or just after `iso`, and when it has begun. */
export function nextIstMinute(iso: string) {
  const ms = Math.ceil(Date.parse(iso) / 60_000) * 60_000;
  return { at: ms, local: new Date(ms + 330 * 60_000).toISOString().slice(0, 16) };
}

/** The selfies come through the portal's proxy with a signed link: every image must load. */
export async function expectImagesLoaded(images: Locator) {
  await expect
    .poll(() =>
      images.evaluateAll(
        (all) => all.length > 0 && all.every((i) => (i as HTMLImageElement).naturalWidth > 0),
      ),
    )
    .toBe(true);
}

export type Asker = { worker: Worker; punchedInAt: string; requestId: number };

/** An employee who punched in at the branch, then asked to punch out from 5.5 km away. */
export async function createWaitingRequest(
  token: string,
  place: Place,
  name?: string,
): Promise<Asker> {
  const worker = await createWorker(token, place, name);
  const punchedIn = await punchOk(worker.phone, 'punch-in', atBranch(place));
  await punchOk(worker.phone, 'punch-out-requests', awayFrom(place), {
    reason: 'Client site visit',
  });
  const waiting = await api<{ items: { id: number; employee: { id: number } }[] }>(
    'GET',
    '/admin/punch-out-requests?limit=200',
    token,
  );
  const mine = waiting.items.find((item) => item.employee.id === worker.employee.id);
  if (!mine) throw new Error('The punch-out request is not waiting');
  return { worker, punchedInAt: punchedIn.punch.time, requestId: mine.id };
}
