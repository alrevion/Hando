import { useState, type FormEvent } from 'react';
import { Loader2, Send } from 'lucide-react';
import { ApiError, authLogin, authVerify } from '../lib/api';
import { useAuth } from '../context/AuthContext';

const VERIFICATION_BOT = 'alrevion_verification_bot';

export function LoginPage() {
  const { setUser } = useAuth();
  const [phone, setPhone] = useState('');
  const [code, setCode] = useState('');
  const [step, setStep] = useState<'phone' | 'code'>('phone');
  const [error, setError] = useState<string | null>(null);
  const [notRegistered, setNotRegistered] = useState(false);
  const [submitting, setSubmitting] = useState(false);

  async function handleSendCode(e: FormEvent) {
    e.preventDefault();
    setError(null);
    setNotRegistered(false);
    if (!phone.trim()) {
      setError('Введите номер телефона.');
      return;
    }
    setSubmitting(true);
    try {
      await authLogin(phone.trim());
      setStep('code');
    } catch (err) {
      if (err instanceof ApiError && err.code === 'PHONE_NOT_REGISTERED') {
        // This is not a user mistake -- the account simply hasn't been
        // provisioned yet. Say so plainly, don't hint at a typo.
        setNotRegistered(true);
      } else if (err instanceof ApiError) {
        setError(err.message);
      } else {
        setError('Сервер не отвечает. Попробуйте ещё раз.');
      }
    } finally {
      setSubmitting(false);
    }
  }

  async function handleVerify(e: FormEvent) {
    e.preventDefault();
    setError(null);
    if (!code.trim()) {
      setError('Введите код из Telegram.');
      return;
    }
    setSubmitting(true);
    try {
      const { user } = await authVerify(phone.trim(), code.trim());
      setUser(user);
    } catch (err) {
      setError(err instanceof ApiError ? err.message : 'Код не подошёл. Попробуйте ещё раз.');
    } finally {
      setSubmitting(false);
    }
  }

  return (
    <div className="app-frame" style={{ justifyContent: 'center', padding: '24px 20px' }}>
      <div style={{ marginBottom: 22 }}>
        <h1 className="h1" style={{ marginBottom: 6 }}>Вход в Hando</h1>
        <p className="muted">Из Telegram вход происходит сам. Здесь — для браузера.</p>
      </div>

      {notRegistered ? (
        <div role="alert" className="alert alert-warn">
          Этот номер ещё не подключён. Откройте бота в Telegram и пройдите регистрацию, затем попробуйте снова.
        </div>
      ) : null}
      {error ? <div role="alert" className="alert alert-err">{error}</div> : null}

      {step === 'phone' ? (
        <form onSubmit={handleSendCode} noValidate>
          <div className="field">
            <label htmlFor="phone" className="lbl">Номер телефона</label>
            <input
              id="phone"
              name="phone"
              type="tel"
              autoComplete="tel"
              value={phone}
              onChange={(e) => setPhone(e.target.value)}
              placeholder="+998 90 000 00 00"
              className="inp"
            />
          </div>
          <button type="submit" disabled={submitting} className="btn btn-primary">
            {submitting ? <Loader2 className="h-4 w-4 animate-spin" aria-hidden="true" /> : null}
            Получить код
          </button>
        </form>
      ) : (
        <form onSubmit={handleVerify} noValidate>
          <p className="muted" style={{ marginBottom: 12 }}>
            Код отправлен на <b style={{ color: 'var(--label)' }}>{phone}</b>.
          </p>

          <div className="card" style={{ marginBottom: 16 }}>
            {/* ?start=login is Telegram's deep-link param -- opening this fires
                /start automatically, so there's no separate Start tap needed. */}
            <a
              href={`https://t.me/${VERIFICATION_BOT}?start=login`}
              target="_blank"
              rel="noopener noreferrer"
              className="btn"
              style={{ textDecoration: 'none' }}
            >
              <Send aria-hidden="true" style={{ width: 16, height: 16 }} />
              Открыть @{VERIFICATION_BOT}
            </a>
            <p className="hint" style={{ marginTop: 10 }}>
              Впервые? Нажмите кнопку и поделитесь контактом, когда бот попросит — так код придёт в Telegram.
              Уже подключены? Код уже в чате с ботом.
            </p>
          </div>

          <div className="field">
            <label htmlFor="code" className="lbl">Код из Telegram</label>
            <input
              id="code"
              name="code"
              type="text"
              inputMode="numeric"
              autoComplete="one-time-code"
              value={code}
              onChange={(e) => setCode(e.target.value)}
              className="inp"
            />
          </div>
          <button type="submit" disabled={submitting} className="btn btn-primary">
            {submitting ? <Loader2 className="h-4 w-4 animate-spin" aria-hidden="true" /> : null}
            Войти
          </button>
          <button
            type="button"
            onClick={() => {
              setStep('phone');
              setCode('');
              setError(null);
            }}
            className="link"
            style={{ display: 'block', margin: '16px auto 0', fontSize: 14 }}
          >
            Другой номер
          </button>
        </form>
      )}
    </div>
  );
}
