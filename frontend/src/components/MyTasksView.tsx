import { useMemo, useState } from 'react';
import { ArrowRight, Check, Clock, Lock, XCircle } from 'lucide-react';
import type { Priority, Task, User } from '../types';
import { useOrgTasks } from '../hooks/useOrgTasks';
import { PRIORITIES } from '../lib/priority';
import { isTaskOverdue } from '../lib/overdue';
import { ApiError, declineTask, lateTask, moveTask } from '../lib/api';
import { useData } from '../context/DataContext';
import { toast } from '../lib/toast';
import { TaskDetailModal } from './TaskDetailModal';
import { TaskMeta } from './TaskMeta';
import { AskText } from './AskText';
import { isMine, myRow } from '../lib/tasks';

const PRIORITY_RANK: Record<Priority, number> = Object.fromEntries(
  PRIORITIES.map((p, index) => [p.value, index]),
) as Record<Priority, number>;

type Section = { key: 'todo' | 'in_progress' | 'review'; title: string; rows: ReturnType<typeof useOrgTasks>['tasks'] };

/**
 * «Задачи»: что поручили мне -- этапы прямо в списке (раздел 22). Здесь и
 * нажимают «Взять в работу», «Готово», «Не успею», «Отказать» -- те же
 * действия, что кнопки под карточкой в боте, кроме «Готово»: сдают только тут.
 */
export function MyTasksView({ user }: { user: User }) {
  const { tasks, projects, loading, loadError } = useOrgTasks();
  const { refresh } = useData();
  const [viewing, setViewing] = useState<Task | null>(null);
  const [asking, setAsking] = useState<{ task: Task; kind: 'late' | 'decline' } | null>(null);
  const [busy, setBusy] = useState<string | null>(null);

  const byId = useMemo(() => new Map(tasks.map(({ task }) => [task.id, task])), [tasks]);
  const sort = (rows: typeof tasks) => [...rows].sort((a, b) => {
    const p = PRIORITY_RANK[a.task.priority] - PRIORITY_RANK[b.task.priority];
    if (p !== 0) return p;
    const ad = a.task.deadline ? Date.parse(a.task.deadline) : Number.POSITIVE_INFINITY;
    const bd = b.task.deadline ? Date.parse(b.task.deadline) : Number.POSITIVE_INFINITY;
    return ad === bd ? 0 : ad < bd ? -1 : 1;
  });

  const mine = tasks.filter(({ task }) => isMine(task, user.id));
  const sections: Section[] = [
    { key: 'todo', title: 'К выполнению', rows: sort(mine.filter(({ task }) => task.status === 'todo' && myRow(task, user.id)?.state === 'pending')) },
    { key: 'in_progress', title: 'В работе', rows: sort(mine.filter(({ task }) => { const s = myRow(task, user.id)?.state; return s === 'accepted' || s === 'rejected'; })) },
    { key: 'review', title: 'Сдано, на проверке', rows: sort(mine.filter(({ task }) => myRow(task, user.id)?.state === 'done' && !task.confirmed_at)) },
  ];
  const total = sections.reduce((n, s) => n + s.rows.length, 0);

  async function act(task: Task, fn: () => Promise<unknown>, done: string) {
    setBusy(task.id);
    try {
      await fn();
      toast(done);
      await refresh();
    } catch (err) {
      toast(err instanceof ApiError ? err.message : 'Не получилось.');
    } finally {
      setBusy(null);
    }
  }

  return (
    <div className="lg:h-full lg:overflow-y-auto lg:p-6">
      <h1 className="h1">Мои задачи</h1>
      {loadError ? <div role="alert" className="alert alert-err">{loadError}</div> : null}

      {loading ? (
        <p className="muted">Загрузка…</p>
      ) : total === 0 ? (
        <div className="empty">
          <b>Активных задач нет</b>
          Новые поручения появятся здесь и в боте.
        </div>
      ) : sections.map((sec) => sec.rows.length === 0 ? null : (
        <section key={sec.key}>
          <h2 className="sec-title">{sec.title} · {sec.rows.length}</h2>
          <ul className="stack">
            {sec.rows.map(({ task, projectName }) => {
              const dep = task.depends_on_task_id ? byId.get(task.depends_on_task_id) : undefined;
              const blockedBy = dep && dep.status !== 'done' && dep.status !== 'archived' ? dep.title : undefined;
              const state = myRow(task, user.id)?.state;
              const isBusy = busy === task.id;
              return (
                <li key={task.id} className={`card${isTaskOverdue(task) ? ' is-overdue' : ''}`}>
                  <button type="button" className="card-tap" style={{ display: 'block', width: '100%', textAlign: 'left', background: 'none', border: 'none', padding: 0, font: 'inherit', color: 'inherit' }} onClick={() => setViewing(task)}>
                    <span className="t-title">{task.title}</span>
                    <TaskMeta task={task} projectName={projectName} showProject={projects.length > 1} line showStage={false}
                      extra={blockedBy ? <span className="pill pill-orange"><Lock aria-hidden="true" /><span>Ждёт «{blockedBy}»</span></span> : null} />
                  </button>
                  {sec.key !== 'review' ? (
                    <div className="btn-row" style={{ marginTop: 10 }}>
                      {state === 'pending' ? (
                        <button type="button" className="btn btn-sm btn-primary" disabled={isBusy || !!blockedBy} onClick={() => act(task, () => moveTask(task.id, 'in_progress'), 'Взято в работу')}>
                          <ArrowRight aria-hidden="true" style={{ width: 14, height: 14 }} />Взять в работу
                        </button>
                      ) : (
                        <button type="button" className="btn btn-sm btn-primary" disabled={isBusy} onClick={() => act(task, () => moveTask(task.id, 'done'), 'Сдано на проверку')}>
                          <Check aria-hidden="true" style={{ width: 14, height: 14 }} />Готово
                        </button>
                      )}
                      <button type="button" className="btn btn-sm" disabled={isBusy} onClick={() => setAsking({ task, kind: 'late' })}>
                        <Clock aria-hidden="true" style={{ width: 14, height: 14 }} />Не успею
                      </button>
                      <button type="button" className="btn btn-sm" disabled={isBusy} onClick={() => setAsking({ task, kind: 'decline' })}>
                        <XCircle aria-hidden="true" style={{ width: 14, height: 14 }} />Отказать
                      </button>
                    </div>
                  ) : null}
                </li>
              );
            })}
          </ul>
        </section>
      ))}

      {asking ? (
        <AskText
          title={asking.kind === 'late' ? 'Почему не успеваете?' : 'Почему отказываетесь?'}
          placeholder={asking.kind === 'late' ? 'Одной фразой — передам автору' : 'Причина — передам автору'}
          submitLabel={asking.kind === 'late' ? 'Передать' : 'Отказаться'}
          danger={asking.kind === 'decline'}
          onSubmit={(text) => act(asking.task, () => asking.kind === 'late' ? lateTask(asking.task.id, text) : declineTask(asking.task.id, text), 'Передано автору')}
          onClose={() => setAsking(null)}
        />
      ) : null}
      {viewing ? <TaskDetailModal task={viewing} responsible={user} onClose={() => setViewing(null)} /> : null}
    </div>
  );
}
