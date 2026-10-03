import { NextResponse, type NextRequest } from 'next/server';
import {
  backendUnavailable,
  errorResponse,
  expired,
  finish,
  forward,
  isSameOrigin,
  setTokens,
  toResponse,
  type Tokens,
} from '@/lib/server/bff';

export async function POST(request: NextRequest) {
  if (!isSameOrigin(request)) {
    return errorResponse(403, 'FORBIDDEN', 'Cross-origin requests are not allowed.');
  }
  const body = await request.arrayBuffer();
  try {
    const forwarded = await forward(request, 'auth/change-password', { method: 'POST', body });
    if (!forwarded.upstream) return expired();
    const { upstream } = forwarded;
    if (!upstream.ok) return finish(toResponse(upstream, await upstream.arrayBuffer()), forwarded);
    // The backend revokes every old token on a password change and issues a new pair.
    const tokens = (await upstream.json()) as Tokens;
    const response = NextResponse.json({ must_change_password: tokens.must_change_password });
    setTokens(response, tokens);
    return response;
  } catch {
    return backendUnavailable();
  }
}
