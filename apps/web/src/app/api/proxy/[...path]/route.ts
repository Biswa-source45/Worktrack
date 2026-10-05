import type { NextRequest } from 'next/server';
import {
  backendUnavailable,
  errorResponse,
  expired,
  finish,
  forward,
  isSameOrigin,
  toResponse,
} from '@/lib/server/bff';

// Only the endpoints the admin portal uses; everything else stays unreachable from the browser.
const ALLOWED = [/^me$/, /^admin(\/|$)/, /^employees\/team$/, /^(branches|shifts)$/];

// The typed client's paths already start with /api/v1, so the proxy URL mirrors them.
function backendPath(segments: string[]): string | null {
  if (segments[0] !== 'api' || segments[1] !== 'v1') return null;
  const rest = segments.slice(2);
  // Decoded segments could smuggle '..' or '/' into the backend URL.
  if (rest.some((s) => s === '' || s === '.' || s === '..' || /[/\\]/.test(s))) return null;
  const path = rest.join('/');
  return ALLOWED.some((pattern) => pattern.test(path)) ? path : null;
}

async function handle(request: NextRequest, context: { params: Promise<{ path: string[] }> }) {
  const path = backendPath((await context.params).path);
  if (path === null) return errorResponse(404, 'NOT_FOUND', 'Not found.');
  if (request.method !== 'GET' && !isSameOrigin(request)) {
    return errorResponse(403, 'FORBIDDEN', 'Cross-origin requests are not allowed.');
  }
  const hasBody = request.method !== 'GET' && request.method !== 'HEAD';
  // Read once so a retry after token refresh can resend it; multipart bytes pass through untouched.
  const body = hasBody ? await request.arrayBuffer() : undefined;
  try {
    const forwarded = await forward(request, `${path}${request.nextUrl.search}`, {
      method: request.method,
      body,
    });
    if (!forwarded.upstream) return expired();
    const response = toResponse(forwarded.upstream, await forwarded.upstream.arrayBuffer());
    return finish(response, forwarded);
  } catch {
    return backendUnavailable();
  }
}

export { handle as GET, handle as POST, handle as PATCH, handle as PUT, handle as DELETE };
