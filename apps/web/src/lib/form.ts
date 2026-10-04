import type { FieldValues, Path, UseFormSetError } from 'react-hook-form';
import { z } from 'zod';
import { rejectedFields } from '@/lib/api-client';

// Form values are strings (inputs); these mirror the server bounds so people get feedback early.
export const isIntBetween = (min: number, max: number) => (value: string) =>
  /^\d+$/.test(value.trim()) && Number(value) >= min && Number(value) <= max;

const isNumberBetween = (min: number, max: number) => (value: string) =>
  value.trim() !== '' && Number(value) >= min && Number(value) <= max;

export const RADIUS_MIN_M = 30;
export const RADIUS_MAX_M = 500;
const isRadius = isIntBetween(RADIUS_MIN_M, RADIUS_MAX_M);

export const radius = z.string().refine(isRadius, 'validation.radius');
/** Empty leaves the choice to the server (the organisation default from Settings). */
export const optionalRadius = z
  .string()
  .refine((v) => v.trim() === '' || isRadius(v), 'validation.radius');
export const latitude = z.string().refine(isNumberBetween(-90, 90), 'validation.latitude');
export const longitude = z.string().refine(isNumberBetween(-180, 180), 'validation.longitude');

/** The fields of `next` that differ from `previous`: the body of a partial update. */
export function changed<T extends object>(next: T, previous: T): Partial<T> {
  return Object.fromEntries(
    Object.entries(next).filter(
      ([key, value]) => JSON.stringify(value) !== JSON.stringify(previous[key as keyof T]),
    ),
  ) as Partial<T>;
}

/** Marks the inputs a 422 response names; form fields carry the API's field names. */
export function markRejected<T extends FieldValues>(
  error: unknown,
  values: T,
  setError: UseFormSetError<T>,
) {
  for (const name of rejectedFields(error)) {
    if (name in values) setError(name as Path<T>, { message: 'validation.rejected' });
  }
}
