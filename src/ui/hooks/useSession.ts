import { useCallback, useEffect, useState } from 'react';
import { login, logout, me } from '../api/session';
import { ApiError } from '../api/client';
import type { AdminUser } from '../types/entries';

export type SessionStatus = 'checking' | 'guest' | 'admin';

interface SessionState {
  status: SessionStatus;
  user: AdminUser | null;
  error: Error | null;
}

export function useSession() {
  const [state, setState] = useState<SessionState>({ status: 'checking', user: null, error: null });

  const refresh = useCallback(async () => {
    setState((current) => ({ ...current, status: 'checking', error: null }));
    try {
      const user = await me();
      setState({ status: 'admin', user, error: null });
    } catch (error) {
      if (error instanceof ApiError && error.status === 401) {
        setState({ status: 'guest', user: null, error: null });
        return;
      }
      setState({ status: 'guest', user: null, error: error instanceof Error ? error : new Error('Session request failed') });
    }
  }, []);

  useEffect(() => {
    void refresh();
  }, [refresh]);

  const signIn = useCallback(async (username: string, password: string) => {
    try {
      const user = await login(username, password);
      setState({ status: 'admin', user, error: null });
      return user;
    } catch (error) {
      setState((current) => ({ ...current, error: error instanceof Error ? error : new Error('Sign in failed') }));
      throw error;
    }
  }, []);

  const signOut = useCallback(async () => {
    try {
      await logout();
      setState({ status: 'guest', user: null, error: null });
    } catch (error) {
      setState((current) => ({ ...current, error: error instanceof Error ? error : new Error('Sign out failed') }));
      throw error;
    }
  }, []);

  return { ...state, refresh, signIn, signOut };
}
