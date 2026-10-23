import { createContext, useCallback, useContext, useEffect, useMemo } from 'react';
import { useLocation, useNavigate } from 'react-router-dom';
import { useQuery, useQueryClient } from '@tanstack/react-query';

import { api, ApiError, SESSION_EXPIRED_PATH, onUnauthorized } from '../api/client.js';

const AuthContext = createContext(null);

export const SESSION_QUERY_KEY = ['session'];

/**
 * Session bootstrap + the three auth mutations.
 *
 * The cookie is HttpOnly, so this context is the only place that knows whether
 * anyone is signed in: on mount it asks /auth/session, and every 401 from any
 * other request funnels back through `onUnauthorized` to clear the user.
 */
export function AuthProvider({ children }) {
  const queryClient = useQueryClient();
  const navigate = useNavigate();
  const location = useLocation();

  const sessionQuery = useQuery({
    queryKey: SESSION_QUERY_KEY,
    queryFn: async () => {
      try {
        const data = await api.get('/auth/session');
        return data?.user ?? null;
      } catch (error) {
        // "Not signed in" is a normal state, not a failure to report.
        if (error instanceof ApiError && error.isUnauthorized) return null;
        throw error;
      }
    },
    staleTime: 60_000,
  });

  const setUser = useCallback(
    (user) => {
      queryClient.setQueryData(SESSION_QUERY_KEY, user);
      // Runs are scoped to the user; never show the previous account's data.
      queryClient.removeQueries({ queryKey: ['runs'] });
      queryClient.removeQueries({ queryKey: ['run'] });
      queryClient.removeQueries({ queryKey: ['system'] });
    },
    [queryClient],
  );

  // A 401 anywhere in the app means the session died: drop the user and send
  // them to the "session expired" screen, which is friendlier than a silent
  // bounce back to a login form they never left.
  useEffect(() => {
    return onUnauthorized(() => {
      queryClient.setQueryData(SESSION_QUERY_KEY, null);
      const onAuthScreen =
        location.pathname === '/login' || location.pathname === '/register';
      if (!onAuthScreen) {
        navigate(SESSION_EXPIRED_PATH, {
          replace: true,
          state: { from: location.pathname + location.search },
        });
      }
    });
  }, [navigate, location.pathname, location.search, queryClient]);

  const login = useCallback(
    async ({ email, password }) => {
      const data = await api.post('/auth/login', { email, password });
      setUser(data?.user ?? null);
      return data?.user ?? null;
    },
    [setUser],
  );

  const register = useCallback(
    async ({ email, password }) => {
      const data = await api.post('/auth/register', { email, password });
      setUser(data?.user ?? null);
      return data?.user ?? null;
    },
    [setUser],
  );

  const logout = useCallback(async () => {
    try {
      await api.post('/auth/logout', undefined);
    } finally {
      // The cookie is cleared server-side; either way the local session ends.
      setUser(null);
      queryClient.clear();
      navigate('/login', { replace: true });
    }
  }, [navigate, queryClient, setUser]);

  const value = useMemo(
    () => ({
      user: sessionQuery.data ?? null,
      isAuthenticated: Boolean(sessionQuery.data),
      isLoading: sessionQuery.isLoading,
      error: sessionQuery.error ?? null,
      login,
      register,
      logout,
      refetchSession: sessionQuery.refetch,
    }),
    [sessionQuery.data, sessionQuery.isLoading, sessionQuery.error, sessionQuery.refetch, login, register, logout],
  );

  return <AuthContext.Provider value={value}>{children}</AuthContext.Provider>;
}

export function useAuth() {
  const context = useContext(AuthContext);
  if (!context) throw new Error('useAuth must be used inside <AuthProvider>');
  return context;
}