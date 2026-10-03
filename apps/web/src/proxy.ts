import { NextResponse, type NextRequest } from 'next/server';
import { REFRESH_COOKIE } from '@/lib/server/config';

// Optimistic check only (cookie present); the backend still authorises every request.
export function proxy(request: NextRequest) {
  if (!request.cookies.has(REFRESH_COOKIE)) {
    return NextResponse.redirect(new URL('/login', request.url));
  }
  return NextResponse.next();
}

// Skips the API routes, Next internals, /login and static files.
export const config = { matcher: ['/((?!api/|_next/|login$|.*\\.).*)'] };
