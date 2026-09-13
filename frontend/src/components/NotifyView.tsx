import { useState } from 'react';
import { Clock } from 'lucide-react';
import type { User } from '../types';
import { ApiError, getMe, updateMe } from '../lib/api';
import { useAuth } from '../context/AuthContext';
import { toast } from '../lib/toast';
import { IntervalSheet } from './IntervalSheet';

/** Готовые сроки напоминания. Всё остальное человек набирает колесом. */
const PRESETS = [15, 30, 60, 120];
const LABEL: Record<number, string> = { 15: 'за 15 мин', 30: 'за 30 мин', 60: 'за час', 120: 'за 2 часа' };
/** «за 1 ч 30 мин» -- без склонений: «ч» одинаково при любом числе. */
const anyLabel = (m: number) =>
  m < 60 ? `за ${m} мин` : m % 60 === 0 ? `за ${m / 60} ч` : `за ${Math.floor(m / 60)} ч ${m % 60} мин`;

/** Настройки уведомлений человека -- те же, что в боте под «Организации → Настройки». */
export function NotifyView({ user }: { user: User }) {
  const { setUser } = useAuth();
  const [mode, setMode] = useState<'all' | 'schedule'>(user.notify_mode ?? 'all');
  const [before, setBefore] = useState(user.remind_before_min ?? 30);
  const [busy, setBusy] = useState(false);
  const [ownSheet, setOwnSheet] = useState(false);

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
          {PRESETS.map((m) => (
            <button key={m} type="button" className={before === m ? 'chip on' : 'chip'} disabled={busy} onClick={() => { setBefore(m); void save({ remind_before_min: m }); }}>
              {LABEL[m]}
            </button>
          ))}
          {/* Свой срок -- те же колёса, что у своего интервала повтора. Дни
              скрыты: дальше суток сервер напоминание не берёт. */}
          <button type="button" className={PRESETS.includes(before) ? 'chip' : 'chip on'} disabled={busy} onClick={() => setOwnSheet(true)}>
            <Clock aria-hidden="true" style={{ width: 14, height: 14 }} />
            {PRESETS.includes(before) ? 'Свой' : anyLabel(before)}
          </button>
        </div>
        <p className="hint">«Забрать ребёнка из сада в 17:00» напомнит в {`${Math.floor((17 * 60 - before) / 60)}:${String((17 * 60 - before) % 60).padStart(2, '0')}`} — независимо от графика. Срок, просрочка и «за час» приходят всегда.</p>
        {ownSheet ? (
          <IntervalSheet value={before} days={false} title="За сколько напомнить" confirm="Напоминать"
            onPick={(m) => { setBefore(m); void save({ remind_before_min: m }); }}
            onClose={() => setOwnSheet(false)} />
        ) : null}
      </div>
    </div>
  );
}
