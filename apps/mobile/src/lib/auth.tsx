import { useQuery, useQueryClient } from '@tanstack/react-query';
import type { components } from 'api-types';
import { createContext, useCallback, useContext, useEffect, useMemo, useState } from 'react';
import type { ReactNode } from 'react';
import { api, setSessionExpiredHandler } from './api';
import { clearTokens, getTokens, setTokens } from './token-store';

type TokenResponse = components['schemas']['TokenResponse'];
export type Me = components['schemas']['MeResponse'];
export type AuthStatus = 'loading' | 'signedOut' | 'signedIn';

type AuthValue = {
  status: AuthStatus;
  me: Me | undefined;
  meError: boolean;
  /** Stores a fresh token pair (login or password change) and reloads /me. */
  signIn: (tokens: TokenResponse) => Promise<void>;
  signOut: () => Promise<void>;
  refetchMe: () => Promise<void>;
};

const AuthContext = createContext<AuthValue | null>(null);

async function fetchMe() {
  const { data, response } = await api.GET('/api/v1/me');
  if (!data) throw new Error(`GET /me failed: ${response.status}`);
  return data;
}

/** Only decides what the app offers; the server checks the permission on every call. */
export const can = (me: Me | undefined, permission: string) =>
  me?.permissions.includes(permission) ?? false;

/** Which route group the signed-in state allows; the root layout turns these into route guards. */
export function sessionGuards(status: AuthStatus, me: Me | undefined) {
  const signedIn = status === 'signedIn';
  const mustChange = signedIn && me?.must_change_password === true;
  return {
    loading: status === 'loading',
    signedOut: status === 'signedOut',
    mustChange,
    ready: signedIn && !mustChange,
  };
}

export function AuthProvider({ children }: { children: ReactNode }) {
  const queryClient = useQueryClient();
  // null until SecureStore has been read.
  const [hasTokens, setHasTokens] = useState<boolean | null>(null);

  const expire = useCallback(() => {
    queryClient.clear();
    setHasTokens(false);
  }, [queryClient]);

  useEffect(() => {
    setSessionExpiredHandler(expire);
    void getTokens().then((tokens) => setHasTokens(tokens !== null));
  }, [expire]);

  const meQuery = useQuery({
    queryKey: ['me'],
    queryFn: fetchMe,
    enabled: hasTokens === true,
    retry: false,
  });

  const signIn = useCallback(
    async (tokens: TokenResponse) => {
      await setTokens({ access: tokens.access_token, refresh: tokens.refresh_token });
      await queryClient.invalidateQueries({ queryKey: ['me'] });
      setHasTokens(true);
    },
    [queryClient],
  );

  const signOut = useCallback(async () => {
    const tokens = await getTokens();
    try {
      if (tokens)
        await api.POST('/api/v1/auth/logout', { body: { refresh_token: tokens.refresh } });
    } catch {
      // Offline: sign out locally anyway; the server session simply expires on its own.
    }
    await clearTokens();
    expire();
  }, [expire]);

  const refetchMe = useCallback(async () => {
    await meQuery.refetch();
  }, [meQuery]);

  let status: AuthStatus = 'signedIn';
  if (hasTokens === null || (hasTokens && meQuery.isPending)) status = 'loading';
  else if (!hasTokens) status = 'signedOut';

  const value = useMemo(
    () => ({ status, me: meQuery.data, meError: meQuery.isError, signIn, signOut, refetchMe }),
    [status, meQuery.data, meQuery.isError, signIn, signOut, refetchMe],
  );
  return <AuthContext.Provider value={value}>{children}</AuthContext.Provider>;
}

export function useAuth(): AuthValue {
  const value = useContext(AuthContext);
  if (!value) throw new Error('useAuth must be used inside AuthProvider');
  return value;
}
