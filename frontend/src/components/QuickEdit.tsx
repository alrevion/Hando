import { useState } from 'react';
import { CalendarDays } from 'lucide-react';
import type { Priority, Task } from '../types';
import { PRIORITIES } from '../lib/priority';
import { quickEditTask } from '../lib/api';
import { useData } from '../context/DataContext';

/** «2026-09-11» для сегодня + N дней по часам ТЕЛЕФОНА (выбор-то делает человек). */
function inDays(n: number): string {
  const d = new Date();
  d.setDate(d.getDate() + n);
  return `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}-${String(d.getDate()).padStart(2, '0')}`;
}

/** Ближайшая пятница, включая сегодняшнюю: «к концу недели» в пятницу -- сегодня. */
function endOfWeek(): string {
  const d = new Date();
  return inDays((5 - ((d.getDay() + 6) % 7) + 7) % 7);
}

/**
 * Срок и срочность в два касания -- ровно те же кнопки, что бот присылает под
 * подтверждением. Дата целиком -- системным выбором (input type="date"): в
 * мини-приложении он и есть тот самый календарь телефона.
 *
 * Час к дате дописывает СЕРВЕР в поясе организации: у телефона пояс свой, и
 * «пятница» у сотрудника в другом городе означала бы другой момент.
 */
export function QuickEdit({ task, onDone }: { task: Task; onDone?: () => void }) {
  const { refresh } = useData();
  const [busy, setBusy] = useState(false);

  async function apply(patch: { deadline?: string | null; priority?: Priority }) {
    setBusy(true);
    try {
      await quickEditTask(task.id, patch);
      await refresh();
      onDone?.();
    } finally {
      setBusy(false);
    }
  }

  return (
    <>
      <div className="sec-title" style={{ margin: '4px 0 8px' }}>Срочность</div>
      <div className="chips" style={{ paddingBottom: 8 }}>
        {PRIORITIES.map((p) => (
          <button
            key={p.value}
            type="button"
            disabled={busy}
            className={task.priority === p.value ? 'chip on' : 'chip'}
            onClick={() => apply({ priority: p.value })}
          >
            {p.label}
          </button>
        ))}
      </div>

      <div className="sec-title" style={{ margin: '4px 0 8px' }}>Срок</div>
      <div className="chips" style={{ paddingBottom: 8 }}>
        <button type="button" className="chip" disabled={busy} onClick={() => apply({ deadline: inDays(0) })}>Сегодня</button>
        <button type="button" className="chip" disabled={busy} onClick={() => apply({ deadline: inDays(1) })}>Завтра</button>
        <button type="button" className="chip" disabled={busy} onClick={() => apply({ deadline: endOfWeek() })}>В конце недели</button>
        {task.deadline ? (
          <button type="button" className="chip" disabled={busy} onClick={() => apply({ deadline: null })}>Убрать</button>
        ) : null}
      </div>
      <label className="btn" style={{ position: 'relative', overflow: 'hidden' }}>
        <CalendarDays aria-hidden="true" style={{ width: 16, height: 16 }} />
        Выбрать дату
        {/* Само поле прозрачно и растянуто на кнопку: нажатие открывает
            системный выбор даты, а вид остаётся наш. */}
        <input
          type="date"
          disabled={busy}
          value={task.deadline ? task.deadline.slice(0, 10) : ''}
          onChange={(e) => { if (e.target.value) void apply({ deadline: e.target.value }); }}
          style={{ position: 'absolute', inset: 0, opacity: 0, width: '100%', height: '100%' }}
        />
      </label>
    </>
  );
}
