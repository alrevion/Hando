import { useMemo, useState } from 'react';
import { ChevronDown, ChevronRight } from 'lucide-react';
import type { Task, User } from '../types';
import { useOrgTasks, useOrgUsers, type OrgTask } from '../hooks/useOrgTasks';
import { userBadgeColor } from '../lib/badgeColor';
import { PRIORITY_DOT, PRIORITY_LABEL } from '../lib/priority';
import { formatDeadlineDays, isTaskOverdue } from '../lib/overdue';
import { TaskDetailModal } from './TaskDetailModal';

const STAGE_LABEL: Record<'todo' | 'in_progress' | 'done', string> = {
  todo: 'Не начато',
  in_progress: 'В работе',
  done: 'На проверке',
};

interface PersonRow {
  user: User;
  todo: OrgTask[];
  in_progress: OrgTask[];
  done: OrgTask[]; // сдано, но ещё не подтверждено -- этап руководителя, не сотрудника
  overdue: number;
}

/**
 * Экран руководителя: кто на каком этапе. Одна строка на человека и три этапа
 * в ней -- это и есть «полная картина»: доска показывает этапы одного проекта,
 * а вопрос руководителя («у кого что висит») ставится по людям и всегда
 * пересекает доски.
 *
 * Люди берутся из справочника организации, а не из задач: человек без задач --
 * это тоже ответ, и в списке задач его не видно.
 */
export function PeopleView() {
  const { tasks, loading, loadError } = useOrgTasks();
  const { users, forbidden } = useOrgUsers();
  const [expandedId, setExpandedId] = useState<string | null>(null);
  const [viewing, setViewing] = useState<{ task: Task; responsible: User | undefined } | null>(null);

  const rows = useMemo<PersonRow[]>(() => {
    const list = users.map((user) => {
      const own = tasks.filter(({ task }) => task.responsible_user_id === user.id);
      return {
        user,
        todo: own.filter(({ task }) => task.status === 'todo'),
        in_progress: own.filter(({ task }) => task.status === 'in_progress'),
        // Подтверждённое сюда не попадает: этап закрыт, руководителю там делать нечего.
        done: own.filter(({ task }) => task.status === 'done' && !task.confirmed_at),
        overdue: own.filter(({ task }) => isTaskOverdue(task)).length,
      };
    });
    // Наверх -- те, у кого горит: просрочки, потом объём в работе. Алфавит
    // остаётся последним ключом, чтобы порядок не прыгал при равных числах.
    return list.sort(
      (a, b) =>
        b.overdue - a.overdue ||
        b.in_progress.length - a.in_progress.length ||
        a.user.name.localeCompare(b.user.name),
    );
  }, [tasks, users]);

  return (
    <div className="flex h-full flex-col overflow-y-auto p-6">
      <h1 className="mb-4 text-xl font-semibold text-slate-900">Люди</h1>

      {loadError ? (
        <div role="alert" className="mb-3 rounded-md border border-red-300 bg-red-50 p-2 text-sm text-red-800">
          {loadError}
        </div>
      ) : null}
      {forbidden ? (
        <div role="alert" className="mb-3 rounded-md border border-amber-300 bg-amber-50 p-2 text-sm text-amber-800">
          Справочник организации доступен только руководителям.
        </div>
      ) : null}

      {loading ? (
        <p className="text-sm text-slate-500">Загрузка…</p>
      ) : rows.length === 0 ? (
        <p className="text-sm text-slate-500">В организации пока никого нет.</p>
      ) : (
        <ul className="space-y-2">
          {rows.map((row) => {
            const expanded = expandedId === row.user.id;
            const active = [...row.todo, ...row.in_progress, ...row.done];
            return (
              <li key={row.user.id} className="rounded-lg border border-slate-200 bg-white">
                <button
                  type="button"
                  onClick={() => setExpandedId(expanded ? null : row.user.id)}
                  aria-expanded={expanded}
                  className="flex w-full items-center gap-3 p-3 text-left"
                >
                  {expanded ? (
                    <ChevronDown className="h-4 w-4 shrink-0 text-slate-400" aria-hidden="true" />
                  ) : (
                    <ChevronRight className="h-4 w-4 shrink-0 text-slate-400" aria-hidden="true" />
                  )}
                  <span
                    className={`min-w-0 truncate rounded-full px-2 py-0.5 text-xs font-medium ${userBadgeColor(row.user.id)}`}
                  >
                    {row.user.name}
                  </span>
                  {/* Без Telegram-хэндла человека нельзя ни упомянуть, ни довести
                      до него уведомление -- на экране руководителя это такой же
                      факт о ходе работы, как счётчики этапов. */}
                  {row.user.telegram_username ? null : (
                    <span className="shrink-0 rounded-full bg-amber-100 px-2 py-0.5 text-xs font-medium text-amber-800">
                      не подключён
                    </span>
                  )}
                  <span className="ml-auto flex shrink-0 flex-wrap items-center gap-1.5">
                    <span className="rounded-full bg-slate-100 px-2 py-0.5 text-xs font-medium text-slate-600">
                      {STAGE_LABEL.todo}: {row.todo.length}
                    </span>
                    <span className="rounded-full bg-blue-50 px-2 py-0.5 text-xs font-medium text-blue-700">
                      {STAGE_LABEL.in_progress}: {row.in_progress.length}
                    </span>
                    <span className="rounded-full bg-emerald-50 px-2 py-0.5 text-xs font-medium text-emerald-700">
                      {STAGE_LABEL.done}: {row.done.length}
                    </span>
                    {row.overdue > 0 ? (
                      <span className="rounded-full bg-red-100 px-2 py-0.5 text-xs font-medium text-red-700">
                        просрочено: {row.overdue}
                      </span>
                    ) : null}
                  </span>
                </button>

                {expanded ? (
                  <ul className="border-t border-slate-100 p-3 pt-2">
                    {active.length === 0 ? (
                      <li className="text-xs text-slate-500">Активных задач нет.</li>
                    ) : (
                      active.map(({ task, projectName }) => (
                        <li key={task.id}>
                          <button
                            type="button"
                            onClick={() => setViewing({ task, responsible: row.user })}
                            className="flex w-full items-center gap-2 rounded px-1 py-1 text-left hover:bg-slate-50"
                          >
                            <span className={`h-1.5 w-1.5 shrink-0 rounded-full ${PRIORITY_DOT[task.priority]}`} aria-hidden="true" />
                            <span className="min-w-0 flex-1 truncate text-sm text-slate-800">{task.title}</span>
                            <span className="shrink-0 text-xs text-slate-500">{projectName}</span>
                            <span className="shrink-0 text-xs text-slate-500">
                              {STAGE_LABEL[task.status as 'todo' | 'in_progress' | 'done']}
                            </span>
                            {task.deadline ? (
                              <span
                                className={`shrink-0 text-xs ${isTaskOverdue(task) ? 'font-medium text-red-700' : 'text-slate-500'}`}
                              >
                                {formatDeadlineDays(task.deadline)}
                              </span>
                            ) : (
                              <span className="shrink-0 text-xs text-slate-400">{PRIORITY_LABEL[task.priority]}</span>
                            )}
                          </button>
                        </li>
                      ))
                    )}
                  </ul>
                ) : null}
              </li>
            );
          })}
        </ul>
      )}

      {viewing ? (
        <TaskDetailModal task={viewing.task} responsible={viewing.responsible} onClose={() => setViewing(null)} />
      ) : null}
    </div>
  );
}
