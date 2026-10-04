'use client';

import { useState } from 'react';
import { zodResolver } from '@hookform/resolvers/zod';
import { useMutation, useQueryClient } from '@tanstack/react-query';
import { useForm } from 'react-hook-form';
import { useTranslation } from 'react-i18next';
import { Field } from '@/components/field';
import { Button } from '@/components/ui/button';
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogTitle,
} from '@/components/ui/dialog';
import { Input, Select } from '@/components/ui/input';
import { errorMessage, proxyApi, unwrap } from '@/lib/api-client';
import { todayIst } from '@/lib/ist';
import {
  createSchema,
  editSchema,
  emptyValues,
  toCreate,
  toUpdate,
  toValues,
  type Employee,
  type EmployeeValues,
} from './employee-form';
import type { Lookups } from './use-lookups';

export type TemporaryPassword = { empCode: string; name: string; password: string };

type Props = {
  employee?: Employee; // omitted: create
  lookups: Lookups;
  myPermissions: string[];
  onClose: () => void;
  onTemporaryPassword: (value: TemporaryPassword) => void;
};

function Options({ items }: { items: { id: number; name: string }[] }) {
  return items.map((item) => (
    <option key={item.id} value={item.id}>
      {item.name}
    </option>
  ));
}

export function EmployeeDialog({
  employee,
  lookups,
  myPermissions,
  onClose,
  onTemporaryPassword,
}: Props) {
  const { t } = useTranslation();
  const queryClient = useQueryClient();
  const [serverError, setServerError] = useState<string | null>(null);
  const {
    register,
    handleSubmit,
    formState: { errors },
  } = useForm<EmployeeValues>({
    resolver: zodResolver(employee ? editSchema : createSchema),
    defaultValues: employee ? toValues(employee, todayIst()) : emptyValues(todayIst()),
  });

  // gcTime 0: the create response holds a one-time password and must not linger in the cache.
  const save = useMutation({
    gcTime: 0,
    mutationFn: async (values: EmployeeValues) => {
      const api = proxyApi();
      if (employee) {
        const body = toUpdate(values, employee);
        if (Object.keys(body).length > 0) {
          await unwrap(
            api.PATCH('/api/v1/admin/employees/{employee_id}', {
              params: { path: { employee_id: employee.id } },
              body,
            }),
          );
        }
        return null;
      }
      return unwrap(api.POST('/api/v1/admin/employees', { body: toCreate(values) }));
    },
  });

  async function onSubmit(values: EmployeeValues) {
    setServerError(null);
    try {
      const created = await save.mutateAsync(values);
      save.reset();
      await queryClient.invalidateQueries({ queryKey: ['employees'] });
      if (created?.temporary_password) {
        onTemporaryPassword({
          empCode: created.employee.emp_code,
          name: created.employee.name,
          password: created.temporary_password,
        });
      }
      onClose();
    } catch (error) {
      setServerError(errorMessage(t, error));
    }
  }

  // The server enforces which roles may be assigned; this only hides roles above one's own access.
  const roles = (lookups.roles ?? []).filter(
    (role) =>
      role.id === employee?.role.id || role.permissions.every((p) => myPermissions.includes(p)),
  );
  const managers = (lookups.employees ?? []).filter(
    (e) => e.status === 'active' && e.id !== employee?.id,
  );
  const field = (name: keyof EmployeeValues) => ({ invalid: !!errors[name], ...register(name) });

  return (
    <Dialog open onOpenChange={(open) => !open && onClose()}>
      <DialogContent className="max-w-2xl">
        <DialogTitle>
          {employee ? t('employees.editTitle') : t('employees.createTitle')}
        </DialogTitle>
        <DialogDescription>
          {employee ? employee.emp_code : t('employees.createHint')}
        </DialogDescription>
        <form onSubmit={handleSubmit(onSubmit)} noValidate className="grid gap-4">
          <div className="grid gap-4 sm:grid-cols-2">
            {!employee && (
              <Field
                id="emp_code"
                label={t('employees.form.empCode')}
                error={errors.emp_code?.message}
              >
                <Input id="emp_code" {...field('emp_code')} />
              </Field>
            )}
            <Field id="name" label={t('employees.form.name')} error={errors.name?.message}>
              <Input id="name" {...field('name')} />
            </Field>
            <Field id="mobile" label={t('employees.form.mobile')} error={errors.mobile?.message}>
              <Input id="mobile" type="tel" {...field('mobile')} />
            </Field>
            <Field id="email" label={t('employees.form.email')} error={errors.email?.message}>
              <Input id="email" type="email" {...field('email')} />
            </Field>
            <Field
              id="designation_id"
              label={t('employees.form.designation')}
              error={errors.designation_id?.message}
            >
              <Select id="designation_id" {...field('designation_id')}>
                <option value="">{t('common.select')}</option>
                <Options items={lookups.designations ?? []} />
              </Select>
            </Field>
            <Field
              id="department_id"
              label={t('employees.form.department')}
              error={errors.department_id?.message}
            >
              <Select id="department_id" {...field('department_id')}>
                <option value="">{t('common.none')}</option>
                <Options items={lookups.departments ?? []} />
              </Select>
            </Field>
            <Field id="role_id" label={t('employees.form.role')} error={errors.role_id?.message}>
              <Select id="role_id" {...field('role_id')}>
                <option value="">{t('common.select')}</option>
                <Options items={roles} />
              </Select>
            </Field>
            <Field
              id="manager_id"
              label={t('employees.form.manager')}
              error={errors.manager_id?.message}
            >
              <Select id="manager_id" {...field('manager_id')}>
                <option value="">{t('common.none')}</option>
                <Options items={managers} />
              </Select>
            </Field>
            <Field
              id="joined_on"
              label={t('employees.form.joinedOn')}
              error={errors.joined_on?.message}
            >
              <Input id="joined_on" type="date" {...field('joined_on')} />
            </Field>
            {!employee && (
              <Field
                id="password"
                label={t('employees.form.password')}
                error={errors.password?.message}
              >
                <Input
                  id="password"
                  type="password"
                  autoComplete="new-password"
                  {...field('password')}
                />
                <span className="text-xs text-muted-foreground">
                  {t('employees.form.passwordHint')}
                </span>
              </Field>
            )}
          </div>
          <label className="flex items-center gap-2 text-sm">
            <input type="checkbox" {...register('field_eligible')} />
            {t('employees.form.fieldEligible')}
          </label>
          {serverError && (
            <p role="alert" className="text-sm text-destructive">
              {serverError}
            </p>
          )}
          <DialogFooter>
            <Button type="button" variant="outline" onClick={onClose}>
              {t('common.cancel')}
            </Button>
            <Button type="submit" disabled={save.isPending}>
              {t('common.save')}
            </Button>
          </DialogFooter>
        </form>
      </DialogContent>
    </Dialog>
  );
}
