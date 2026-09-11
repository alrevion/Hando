import { useState } from 'react';
import type { User } from '../types';
import { ApiError, getMe, updateMe } from '../lib/api';
import { useAuth } from '../context/AuthContext';
import { toast } from '../lib/toast';

/** Настройки уведомлений человека -- те же, что в боте под «Организации → Настройки». */
export function NotifyView({ user }: { user: User }) {
  const { setUser } = useAuth();
  const [mode, setMode] = useState<'all' | 'schedule'>(user.notify_mode ?? 'all');
  const [before, setBefore] = useState(user.remind_before_min ?? 30);
  const [busy, setBusy] = useState(false);

  async function save(patch: { notify_mode?: 'all' | 'schedule'; remind_before_min?: number }) {
    setBusy(true);
    try { await updateMe(patch); setUser((await getMe()).user); toast('Сохранено'); } catch (err) { toast(err instanceof ApiError ? err.message : 'Не получилось.'); } finally { setBusy(false); }
  }

  return (
    <div className="lg:h-full lg:overflow-y-auto lg:p-6">
      <h1 className="h1">Уведомления</h1>
      <div className="card">
        <div className="sec-title" style={{ marginTop: 0 }}>Из нескольких организаций</div>
        <div className="stack" style={{ gap: 6 }}>
          {([['all', 'Сразу из всех', 'Переходы по задачам приходят сразу, ночью — утром.'], ['schedule', 'По расписанию', 'Рабочие — в рабочее время организации, семейные — когда у семьи «рабочее» время (24/7).']] as const).map(([v, t, d]) => (
            <label key={v} className="card card-tap" style={{ display: 'flex', gap: 10, alignItems: 'flex-start', boxShadow: 'none', background: 'var(--fill2)' }}>
              <input type="radio" name="mode" checked={mode === v} disabled={busy} onChange={() => { setMode(v); void save({ notify_mode: v }); }} style={{ marginTop: 3 }} />
              <span className="grow"><span className="t-title">{t}</span><span className="t-meta"><span>{d}</span></span></span>
            </label>
          ))}
        </div>
        <div className="sec-title">Напоминать до срока</div>
        <div className="chips" style={{ paddingBottom: 0, flexWrap: 'wrap', overflowX: 'visible' }}>
          {[15, 30, 60, 120].map((m) => (
            <button key={m} type="button" className={before === m ? 'chip on' : 'chip'} disabled={busy} onClick={() => { setBefore(m); void save({ remind_before_min: m }); }}>
              {m < 60 ? `за ${m} мин` : m === 60 ? 'за час' : 'за 2 часа'}
            </button>
          ))}
        </div>
        <p className="hint">«Забрать ребёнка из сада в 17:00» напомнит в {before >= 60 ? `${17 - before / 60}:00` : `16:${String(60 - before).padStart(2, '0')}`} — независимо от графика. Срок, просрочка и «за час» приходят всегда.</p>
      </div>
    </div>
  );
}
