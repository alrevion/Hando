import { useEffect, useState } from 'react';
import { AuthProvider, useAuth } from './context/AuthContext';
import { DataProvider } from './context/DataContext';
import { LoginPage } from './components/LoginPage';
import { MobileShell } from './components/MobileShell';
import { NoOrgScreen } from './components/NoOrgScreen';
import { Toaster } from './components/Toaster';
import { getTask } from './lib/api';
import type { Task } from './types';

/**
 * Один макет на любой ширине: колонка, как в Telegram, по центру экрана.
 * Прежняя «десктопная» раскладка с боковой панелью и доской ушла вместе с
 * вкладкой «Доска» (раздел 22): у продукта одна поверхность, а не две.
 */
function AuthenticatedApp() {
  const { user } = useAuth();
  const [deepLinkTask, setDeepLinkTask] = useState<Task | null>(null);

  // Уведомления ведут на /?task=<id> -- открываем саму задачу, а не главный
  // экран. Недоступный id просто игнорируется.
  useEffect(() => {
    const taskId = new URLSearchParams(window.location.search).get('task');
    if (!taskId) return;
    window.history.replaceState(null, '', window.location.pathname);
    getTask(taskId).then(setDeepLinkTask).catch(() => {});
  }, []);

  if (!user) return null; // AppShell гарантирует пользователя
  // onOpened гасит ссылку: иначе задача, открытая по уведомлению, всплывала
  // снова при каждой перерисовке оболочки -- человек закрывал карточку, и она
  // возвращалась сама, будто приложение её навязывает.
  return <MobileShell user={user} deepLinkTask={deepLinkTask} onLinkOpened={() => setDeepLinkTask(null)} />;
}

function AppShell() {
  const { user, loading } = useAuth();

  if (loading) {
    return <div className="app-frame" style={{ alignItems: 'center', justifyContent: 'center' }}><span className="muted">Загрузка…</span></div>;
  }
  if (!user) return <LoginPage />;
  // Первая организация -- здесь (раздел 18), а склад данных без неё не нужен.
  if (user.org_id === null) return <NoOrgScreen user={user} />;
  return (
    <DataProvider>
      <AuthenticatedApp />
      {/* Тосты -- поверх всего: экраны сообщают об ошибках только через них. */}
      <Toaster />
    </DataProvider>
  );
}

function App() {
  return (
    <AuthProvider>
      <AppShell />
    </AuthProvider>
  );
}

export default App;
