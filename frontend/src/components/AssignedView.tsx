import { useMemo, useState } from 'react';
import type { Task, User } from '../types';
import { useOrgTasks } from '../hooks/useOrgTasks';
import { STATE_PILL, stateLabel } from '../lib/tasks';
import { formatDeadlineDays, isTaskOverdue } from '../lib/overdue';
import { TaskDetailModal } from './TaskDetailModal';

/**
 * «Мои поручения» -- что человек раздал и кто на каком этапе.
 *
 * Отдельный экран от «Моих задач» по смыслу: сюда смотрят, чтобы узнать чужой
 * прогресс, а не чтобы понять, что делать самому. Директор открывает приложение
 * ради этого экрана, поэтому у него он первый.
 */
export function AssignedView({ user }: { user: User }) {
  const { tasks, loading, loadError } = useOrgTasks();
  const [viewing, setViewing] = useState<Task | null>(null);

  const mine = useMemo(
    () => tasks
      .filter(({ task }) => task.author_id === user.id && (task.assignees ?? []).some((a) => a.user_id !== user.id))
      .sort((a, b) => {
        const ad = a.task.deadline ? Date.parse(a.task.deadline) : Number.POSITIVE_INFINITY;
        const bd = b.task.deadline ? Date.parse(b.task.deadline) : Number.POSITIVE_INFINITY;
        return ad === bd ? 0 : ad < bd ? -1 : 1;
      }),
    [tasks, user.id],
  );

  return (
    <div className="lg:h-full lg:overflow-y-auto lg:p-6">
      <h1 className="h1">Мои поручения</h1>

      {loadError ? <div role="alert" className="alert alert-err">{loadError}</div> : null}

      {loading ? (
        <p className="muted">Загрузка…</p>
      ) : mine.length === 0 ? (
        <div className="empty">
          <b>Вы пока ничего не поручали</b>
          Наговорите боту: «Азизу завтра подготовить отчёт» -- и поручение появится здесь.
        </div>
      ) : (
        <ul className="stack">
          {mine.map(({ task, projectName }) => {
            const overdue = isTaskOverdue(task);
            return (
              <li key={task.id}>
                <button
                  type="button"
                  onClick={() => setViewing(task)}
                  className={`card card-tap${overdue ? ' is-overdue' : ''}`}
                >
                  <span className="t-title">{task.title}</span>
                  <span className="t-meta">
                    <span>{projectName}</span>
                    {task.deadline ? (
                      <>
                        <span>·</span>
                        <span className={overdue ? 'c-red' : undefined}>{formatDeadlineDays(task.deadline)}</span>
                      </>
                    ) : null}
                  </span>
                  <span className="pills">
                    {(task.assignees ?? []).filter((a) => a.user_id !== user.id).map((a) => (
                      <span key={a.user_id} className={STATE_PILL[a.state] ?? 'pill'}>
                        <span>{a.user_name} · {stateLabel(a.state)}</span>
                      </span>
                    ))}
                  </span>
                </button>
              </li>
            );
          })}
        </ul>
      )}

      {viewing ? <TaskDetailModal task={viewing} responsible={undefined} onClose={() => setViewing(null)} /> : null}
    </div>
  );
}
