import { useMemo, useState } from 'react';
import type { Task, User } from '../types';
import { useOrgTasks } from '../hooks/useOrgTasks';
import { stateLabel } from '../lib/tasks';
import { formatDeadlineDays, isTaskOverdue } from '../lib/overdue';
import { TaskDetailModal } from './TaskDetailModal';

const STATE_TONE: Record<string, string> = {
  pending: 'bg-slate-100 text-slate-600',
  accepted: 'bg-blue-100 text-blue-700',
  done: 'bg-emerald-100 text-emerald-700',
  confirmed: 'bg-emerald-100 text-emerald-700',
  rejected: 'bg-amber-100 text-amber-800',
  declined: 'bg-red-100 text-red-700',
};

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
    <div className="flex h-full flex-col overflow-y-auto p-4">
      <h1 className="mb-3 text-lg font-semibold text-[var(--tg-text,#0f172a)]">Мои поручения</h1>

      {loadError ? (
        <div role="alert" className="mb-3 rounded-lg border border-red-300 bg-red-50 p-2 text-sm text-red-800">{loadError}</div>
      ) : null}

      {loading ? (
        <p className="text-sm text-[var(--tg-hint,#64748b)]">Загрузка…</p>
      ) : mine.length === 0 ? (
        <div className="mt-8 text-center">
          <p className="text-sm text-[var(--tg-hint,#64748b)]">Вы пока ничего не поручали.</p>
          <p className="mt-1 text-xs text-[var(--tg-hint,#94a3b8)]">Наговорите боту: «Азизу завтра подготовить отчёт».</p>
        </div>
      ) : (
        <ul className="space-y-2">
          {mine.map(({ task, projectName }) => {
            const overdue = isTaskOverdue(task);
            return (
              <li key={task.id}>
                <button
                  type="button"
                  onClick={() => setViewing(task)}
                  className={`w-full rounded-xl border p-3 text-left transition-colors active:opacity-70 ${
                    overdue ? 'border-red-300' : 'border-[var(--tg-separator,#e2e8f0)]'
                  } bg-[var(--tg-section-bg,#fff)]`}
                >
                  <span className="block truncate text-sm font-medium text-[var(--tg-text,#0f172a)]">{task.title}</span>
                  <span className="mt-1.5 flex flex-wrap items-center gap-1.5">
                    {(task.assignees ?? []).filter((a) => a.user_id !== user.id).map((a) => (
                      <span key={a.user_id} className={`rounded-full px-2 py-0.5 text-xs font-medium ${STATE_TONE[a.state] ?? 'bg-slate-100 text-slate-600'}`}>
                        {a.user_name} · {stateLabel(a.state)}
                      </span>
                    ))}
                  </span>
                  <span className="mt-1.5 flex items-center gap-2 text-xs text-[var(--tg-hint,#64748b)]">
                    <span className="truncate">{projectName}</span>
                    {task.deadline ? (
                      <span className={overdue ? 'text-red-600' : ''}>{formatDeadlineDays(task.deadline)}</span>
                    ) : null}
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
