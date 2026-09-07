import { useMemo, useState } from 'react';
import { ChevronLeft, ChevronRight } from 'lucide-react';
import type { Task, User } from '../types';
import { useOrgTasks, useOrgUsers, type OrgTask } from '../hooks/useOrgTasks';
import { PRIORITY_DOT } from '../lib/priority';
import { isTaskOverdue } from '../lib/overdue';
import { TaskDetailModal } from './TaskDetailModal';
import { assigneeKey } from '../lib/tasks';

const WEEKDAYS = ['Пн', 'Вт', 'Ср', 'Чт', 'Пт', 'Сб', 'Вс'];
const MAX_DOTS_PER_DAY = 3;

// Ключ дня -- первые 10 символов самой строки срока, а не Date. Сроки хранятся
// как YYYY-MM-DD, и new Date('2026-09-04') -- это полночь UTC: в западных
// часовых поясах задача уехала бы в календаре на день назад. Здесь сравнение
// строк и есть правильный ответ.
function dayKey(deadline: string): string {
  return deadline.slice(0, 10);
}

// «сентябрь 2026 г.» -> «Сентябрь 2026 г.»: CSS capitalize задел бы и «Г.».
function cap(s: string): string {
  return s.charAt(0).toUpperCase() + s.slice(1);
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
  // Выбранный день: по умолчанию сегодня. Сетка на телефоне слишком узкая для
  // названий задач, поэтому в клетке -- только точки, а список -- под сеткой.
  const [selected, setSelected] = useState(() => localDayKey(new Date()));

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

  const selectedTasks = byDay.get(selected) ?? [];
  const selectedDate = new Date(`${selected}T00:00:00`);

  return (
    <div className="lg:h-full lg:overflow-y-auto lg:p-6">
      <div className="h1-row">
        <h1 className="h1">Календарь</h1>
        <button type="button" className="btn btn-sm" onClick={() => { const d = new Date(); setCursor(d); setSelected(localDayKey(d)); }}>
          Сегодня
        </button>
      </div>

      {loadError ? <div role="alert" className="alert alert-err">{loadError}</div> : null}

      <div className="card" style={{ padding: '12px 10px 10px' }}>
        <div className="t-row" style={{ alignItems: 'center', marginBottom: 6, padding: '0 4px' }}>
          <span className="grow" style={{ fontSize: 17, fontWeight: 700 }}>
            {cap(new Date(year, month, 1).toLocaleDateString('ru-RU', { month: 'long', year: 'numeric' }))}
          </span>
          <button type="button" aria-label="Предыдущий месяц" className="btn-icon" onClick={() => setCursor(new Date(year, month - 1, 1))}>
            <ChevronLeft aria-hidden="true" />
          </button>
          <button type="button" aria-label="Следующий месяц" className="btn-icon" onClick={() => setCursor(new Date(year, month + 1, 1))}>
            <ChevronRight aria-hidden="true" />
          </button>
        </div>

        <div className="cal">
          {WEEKDAYS.map((label) => <div key={label} className="cal-wd">{label}</div>)}
          {cells.map((day, index) => {
            if (day === null) return <div key={`pad-${index}`} />;
            const key = localDayKey(new Date(year, month, day));
            const dayTasks = byDay.get(key) ?? [];
            const cls = ['cal-day', key === todayKey ? 'is-today' : '', key === selected ? 'is-sel' : ''].filter(Boolean).join(' ');
            return (
              <button key={key} type="button" className={cls} aria-pressed={key === selected} onClick={() => setSelected(key)}>
                <span className="cal-n">{day}</span>
                <span className="cal-dots" aria-hidden="true">
                  {dayTasks.slice(0, MAX_DOTS_PER_DAY).map(({ task }) => (
                    <span key={task.id} className={`dot ${isTaskOverdue(task) ? 'bg-red-500' : PRIORITY_DOT[task.priority]}`} />
                  ))}
                  {dayTasks.length > MAX_DOTS_PER_DAY ? <span className="cal-more">+</span> : null}
                </span>
              </button>
            );
          })}
        </div>
      </div>

      <h2 className="sec-title">
        {cap(selectedDate.toLocaleDateString('ru-RU', { weekday: 'long', day: 'numeric', month: 'long' }))}
      </h2>
      {loading ? (
        <p className="muted">Загрузка…</p>
      ) : selectedTasks.length === 0 ? (
        <p className="muted" style={{ padding: '4px 4px 0' }}>На этот день сроков нет.</p>
      ) : (
        <ul className="stack">
          {selectedTasks.map(({ task, projectName }) => {
            const overdue = isTaskOverdue(task);
            const who = usersById.get(assigneeKey(task))?.name ?? task.assignees?.[0]?.user_name;
            return (
              <li key={task.id}>
                <button type="button" onClick={() => setViewing(task)} className={`card card-tap${overdue ? ' is-overdue' : ''}`}>
                  <span className="t-row" style={{ alignItems: 'center', gap: 10 }}>
                    <span className={`dot ${PRIORITY_DOT[task.priority]}`} aria-hidden="true" />
                    <span className="grow">
                      <span className="t-title">{task.title}</span>
                      <span className="t-meta">
                        {who ? <span>{who}</span> : null}
                        {who ? <span>·</span> : null}
                        <span>{projectName}</span>
                        {overdue ? <><span>·</span><span className="c-red">просрочено</span></> : null}
                      </span>
                    </span>
                  </span>
                </button>
              </li>
            );
          })}
        </ul>
      )}

      {undated > 0 ? (
        <p className="hint" style={{ marginTop: 14 }}>Без срока: {undated} -- такие задачи в сетку не попадают.</p>
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
