import { useState } from 'react';
import { Sheet } from './Sheet';
import { WheelPicker } from './WheelPicker';

const HOURS = Array.from({ length: 24 }, (_, i) => i);
const MINUTES = Array.from({ length: 60 }, (_, i) => i);
/** Колесо дней кончается на 31: дальше крутить дольше, чем набрать. */
const DAYS = Array.from({ length: 31 }, (_, i) => i + 1);
const pad = (n: number) => String(n).padStart(2, '0');

/**
 * Свой интервал повтора: часы с минутами или дни.
 *
 * Два колеса для часов и одно для дней плюс поле ввода -- по просьбе
 * владельца. Колесо ограничено 31 днём намеренно: крутить дальше дольше, чем
 * набрать число, а поле ввода рядом принимает любое.
 *
 * Значение наружу уходит в МИНУТАХ -- в них повтор и хранится, и только так
 * «каждые полтора часа» и «через день» помещаются в одно поле.
 */
export function IntervalSheet({ value, onPick, onClose, title = 'Свой интервал', confirm = 'Повторять', days: withDays = true }: {
  value: number | null;
  onPick: (minutes: number) => void;
  onClose: () => void;
  /** Те же колёса служат и напоминанию «за сколько до срока» -- слова другие. */
  title?: string;
  confirm?: string;
  /** Напоминание дальше суток сервер не берёт: там дни прятать. */
  days?: boolean;
}) {
  const начальныеДни = withDays && value && value % 1440 === 0 ? value / 1440 : 0;
  const [mode, setMode] = useState<'time' | 'days'>(начальныеДни ? 'days' : 'time');
  const [h, setH] = useState(value && !начальныеДни ? Math.floor(value / 60) % 24 : 1);
  const [m, setM] = useState(value && !начальныеДни ? value % 60 : 0);
  const [days, setDays] = useState(начальныеДни || 1);
  const [typed, setTyped] = useState('');

  const dayCount = typed.trim() ? Math.max(1, Math.floor(Number(typed)) || 1) : days;
  const minutes = mode === 'days' ? dayCount * 1440 : h * 60 + m;

  return (
    <Sheet title={title} onClose={onClose}>
      {/* Часы или дни. Сегментный переключатель, а не два экрана: выбор между
          двумя единицами -- это одно решение, а не два шага. */}
      <div className="segmented" style={{ ['--n' as string]: 2, display: withDays ? undefined : 'none' }}>
        <div className="segmented-indicator" aria-hidden="true" style={{ transform: `translateX(${mode === 'time' ? 0 : 100}%)` }} />
        <button type="button" className={mode === 'time' ? 'segmented-btn on' : 'segmented-btn'}
          aria-pressed={mode === 'time'} onClick={() => setMode('time')}>Часы</button>
        <button type="button" className={mode === 'days' ? 'segmented-btn on' : 'segmented-btn'}
          aria-pressed={mode === 'days'} onClick={() => setMode('days')}>Дни</button>
      </div>

      {mode === 'time' ? (
        <div className="wheel-row">
          <div>
            <p className="wheel-cap">Часы</p>
            <WheelPicker items={HOURS} value={h} onChange={setH} formatItem={pad} loop visibleCount={5} />
          </div>
          <div>
            <p className="wheel-cap">Минуты</p>
            <WheelPicker items={MINUTES} value={m} onChange={setM} formatItem={pad} loop visibleCount={5} />
          </div>
        </div>
      ) : (
        <>
          <div className="field">
            <label className="lbl" htmlFor="interval-days">Сколько дней</label>
            <input id="interval-days" className="inp" inputMode="numeric" value={typed}
              placeholder={String(days)} onChange={(e) => setTyped(e.target.value.replace(/\D/g, '').slice(0, 4))} />
            <p className="hint">Колесо ниже — до 31 дня. Больше — впишите числом.</p>
          </div>
          <div className="wheel-row">
            <WheelPicker items={DAYS} value={Math.min(31, dayCount)} onChange={(d) => { setDays(d); setTyped(''); }} visibleCount={5} />
          </div>
        </>
      )}

      <div className="btn-row" style={{ marginTop: 16 }}>
        <button type="button" className="btn" onClick={onClose}>Отмена</button>
        <button type="button" className="btn btn-primary" disabled={minutes < 1}
          onClick={() => { onPick(minutes); onClose(); }}>
          {confirm}
        </button>
      </div>
    </Sheet>
  );
}
