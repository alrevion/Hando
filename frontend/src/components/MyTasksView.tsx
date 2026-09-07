import { useMemo, useState } from 'react';
import { Lock } from 'lucide-react';
import type { Priority, Task, User } from '../types';
import { useOrgTasks } from '../hooks/useOrgTasks';
import { PRIORITIES, PRIORITY_DOT, PRIORITY_LABEL } from '../lib/priority';
import { formatDeadlineDays, isTaskOverdue } from '../lib/overdue';
import { TaskDetailModal } from './TaskDetailModal';
import { isMine } from '../lib/tasks';

// Порядок срочности берётся из самого PRIORITIES: он уже перечислен от «Срочно»
// к «Низко». Отдельная таблица порядка означала бы вторую копию, которую однажды
// поправят только в одном месте.
const PRIORITY_RANK: Record<Priority, number> = Object.fromEntries(
  PRIORITIES.map((p, index) => [p.value, index]),
) as Record<Priority, number>;

/**
 * Экран сотрудника: «что делать раньше, что позже». Один сквозной список своих
 * задач по всем доскам, отсортированный ровно так, как принимает заказчик --
 * срочность, потом срок, потом заблокированность.
 *
 * Список нумерованный, а не колонками: колонки отвечают на вопрос «в каком
 * состоянии задача», а сотруднику нужен ответ на «что брать следующим», и он
 * читается только из одной сквозной очереди.
 */
export function MyTasksView({ user }: { user: User }) {
  const { tasks, loading, loadError } = useOrgTasks();
  const [viewing, setViewing] = useState<Task | null>(null);

  // Предшественника ищем среди ВСЕХ видимых задач, а не только своих: он лежит
  // в том же проекте, но отвечать за него может кто угодно.
  const byId = useMemo(() => new Map(tasks.map(({ task }) => [task.id, task])), [tasks]);

  const queue = useMemo(() => {
    const rows = tasks
      .filter(({ task }) => isMine(task, user.id) && (task.status === 'todo' || task.status === 'in_progress'))
      .map((row) => {
        const dep = row.task.depends_on_task_id ? byId.get(row.task.depends_on_task_id) : undefined;
        // То же правило, что на доске: нет строки, done или archived -- не держит.
        const blockedBy = dep && dep.status !== 'done' && dep.status !== 'archived' ? dep.title : undefined;
        return { ...row, blockedBy };
      });

    return rows.sort((a, b) => {
      const byPriority = PRIORITY_RANK[a.task.priority] - PRIORITY_RANK[b.task.priority];
      if (byPriority !== 0) return byPriority;
      // Задача без срока уходит вниз своей группы срочности: «когда-нибудь» не
      // конкурирует с назначенной датой. Сравнение через Infinity сложением не
      // делаем -- Infinity - Infinity даёт NaN и ломает сортировку.
      const aDue = a.task.deadline ? Date.parse(a.task.deadline) : Number.POSITIVE_INFINITY;
      const bDue = b.task.deadline ? Date.parse(b.task.deadline) : Number.POSITIVE_INFINITY;
      if (aDue !== bDue) return aDue < bDue ? -1 : 1;
      return Number(Boolean(a.blockedBy)) - Number(Boolean(b.blockedBy));
    });
  }, [tasks, byId, user.id]);

  // Сданное на проверку из очереди убрано (делать там нечего), но счётчик нужен:
  // иначе задача исчезает с экрана и выглядит потерянной.
  const awaitingReview = tasks.filter(
    ({ task }) => isMine(task, user.id) && task.status === 'done' && !task.confirmed_at,
  ).length;

  return (
    <div className="lg:h-full lg:overflow-y-auto lg:p-6">
      <div className="h1-row">
        <h1 className="h1">Мои задачи</h1>
        {awaitingReview > 0 ? <span className="pill pill-green">На проверке · {awaitingReview}</span> : null}
      </div>

      {loadError ? <div role="alert" className="alert alert-err">{loadError}</div> : null}

      {loading ? (
        <p className="muted">Загрузка…</p>
      ) : queue.length === 0 ? (
        <div className="empty">
          <b>Активных задач нет</b>
          Новые поручения появятся здесь и в боте.
        </div>
      ) : (
        <ol className="stack">
          {queue.map(({ task, projectName, blockedBy }, index) => {
            const overdue = isTaskOverdue(task);
            return (
              <li key={task.id}>
                <button
                  type="button"
                  onClick={() => setViewing(task)}
                  className={`card card-tap${overdue ? ' is-overdue' : ''}`}
                >
                  <span className="t-row">
                    <span className="num">{index + 1}</span>
                    <span className="grow">
                      <span className="t-title">{task.title}</span>
                      <span className="t-meta">
                        <span className={`dot ${PRIORITY_DOT[task.priority]}`} aria-hidden="true" />
                        <span>{PRIORITY_LABEL[task.priority]}</span>
                        <span>·</span>
                        <span>{projectName}</span>
                        {task.deadline ? (
                          <>
                            <span>·</span>
                            <span className={overdue ? 'c-red' : undefined}>{formatDeadlineDays(task.deadline)}</span>
                          </>
                        ) : null}
                      </span>
                      {task.status === 'in_progress' || blockedBy ? (
                        <span className="pills">
                          {task.status === 'in_progress' ? <span className="pill pill-blue">В работе</span> : null}
                          {blockedBy ? (
                            <span className="pill pill-orange" title={`Ждёт задачу «${blockedBy}»`}>
                              <Lock aria-hidden="true" />
                              <span>Ждёт «{blockedBy}»</span>
                            </span>
                          ) : null}
                        </span>
                      ) : null}
                    </span>
                  </span>
                </button>
              </li>
            );
          })}
        </ol>
      )}

      {viewing ? <TaskDetailModal task={viewing} responsible={user} onClose={() => setViewing(null)} /> : null}
    </div>
  );
}
