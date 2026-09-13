import { useState } from 'react';
import { Sheet } from './Sheet';
import { WheelPicker } from './WheelPicker';

const HOURS = Array.from({ length: 24 }, (_, i) => i);
/** Минуты пятёрками: срок с точностью до минуты никто не ставит. */
const MINUTES = Array.from({ length: 12 }, (_, i) => i * 5);
const pad = (n: number) => String(n).padStart(2, '0');

/**
 * Час срока -- двумя колёсами, а не выпадающим списком.
 *
 * Выпадающий список часов на телефоне открывается системным барабаном поверх
 * всего, и выбрать час с минутой в нём -- два отдельных касания вслепую.
 * Колесо стоит на месте и показывает соседние значения.
 */
export function TimeSheet({ iso, onPick, onClose }: {
  iso: string | null;
  onPick: (isoWithTime: string) => void;
  onClose: () => void;
}) {
  const base = iso ? new Date(iso) : new Date();
  const [h, setH] = useState(base.getHours());
  const [m, setM] = useState(Math.round(base.getMinutes() / 5) * 5 % 60);

  return (
    <Sheet title="Во сколько" onClose={onClose}>
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
      <div className="btn-row" style={{ marginTop: 16 }}>
        <button type="button" className="btn" onClick={onClose}>Отмена</button>
        <button type="button" className="btn btn-primary" onClick={() => {
          // День берётся у уже выбранного срока, а если его нет -- сегодняшний.
          const d = iso ? new Date(iso) : new Date();
          d.setHours(h, m, 0, 0);
          onPick(d.toISOString());
          onClose();
        }}>
          Поставить
        </button>
      </div>
    </Sheet>
  );
}
