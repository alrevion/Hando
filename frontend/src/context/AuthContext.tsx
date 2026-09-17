import { createContext, useContext, useEffect, useState, type ReactNode } from 'react';
import { ApiError, authLogout, authTelegram, getMe } from '../lib/api';
import { announceReady, initData } from '../lib/telegram';
import type { User } from '../types';

interface AuthContextValue {
  user: User | null;
  loading: boolean;
  setUser: (user: User | null) => void;
  logout: () => Promise<void>;
}

const AuthContext = createContext<AuthContextValue | null>(null);

export function AuthProvider({ children }: { children: ReactNode }) {
  const [user, setUser] = useState<User | null>(null);
  const [loading, setLoading] = useState(true);

  useEffect(() => {
    announceReady();

    // Порядок: сначала действующая сессия, потом вход по подписи Telegram.
    //
    // Сессия проверяется первой намеренно: повторный вход по initData сбросил
    // бы человека на другую организацию (initData знает только про
    // Telegram-аккаунт, а не про выбранное пространство).
    //
    // Внутри мессенджера подпись Telegram и есть доказательство личности. Кто
    // открыл сайт в браузере, входит подтверждением в боте (LoginPage).
    getMe()
      .then((res) => setUser(res.user))
      .catch(async (err) => {
        if (!(err instanceof ApiError) || err.status !== 401) {
          console.error('Failed to load session', err);
          setUser(null);
          return;
        }
        const data = initData();
        if (!data) {
          setUser(null);
          return;
        }
        try {
          const res = await authTelegram(data);
          setUser(res.user);
        } catch (e) {
          // 403 CONNECT_BOT_FIRST / NO_ORG -- человек открыл приложение раньше,
          // чем закончил регистрацию в боте. Показываем экран входа: он объяснит.
          if (!(e instanceof ApiError)) console.error('Telegram sign-in failed', e);
          setUser(null);
        }
      })
      .finally(() => setLoading(false));
  }, []);

  async function logout() {
    await authLogout().catch(() => {});
    setUser(null);
  }

  return (
    <AuthContext.Provider value={{ user, loading, setUser, logout }}>
      {children}
    </AuthContext.Provider>
  );
}

export function useAuth() {
  const ctx = useContext(AuthContext);
  if (!ctx) throw new Error('useAuth must be used within AuthProvider');
  return ctx;
}
