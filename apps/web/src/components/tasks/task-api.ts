import { toApiError, type Schemas } from '@/lib/api-client';

/** A fresh idempotency key: one per attempt at an action, kept for every retry of it. */
export const newKey = () => crypto.randomUUID();

const BASE = '/api/proxy/api/v1';

/**
 * A multipart POST (a brief, a comment photo) through the proxy. The typed client cannot send
 * files, and the browser sets the multipart boundary itself, so no content type is given.
 */
export async function postForm(
  path: string,
  form: FormData,
  key: string,
): Promise<Schemas['ActionOut']> {
  const response = await fetch(`${BASE}${path}`, {
    method: 'POST',
    headers: { 'Idempotency-Key': key },
    body: form,
  });
  const body: unknown = await response.json().catch(() => null);
  if (!response.ok) throw toApiError(response.status, body);
  return body as Schemas['ActionOut'];
}

/** The server accepts PDFs and images up to 10 MB, ten per task. */
export const BRIEF_MAX_BYTES = 10 * 1024 * 1024;
export const BRIEF_ACCEPT = 'application/pdf,image/*';
