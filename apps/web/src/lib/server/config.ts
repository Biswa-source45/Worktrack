export const ACCESS_COOKIE = 'wt_access';
export const REFRESH_COOKIE = 'wt_refresh';

// Server-side only: the browser never learns the backend address.
export function apiUrl(): string {
  return process.env.API_URL ?? process.env.NEXT_PUBLIC_API_URL ?? 'http://localhost:8000';
}

// Both cookies live as long as a refresh token (backend refresh_token_days default). An expired
// access token is replaced through /auth/refresh; a refresh token the backend rejects clears both.
const SESSION_SECONDS = 30 * 24 * 60 * 60;

export function cookieOptions(maxAge = SESSION_SECONDS) {
  return {
    httpOnly: true,
    sameSite: 'strict' as const,
    secure: process.env.NODE_ENV === 'production',
    path: '/',
    maxAge,
  };
}
