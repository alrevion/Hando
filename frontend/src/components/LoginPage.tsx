import { useEffect, useState } from 'react';
import { Loader2, Send } from 'lucide-react';
import { ApiError, authLinkClaim, authLinkStart } from '../lib/api';
import { useAuth } from '../context/AuthContext';

/**
 * Вход в браузере -- через бота, без телефона и кодов.
 *
 * Номер бот при регистрации не спрашивает, поэтому прежний вход по телефону
 * не мог сработать ни у кого. Теперь кнопка открывает @hando_ai_bot с
 * одноразовым ключом, человек жмёт там «Войти», а эта страница, опрашивая
 * сервер, получает сессию.
 */
export function LoginPage() {
  const { setUser } = useAuth();
  const [waiting, setWaiting] = useState(false);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    if (!waiting) return undefined;
    const t = setInterval(() => {
      authLinkClaim()
        .then((res) => { if (res.user) setUser(res.user); })
        .catch((err) => {
          // Сеть моргнула -- спросим на следующем круге. Истёк ключ -- стоп.
          if (err instanceof ApiError && err.status === 410) {
            setWaiting(false);
            setError(err.message);
          }
        });
    }, 2000);
    return () => clearInterval(t);
  }, [waiting, setUser]);

  async function start() {
    setError(null);
    // Вкладку открываем СРАЗУ, в самом нажатии: после await браузер счёл бы
    // её всплывающим окном и заблокировал.
    const tab = window.open('', '_blank');
    try {
      const { url } = await authLinkStart();
      if (tab) tab.location.href = url; else window.location.href = url;
      setWaiting(true);
    } catch {
      tab?.close();
      setError('Сервер не отвечает. Попробуйте ещё раз.');
    }
  }

  return (
    <div className="app-frame" style={{ justifyContent: 'center', padding: '24px 20px' }}>
      <div style={{ marginBottom: 22 }}>
        <h1 className="h1" style={{ marginBottom: 6 }}>Вход в Hando</h1>
        <p className="muted">Из Telegram вход происходит сам. В браузере — подтверждением в боте.</p>
      </div>

      {error ? <div role="alert" className="alert alert-err">{error}</div> : null}

      <button type="button" className="btn btn-primary" onClick={start} disabled={waiting}>
        {waiting
          ? <Loader2 className="h-4 w-4 animate-spin" aria-hidden="true" />
          : <Send aria-hidden="true" style={{ width: 16, height: 16 }} />}
        {waiting ? 'Ждём подтверждения…' : 'Войти через Telegram'}
      </button>
      <p className="hint" style={{ marginTop: 12 }} aria-live="polite">
        {waiting
          ? 'Нажмите «Войти» в сообщении от @hando_ai_bot — эта страница откроется сама.'
          : 'Откроется @hando_ai_bot. Нажмите там «Войти» — и вернитесь сюда.'}
      </p>
      {waiting ? (
        <button type="button" className="link" style={{ display: 'block', margin: '12px auto 0', fontSize: 14 }}
          onClick={() => { setWaiting(false); void start(); }}>
          Открыть бота ещё раз
        </button>
      ) : null}
    </div>
  );
}
