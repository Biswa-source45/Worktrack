import { useQuery } from '@tanstack/react-query';
import { proxyApi, unwrap } from '@/lib/api-client';

const master = (kind: 'departments' | 'designations') => ({
  queryKey: ['masters', kind],
  queryFn: () =>
    unwrap(proxyApi().GET('/api/v1/admin/masters/{kind}', { params: { path: { kind } } })),
});

// Options for the employee form and the manager column. A company of ~35 people fits in one page.
export function useLookups() {
  const roles = useQuery({
    queryKey: ['roles'],
    queryFn: () => unwrap(proxyApi().GET('/api/v1/admin/roles')),
  });
  const designations = useQuery(master('designations'));
  const departments = useQuery(master('departments'));
  const everyone = useQuery({
    queryKey: ['employees', 'all'],
    queryFn: async () =>
      (
        await unwrap(
          proxyApi().GET('/api/v1/admin/employees', { params: { query: { limit: 200 } } }),
        )
      ).items,
  });
  // Names of the active branches and shifts, open to anyone who manages employees.
  const branches = useQuery({
    queryKey: ['branches', 'names'],
    queryFn: () => unwrap(proxyApi().GET('/api/v1/branches')),
  });
  const shifts = useQuery({
    queryKey: ['shifts', 'names'],
    queryFn: () => unwrap(proxyApi().GET('/api/v1/shifts')),
  });
  return {
    roles: roles.data,
    designations: designations.data,
    departments: departments.data,
    employees: everyone.data,
    branches: branches.data,
    shifts: shifts.data,
  };
}

export type Lookups = ReturnType<typeof useLookups>;
