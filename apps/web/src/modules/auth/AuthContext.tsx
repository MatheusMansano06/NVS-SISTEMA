import { createContext, useCallback, useContext, useEffect, useMemo, useState, type ReactNode } from 'react';
import type { SessionDto } from '@nvs/shared';
import { authApi } from './auth-api';

interface AuthState {
  session: SessionDto | null;
  loading: boolean;
  setSession: (s: SessionDto | null) => void;
  logout: () => Promise<void>;
}

const Ctx = createContext<AuthState | null>(null);

export function AuthProvider({ children }: { children: ReactNode }) {
  const [session, setSession] = useState<SessionDto | null>(null);
  const [loading, setLoading] = useState(true);

  useEffect(() => {
    let alive = true;
    authApi
      .me()
      .then((s) => alive && setSession(s))
      .catch(() => undefined)
      .finally(() => alive && setLoading(false));
    return () => {
      alive = false;
    };
  }, []);

  const logout = useCallback(async () => {
    await authApi.logout().catch(() => undefined);
    setSession(null);
  }, []);

  const value = useMemo(() => ({ session, loading, setSession, logout }), [session, loading, logout]);
  return <Ctx.Provider value={value}>{children}</Ctx.Provider>;
}

export function useAuth(): AuthState {
  const ctx = useContext(Ctx);
  if (!ctx) throw new Error('useAuth fora do AuthProvider');
  return ctx;
}
