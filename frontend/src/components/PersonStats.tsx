import { useState } from 'react';
import { X } from 'lucide-react';
import type { User } from '../types';
import type { PersonStats as Stats } from '../lib/api';
import { Sheet } from './Sheet';

type Period = 'last30' | 'all';
const PERIOD_LABEL: Record<Period, string> = { last30: '30 дней', all: 'Всё время' };

/**
 * Показатели человека -- нижняя шторка, открывается кнопкой «Статистика» на
 * карточке. Раньше два числа печатались прямо в раскрытой карточке;
 * перенесены сюда списком, чтобы карточка оставалась короткой, а разбор по
 * периодам не толкал соседей по списку вниз.
 */
export function PersonStatsSheet({
  user, data, onClose,
}: {
  user: User;
  /** undefined -- ещё грузится, null -- запрос не удался. */
  data: { all: Stats; last30: Stats } | null | undefined;
  onClose: () => void;
}) {
  const [period, setPeriod] = useState<Period>('last30');

  // «Никогда ничего не сдавал» смотрим по всему времени: если там пусто,
  // то и в любом периоде будет пусто -- переключатель тут ни при чём.
  const neverDid = !!data && data.all.done === 0 && data.all.accepted === 0 && data.all.declined === 0 && data.all.in_progress === 0;

  return (
    <Sheet labelledBy="stats-title" onClose={onClose}>
      <div className="sheet-head">
        <h2 id="stats-title" className="sheet-title">{user.name}</h2>
        <button type="button" onClick={onClose} aria-label="Закрыть" className="btn-icon"><X aria-hidden="true" /></button>
      </div>

      {data === undefined ? (
        <p className="muted">Считаю…</p>
      ) : data === null ? (
        <p className="muted">Не удалось посчитать.</p>
      ) : neverDid ? (
        <div className="empty">
          <b>Пока нет данных</b>
          Этот человек ещё не закрывал задач.
        </div>
      ) : (
        <>
          <div className="chips" aria-label="Период" style={{ paddingBottom: 16 }}>
            {(['last30', 'all'] as const).map((p) => (
              <button
                key={p}
                type="button"
                aria-pressed={period === p}
                className={period === p ? 'chip on' : 'chip'}
                onClick={() => setPeriod(p)}
              >
                {PERIOD_LABEL[p]}
              </button>
            ))}
          </div>
          <StatRows s={data[period]} />
        </>
      )}
    </Sheet>
  );
}

// Строки метрик: подпись слева, значение справа моноширинно, чтобы колонка
// цифр не прыгала при переключении периода. У «сдано в срок» под числом ещё
// полоса-диаграмма -- та же доля, просто второй раз, для беглого взгляда.
function StatRows({ s }: { s: Stats }) {
  const rows: { label: string; value: string; bar?: number }[] = [
    { label: 'Сдано', value: String(s.done) },
    { label: 'Сдано в срок', value: s.on_time_pct !== null ? `${s.on_time_pct}%` : '—', bar: s.on_time_pct ?? undefined },
    { label: 'Средняя просрочка', value: `${s.avg_late_days} дн.` },
    { label: 'Принял', value: String(s.accepted) },
    { label: 'Отказался', value: String(s.declined) },
    { label: 'Сейчас в работе', value: String(s.in_progress) },
  ];
  return (
    <div>
      {rows.map((r, i) => (
        <div key={r.label} style={{ padding: '12px 2px', borderTop: i === 0 ? undefined : '0.5px solid var(--sep)' }}>
          <div style={{ display: 'flex', alignItems: 'center', justifyContent: 'space-between', gap: 12 }}>
            <span style={{ fontSize: 15, color: 'var(--label2)' }}>{r.label}</span>
            <span style={{ fontSize: 19, fontWeight: 700, fontVariantNumeric: 'tabular-nums', textAlign: 'right' }}>{r.value}</span>
          </div>
          {r.bar !== undefined ? (
            <div aria-hidden="true" style={{ marginTop: 8, height: 8, borderRadius: 999, background: 'var(--fill2)', overflow: 'hidden' }}>
              <div style={{ width: `${Math.min(100, Math.max(0, r.bar))}%`, height: '100%', borderRadius: 999, background: 'var(--accent)' }} />
            </div>
          ) : null}
        </div>
      ))}
    </div>
  );
}
