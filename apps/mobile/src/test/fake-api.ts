// Routes fetch by "METHOD /path" so screen tests can script backend answers.
type Handler = (request: Request) => Response | Promise<Response>;

export const calls: Request[] = [];

export function mockApi(routes: Record<string, Handler>) {
  calls.length = 0;
  jest.mocked(fetch).mockImplementation(async (input) => {
    const request = input as Request;
    calls.push(request.clone());
    const key = `${request.method} ${new URL(request.url).pathname}`;
    const handler = routes[key];
    if (!handler) throw new Error(`Unmocked request: ${key}`);
    return handler(request);
  });
}

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
