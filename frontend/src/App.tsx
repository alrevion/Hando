import { useEffect, useState } from 'react';
import { AuthProvider, useAuth } from './context/AuthContext';
import { DataProvider } from './context/DataContext';
import { LoginPage } from './components/LoginPage';
import { MobileShell } from './components/MobileShell';
import { NoOrgScreen } from './components/NoOrgScreen';
import { Toaster } from './components/Toaster';
import { getTask } from './lib/api';
import type { Task } from './types';

/** Последняя ссылка из уведомления, уже открытая. Переживает перезапуск. */
const LINK_KEY = 'hando:openedTask';

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
  //
  // ОДИН РАЗ НА ССЫЛКУ, и память об этом переживает перезапуск. Ссылка живёт в
  // адресе, а Telegram, открывая мини-приложение заново, возвращается на тот
  // же адрес -- и карточка всплывала при каждом входе, хотя человек её уже
  // закрыл. Прошлая правка гасила ссылку только в пределах сеанса и от этого
  // не спасала: там она гасла в состоянии React, а тут приложение стартует с
  // нуля. Отметка в localStorage -- единственное, что живёт между запусками.
  useEffect(() => {
    const taskId = new URLSearchParams(window.location.search).get('task');

    // ОБЫЧНЫЙ ВХОД (без ссылки) снимает отметку. Правило владельца: открыл по
    // inline-кнопке -- показываем задачу; открыл само мини-приложение -- не
    // показываем. Обычный вход и есть граница между двумя запусками: после
    // него та же кнопка снова откроет задачу, а повтор адреса без такого входа
    // между ними -- это и есть переоткрытие Telegram, которое мы гасим.
    if (!taskId) {
      try { localStorage.removeItem(LINK_KEY); } catch { /* хранилище недоступно */ }
      return;
    }
    // hash сохраняем: в нём лежит подпись Telegram, и без неё перезагрузка
    // страницы уводит на экран входа.
    window.history.replaceState(null, '', window.location.pathname + window.location.hash);

    // Приватный режим и запрет на хранилище -- не ошибка приложения: тогда
    // просто открываем, как раньше.
    let seen: string | null = null;
    try { seen = localStorage.getItem(LINK_KEY); } catch { /* хранилище недоступно */ }
    if (seen === taskId) return;

    // Отметка ставится ПОСЛЕ успешной загрузки, а не до. Иначе неудачная
    // попытка (сеть отвалилась, задача ещё не видна) сжигала бы ссылку: по
    // второму нажатию человек не увидел бы ничего.
    getTask(taskId).then((task) => {
      setDeepLinkTask(task);
      try { localStorage.setItem(LINK_KEY, taskId); } catch { /* и это переживём */ }
    }).catch(() => {});
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
