import { NextResponse, type NextRequest } from 'next/server';
import { REFRESH_COOKIE } from '@/lib/server/config';
import {
  backendFetch,
  clearTokens,
  errorResponse,
  forwardedFor,
  isSameOrigin,
} from '@/lib/server/bff';

export async function POST(request: NextRequest) {
  if (!isSameOrigin(request)) {
    return errorResponse(403, 'FORBIDDEN', 'Cross-origin requests are not allowed.');
  }
  const refresh = request.cookies.get(REFRESH_COOKIE)?.value;
  if (refresh) {
    // Best effort: the local session ends even when the backend cannot be reached; the backend
    // token then simply expires on its own.
    await backendFetch('auth/logout', {
      method: 'POST',
      headers: { 'content-type': 'application/json', ...forwardedFor(request) },
      body: JSON.stringify({ refresh_token: refresh }),
    }).catch(() => null);
  }
  const response = new NextResponse(null, { status: 204 });
  clearTokens(response);
  return response;
}
