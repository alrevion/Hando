import { useMemo, useState } from 'react';
import { Lock } from 'lucide-react';
import type { Priority, Task, TaskStatus, User } from '../types';
import { useOrgTasks } from '../hooks/useOrgTasks';
import { PRIORITIES, PRIORITY_DOT, PRIORITY_LABEL } from '../lib/priority';
import { formatDeadlineDays, isTaskOverdue } from '../lib/overdue';
import { TaskDetailModal } from './TaskDetailModal';

// Порядок срочности берётся из самого PRIORITIES: он уже перечислен от «Срочно»
// к «Низко». Отдельная таблица порядка означала бы вторую копию, которую однажды
// поправят только в одном месте.
const PRIORITY_RANK: Record<Priority, number> = Object.fromEntries(
  PRIORITIES.map((p, index) => [p.value, index]),
) as Record<Priority, number>;

const STATUS_LABEL: Partial<Record<TaskStatus, string>> = {
  todo: 'К выполнению',
  in_progress: 'В работе',
};

function formatDeadline(deadline: string) {
  const d = new Date(deadline);
  if (Number.isNaN(d.getTime())) return deadline;
  return d.toLocaleDateString();
}

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
      .filter(({ task }) => task.responsible_user_id === user.id && (task.status === 'todo' || task.status === 'in_progress'))
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
    ({ task }) => task.responsible_user_id === user.id && task.status === 'done' && !task.confirmed_at,
  ).length;

  return (
    <div className="flex h-full flex-col overflow-y-auto p-6">
      <div className="mb-4 flex flex-wrap items-baseline justify-between gap-2">
        <h1 className="text-xl font-semibold text-slate-900">Мои задачи</h1>
        {awaitingReview > 0 ? (
          <span className="rounded-full bg-slate-200 px-2.5 py-1 text-xs font-medium text-slate-700">
            На проверке: {awaitingReview}
          </span>
        ) : null}
      </div>

      {loadError ? (
        <div role="alert" className="mb-3 rounded-md border border-red-300 bg-red-50 p-2 text-sm text-red-800">
          {loadError}
        </div>
      ) : null}

      {loading ? (
        <p className="text-sm text-slate-500">Загрузка…</p>
      ) : queue.length === 0 ? (
        <p className="text-sm text-slate-500">Активных задач нет.</p>
      ) : (
        <ol className="space-y-2">
          {queue.map(({ task, projectName, blockedBy }, index) => {
            const overdue = isTaskOverdue(task);
            return (
              <li key={task.id}>
                <button
                  type="button"
                  onClick={() => setViewing(task)}
                  className={`flex w-full items-start gap-3 rounded-lg border bg-white p-3 text-left hover:shadow-md ${
                    overdue ? 'border-red-300' : 'border-slate-200'
                  }`}
                >
                  <span className="mt-0.5 w-6 shrink-0 text-sm font-semibold tabular-nums text-slate-400">{index + 1}</span>
                  <span className="min-w-0 flex-1">
                    <span className="block truncate text-sm font-medium text-slate-900">{task.title}</span>
                    <span className="mt-1 flex flex-wrap items-center gap-1.5">
                      <span className="inline-flex items-center gap-1 rounded-full bg-slate-100 px-2 py-0.5 text-xs font-medium text-slate-600">
                        <span className={`h-1.5 w-1.5 rounded-full ${PRIORITY_DOT[task.priority]}`} aria-hidden="true" />
                        {PRIORITY_LABEL[task.priority]}
                      </span>
                      {task.deadline ? (
                        <span
                          className={`rounded-full px-2 py-0.5 text-xs font-medium ${
                            overdue ? 'bg-red-100 text-red-700' : 'bg-slate-100 text-slate-600'
                          }`}
                        >
                          {formatDeadline(task.deadline)} · {formatDeadlineDays(task.deadline)}
                        </span>
                      ) : (
                        <span className="rounded-full bg-slate-100 px-2 py-0.5 text-xs font-medium text-slate-500">
                          без срока
                        </span>
                      )}
                      <span className="rounded-full bg-slate-100 px-2 py-0.5 text-xs font-medium text-slate-600">
                        {STATUS_LABEL[task.status]}
                      </span>
                      <span className="truncate text-xs text-slate-500">{projectName}</span>
                      {blockedBy ? (
                        <span
                          className="inline-flex items-center gap-1 rounded-full bg-amber-100 px-2 py-0.5 text-xs font-medium text-amber-800"
                          title={`Ждёт задачу «${blockedBy}»`}
                        >
                          <Lock className="h-3 w-3" aria-hidden="true" />
                          Ждёт «{blockedBy}»
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
