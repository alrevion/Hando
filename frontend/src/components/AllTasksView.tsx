import { useEffect, useState } from 'react';
import type { Task } from '../types';
import { getSubtreeTasks } from '../lib/api';
import { useData } from '../context/DataContext';
import { TaskMeta } from './TaskMeta';
import { TaskDetailModal } from './TaskDetailModal';
import { isTaskOverdue } from '../lib/overdue';

const STAGE: Record<string, string> = { todo: 'К выполнению', in_progress: 'В работе', done: 'Сдано' };

/** «Все задания»: обзор поддерева -- что делается ниже по дереву, а не вся организация. */
export function AllTasksView() {
  const { projects } = useData();
  const [tasks, setTasks] = useState<Task[] | null>(null);
  const [viewing, setViewing] = useState<Task | null>(null);
  useEffect(() => { getSubtreeTasks().then(setTasks).catch(() => setTasks([])); }, []);
  const nameById = new Map(projects.map((p) => [p.id, p.name]));
  return (
    <div className="lg:h-full lg:overflow-y-auto lg:p-6">
      <h1 className="h1">Все задания</h1>
      <p className="hint" style={{ marginTop: -6 }}>Поручения людей вашего поддерева и их авторов — по всем доскам.</p>
      {tasks === null ? <p className="muted">Загрузка…</p> : tasks.length === 0 ? (
        <div className="empty"><b>Пока пусто</b>Здесь появятся задачи тех, кого вы пригласили.</div>
      ) : (['todo', 'in_progress', 'done'] as const).map((st) => {
        const rows = tasks.filter((t) => t.status === st);
        return rows.length === 0 ? null : (
          <section key={st}>
            <h2 className="sec-title">{STAGE[st]} · {rows.length}</h2>
            <ul className="stack">
              {rows.map((task) => (
                <li key={task.id}>
                  <button type="button" className={`card card-tap${isTaskOverdue(task) ? ' is-overdue' : ''}`} onClick={() => setViewing(task)}>
                    <span className="t-title">{task.title}</span>
                    <TaskMeta task={task} projectName={nameById.get(task.project_id) ?? ''} showProject line />
                  </button>
                </li>
              ))}
            </ul>
          </section>
        );
      })}
      {viewing ? <TaskDetailModal task={viewing} responsible={undefined} onClose={() => setViewing(null)} /> : null}
    </div>
  );
}
