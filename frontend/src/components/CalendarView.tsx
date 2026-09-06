import { useMemo, useState } from 'react';
import { ChevronLeft, ChevronRight } from 'lucide-react';
import type { Task, User } from '../types';
import { useOrgTasks, useOrgUsers, type OrgTask } from '../hooks/useOrgTasks';
import { PRIORITY_DOT } from '../lib/priority';
import { isTaskOverdue } from '../lib/overdue';
import { TaskDetailModal } from './TaskDetailModal';
import { assigneeKey } from '../lib/tasks';

const WEEKDAYS = ['Пн', 'Вт', 'Ср', 'Чт', 'Пт', 'Сб', 'Вс'];
const MAX_CHIPS_PER_DAY = 3;

// Ключ дня -- первые 10 символов самой строки срока, а не Date. Сроки хранятся
// как YYYY-MM-DD, и new Date('2026-09-04') -- это полночь UTC: в западных
// часовых поясах задача уехала бы в календаре на день назад. Здесь сравнение
// строк и есть правильный ответ.
function dayKey(deadline: string): string {
  return deadline.slice(0, 10);
}

function localDayKey(date: Date): string {
  const month = String(date.getMonth() + 1).padStart(2, '0');
  const day = String(date.getDate()).padStart(2, '0');
  return `${date.getFullYear()}-${month}-${day}`;
}

/**
 * Внутренний календарь: ПРЕДСТАВЛЕНИЕ задач по датам. Не канал уведомлений и не
 * синхронизация с внешними календарями -- решение заказчика; уведомления жили и
 * живут в Telegram.
 *
 * Задача попадает в клетку своего срока. Задачи без срока в сетку не помещаются
 * в принципе, поэтому они не «теряются молча», а считаются отдельной строкой
 * под сеткой.
 */
export function CalendarView({ currentUser }: { currentUser: User }) {
  const { tasks, loading, loadError } = useOrgTasks();
  const { users } = useOrgUsers();
  const [cursor, setCursor] = useState(() => new Date());
  const [viewing, setViewing] = useState<Task | null>(null);

  // Себя добавляем всегда: справочник организации роли member недоступен, и без
  // этого человек не увидел бы имени даже на собственной задаче.
  const usersById = useMemo(
    () => new Map<string, User>([[currentUser.id, currentUser], ...users.map((u) => [u.id, u] as const)]),
    [users, currentUser],
  );

  const year = cursor.getFullYear();
  const month = cursor.getMonth();

  const byDay = useMemo(() => {
    const map = new Map<string, OrgTask[]>();
    for (const row of tasks) {
      if (!row.task.deadline) continue;
      const key = dayKey(row.task.deadline);
      const bucket = map.get(key);
      if (bucket) bucket.push(row);
      else map.set(key, [row]);
    }
    return map;
  }, [tasks]);

  const undated = tasks.filter(({ task }) => !task.deadline).length;

  // Понедельник -- первый столбец: getDay() считает от воскресенья, поэтому сдвиг.
  const offset = (new Date(year, month, 1).getDay() + 6) % 7;
  const daysInMonth = new Date(year, month + 1, 0).getDate();
  const cells: (number | null)[] = [
    ...Array.from({ length: offset }, () => null),
    ...Array.from({ length: daysInMonth }, (_, i) => i + 1),
  ];
  const todayKey = localDayKey(new Date());

  return (
    <div className="flex h-full flex-col overflow-y-auto p-6">
      <div className="mb-4 flex flex-wrap items-center gap-2">
        <h1 className="text-xl font-semibold text-slate-900">Календарь</h1>
        <span className="ml-2 text-sm font-medium capitalize text-slate-600">
          {new Date(year, month, 1).toLocaleDateString('ru-RU', { month: 'long', year: 'numeric' })}
        </span>
        <div className="ml-auto flex items-center gap-1">
          <button
            type="button"
            aria-label="Предыдущий месяц"
            onClick={() => setCursor(new Date(year, month - 1, 1))}
            className="rounded-md border border-slate-300 p-1.5 text-slate-600 hover:bg-slate-50"
          >
            <ChevronLeft className="h-4 w-4" aria-hidden="true" />
          </button>
          <button
            type="button"
            onClick={() => setCursor(new Date())}
            className="rounded-md border border-slate-300 px-3 py-1.5 text-sm text-slate-700 hover:bg-slate-50"
          >
            Сегодня
          </button>
          <button
            type="button"
            aria-label="Следующий месяц"
            onClick={() => setCursor(new Date(year, month + 1, 1))}
            className="rounded-md border border-slate-300 p-1.5 text-slate-600 hover:bg-slate-50"
          >
            <ChevronRight className="h-4 w-4" aria-hidden="true" />
          </button>
        </div>
      </div>

      {loadError ? (
        <div role="alert" className="mb-3 rounded-md border border-red-300 bg-red-50 p-2 text-sm text-red-800">
          {loadError}
        </div>
      ) : null}

      {loading ? <p className="mb-3 text-sm text-slate-500">Загрузка…</p> : null}

      <div className="grid grid-cols-7 gap-px rounded-lg border border-slate-200 bg-slate-200">
        {WEEKDAYS.map((label) => (
          <div key={label} className="bg-slate-50 px-2 py-1 text-center text-xs font-medium text-slate-500">
            {label}
          </div>
        ))}

        {cells.map((day, index) => {
          if (day === null) return <div key={`pad-${index}`} className="min-h-24 bg-slate-50" />;
          const key = localDayKey(new Date(year, month, day));
          const dayTasks = byDay.get(key) ?? [];
          const isToday = key === todayKey;
          return (
            <div key={key} className="min-h-24 bg-white p-1">
              <div
                className={`mb-1 text-xs font-medium ${
                  isToday ? 'inline-flex h-5 w-5 items-center justify-center rounded-full bg-blue-600 text-white' : 'text-slate-500'
                }`}
              >
                {day}
              </div>
              <ul className="space-y-0.5">
                {dayTasks.slice(0, MAX_CHIPS_PER_DAY).map(({ task }) => (
                  <li key={task.id}>
                    <button
                      type="button"
                      onClick={() => setViewing(task)}
                      title={task.title}
                      className={`flex w-full items-center gap-1 rounded px-1 py-0.5 text-left text-xs hover:bg-slate-100 ${
                        isTaskOverdue(task) ? 'text-red-700' : 'text-slate-700'
                      }`}
                    >
                      <span className={`h-1.5 w-1.5 shrink-0 rounded-full ${PRIORITY_DOT[task.priority]}`} aria-hidden="true" />
                      <span className="truncate">{task.title}</span>
                    </button>
                  </li>
                ))}
                {dayTasks.length > MAX_CHIPS_PER_DAY ? (
                  <li className="px-1 text-xs text-slate-500">ещё {dayTasks.length - MAX_CHIPS_PER_DAY}</li>
                ) : null}
              </ul>
            </div>
          );
        })}
      </div>

      {undated > 0 ? (
        <p className="mt-3 text-xs text-slate-500">Без срока: {undated} — такие задачи в сетку не попадают.</p>
      ) : null}

      {viewing ? (
        <TaskDetailModal
          task={viewing}
          responsible={usersById.get(assigneeKey(viewing))}
          onClose={() => setViewing(null)}
        />
      ) : null}
    </div>
  );
}
