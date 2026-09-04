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
      setError('Enter a phone number.');
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
        setError('Could not reach the server. Try again.');
      }
    } finally {
      setSubmitting(false);
    }
  }

  async function handleVerify(e: FormEvent) {
    e.preventDefault();
    setError(null);
    if (!code.trim()) {
      setError('Enter the code you received.');
      return;
    }
    setSubmitting(true);
    try {
      const { user } = await authVerify(phone.trim(), code.trim());
      setUser(user);
    } catch (err) {
      setError(err instanceof ApiError ? err.message : 'Could not verify the code. Try again.');
    } finally {
      setSubmitting(false);
    }
  }

  return (
    <div className="flex min-h-screen items-center justify-center px-4">
      <div className="w-full max-w-sm rounded-lg border border-slate-200 bg-white p-8 shadow-sm">
        <h1 className="mb-6 text-xl font-semibold text-slate-900">Sayn sign in</h1>

        {notRegistered ? (
          <div
            role="alert"
            className="mb-4 rounded-md border border-amber-300 bg-amber-50 p-3 text-sm text-amber-900"
          >
            This phone number hasn't been set up yet. Ask a super-admin or the creator to add
            your account, then try again.
          </div>
        ) : null}

        {error ? (
          <div
            role="alert"
            className="mb-4 rounded-md border border-red-300 bg-red-50 p-3 text-sm text-red-800"
          >
            {error}
          </div>
        ) : null}

        {step === 'phone' ? (
          <form onSubmit={handleSendCode} noValidate>
            <label htmlFor="phone" className="mb-1 block text-sm font-medium text-slate-700">
              Phone number
            </label>
            <input
              id="phone"
              name="phone"
              type="tel"
              autoComplete="tel"
              value={phone}
              onChange={(e) => setPhone(e.target.value)}
              placeholder="+1 555 000 0000"
              className="mb-4 w-full rounded-md border border-slate-300 px-3 py-2 text-sm focus-visible:outline-blue-600"
            />
            <button
              type="submit"
              disabled={submitting}
              className="flex w-full items-center justify-center gap-2 rounded-md bg-blue-600 px-4 py-2 text-sm font-medium text-white hover:bg-blue-700 disabled:cursor-not-allowed disabled:bg-blue-300"
            >
              {submitting ? <Loader2 className="h-4 w-4 animate-spin" aria-hidden="true" /> : null}
              Send code
            </button>
          </form>
        ) : (
          <form onSubmit={handleVerify} noValidate>
            <p className="mb-3 text-sm text-slate-600">
              Code sent to <span className="font-medium">{phone}</span>.
            </p>

            <div className="mb-4 rounded-md border border-blue-200 bg-blue-50 p-3">
              {/* ?start=login is Telegram's deep-link param -- opening this fires
                  /start automatically, so there's no separate Start tap needed. */}
              <a
                href={`https://t.me/${VERIFICATION_BOT}?start=login`}
                target="_blank"
                rel="noopener noreferrer"
                className="flex items-center justify-center gap-2 rounded-md bg-blue-600 px-3 py-2 text-sm font-medium text-white hover:bg-blue-700"
              >
                <Send className="h-4 w-4" aria-hidden="true" />
                Open @{VERIFICATION_BOT} in Telegram
              </a>
              <p className="mt-2 text-xs text-blue-900">
                First time signing in? Tap the button above and share your contact when the bot
                asks -- that's how the code reaches you in Telegram. Already set up? The code
                should already be in your chat with the bot.
              </p>
            </div>

            <label htmlFor="code" className="mb-1 block text-sm font-medium text-slate-700">
              Verification code
            </label>
            <input
              id="code"
              name="code"
              type="text"
              inputMode="numeric"
              autoComplete="one-time-code"
              value={code}
              onChange={(e) => setCode(e.target.value)}
              className="mb-4 w-full rounded-md border border-slate-300 px-3 py-2 text-sm focus-visible:outline-blue-600"
            />
            <button
              type="submit"
              disabled={submitting}
              className="flex w-full items-center justify-center gap-2 rounded-md bg-blue-600 px-4 py-2 text-sm font-medium text-white hover:bg-blue-700 disabled:cursor-not-allowed disabled:bg-blue-300"
            >
              {submitting ? <Loader2 className="h-4 w-4 animate-spin" aria-hidden="true" /> : null}
              Verify
            </button>
            <button
              type="button"
              onClick={() => {
                setStep('phone');
                setCode('');
                setError(null);
              }}
              className="mt-3 w-full text-center text-sm text-slate-500 underline hover:text-slate-700"
            >
              Use a different number
            </button>
          </form>
        )}
      </div>
    </div>
  );
}
