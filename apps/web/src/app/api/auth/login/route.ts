import { NextResponse, type NextRequest } from 'next/server';
import { z } from 'zod';
import {
  backendFetch,
  backendUnavailable,
  errorResponse,
  forwardedFor,
  isSameOrigin,
  setTokens,
  type Tokens,
} from '@/lib/server/bff';

const loginBody = z.object({
  identifier: z.string().min(1).max(64),
  password: z.string().min(1).max(128),
});

export async function POST(request: NextRequest) {
  if (!isSameOrigin(request)) {
    return errorResponse(403, 'FORBIDDEN', 'Cross-origin requests are not allowed.');
  }
  const parsed = loginBody.safeParse(await request.json().catch(() => null));
  if (!parsed.success) return errorResponse(422, 'VALIDATION_ERROR', 'Request validation failed.');

  let upstream: Response;
  try {
    upstream = await backendFetch('auth/login', {
      method: 'POST',
      headers: { 'content-type': 'application/json', ...forwardedFor(request) },
      body: JSON.stringify({ ...parsed.data, client: 'web' }),
    });
  } catch {
    return backendUnavailable();
  }
  if (!upstream.ok) {
    // Backend errors carry no secrets; pass the code (and lockout timing) through unchanged.
    return NextResponse.json(await upstream.json().catch(() => null), { status: upstream.status });
  }
  const tokens = (await upstream.json()) as Tokens;
  const response = NextResponse.json({ must_change_password: tokens.must_change_password });
  setTokens(response, tokens);
  return response;
}
