import { useState } from 'react';
import { Sheet } from './Sheet';
import { WheelPicker } from './WheelPicker';

const MONTHS = Array.from({ length: 12 }, (_, i) => i);
const monthName = (m: number) =>
  new Date(2000, m, 1).toLocaleDateString('ru-RU', { month: 'long' }).replace(/^./, (c) => c.toUpperCase());

/** Годы колеса. Не «десять вокруг текущего с догрузкой»: догрузка сверху
 *  сдвигает индексы уже прокрученного колеса и дёргает его под пальцем, а
 *  полтораста чисел в разметке не стоят ничего. */
const YEARS = Array.from({ length: 2100 - 1970 + 1 }, (_, i) => 1970 + i);

/**
 * Прыжок календаря на месяц: год слева, месяц справа.
 *
 * Год -- колесом ИЛИ числом: «2031» быстрее вписать, чем домотать.
 * Месяц -- только колесом: их ровно двенадцать, вписывать нечего.
 */
export function MonthSheet({ year, month, onPick, onClose }: {
  year: number;
  month: number;
  onPick: (year: number, month: number) => void;
  onClose: () => void;
}) {
  const [y, setY] = useState(year);
  const [m, setM] = useState(month);
  const [typed, setTyped] = useState('');

  // Вписанный год побеждает колесо, но только когда он похож на год: «20» по
  // дороге к «2031» не должно швырять календарь в первый век.
  const finalYear = typed.length === 4 ? Number(typed) : y;

  return (
    <Sheet title="Какой месяц" onClose={onClose}>
      <div className="field">
        <label className="lbl" htmlFor="month-year">Год</label>
        <input id="month-year" className="inp" inputMode="numeric" value={typed} placeholder={String(y)}
          onChange={(e) => setTyped(e.target.value.replace(/\D/g, '').slice(0, 4))} />
      </div>

      <div className="wheel-row">
        <div>
          <p className="wheel-cap">Год</p>
          <WheelPicker items={YEARS} value={YEARS.includes(finalYear) ? finalYear : y}
            onChange={(v) => { setY(v); setTyped(''); }} visibleCount={5} />
        </div>
        <div>
          <p className="wheel-cap">Месяц</p>
          <WheelPicker items={MONTHS} value={m} onChange={setM} formatItem={monthName} loop visibleCount={5} />
        </div>
      </div>

      <div className="btn-row" style={{ marginTop: 16 }}>
        <button type="button" className="btn" onClick={onClose}>Отмена</button>
        <button type="button" className="btn btn-primary" disabled={finalYear < 1970 || finalYear > 2100}
          onClick={() => { onPick(finalYear, m); onClose(); }}>
          Перейти
        </button>
      </div>
    </Sheet>
  );
}
