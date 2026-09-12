import { useEffect, useState } from 'react';
import { ShowMore, usePaging } from './ShowMore';
import type { Task } from '../types';
import { getSubtreeTasks } from '../lib/api';
import { useData } from '../context/DataContext';
import { TaskMeta } from './TaskMeta';
import { TaskDetailModal } from './TaskDetailModal';
import { isTaskOverdue } from '../lib/overdue';

const STAGE: Record<string, string> = { todo: 'К выполнению', in_progress: 'Принято', done: 'Сдано' };

/** «Все задания»: обзор поддерева -- что делается ниже по дереву, а не вся организация. */
export function AllTasksView() {
  const { projects } = useData();
  const [tasks, setTasks] = useState<Task[] | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [viewing, setViewing] = useState<Task | null>(null);
  useEffect(() => { getSubtreeTasks().then(setTasks).catch(() => { setError('Не удалось загрузить.'); setTasks([]); }); }, []);
  const nameById = new Map(projects.map((p) => [p.id, p.name]));
  return (
    <div className="lg:h-full lg:overflow-y-auto lg:p-6">
      <h1 className="h1">Все задания</h1>
      <p className="hint" style={{ marginTop: -6 }}>Поручения людей вашего поддерева и их авторов — по всем доскам.</p>
      {error ? <div role="alert" className="alert alert-err">{error}</div> : null}
      {tasks === null ? <p className="muted">Загрузка…</p> : error ? null : tasks.length === 0 ? (
        <div className="empty"><b>Пока пусто</b>Здесь появятся задачи тех, кого вы пригласили.</div>
      ) : (['todo', 'in_progress', 'done'] as const).map((st) => (
        <Stage key={st} title={STAGE[st]} rows={tasks.filter((t) => t.status === st)}
          nameById={nameById} onOpen={setViewing} />
      ))}
      {viewing ? <TaskDetailModal task={viewing} responsible={undefined} onClose={() => setViewing(null)} /> : null}
    </div>
  );
}

/**
 * Один этап списка. Вынесен в компонент не ради красоты, а ради состояния:
 * счётчик показанных строк должен быть СВОЙ у каждого этапа, а хук нельзя
 * звать в цикле.
 */
function Stage({
  title, rows, nameById, onOpen,
}: { title: string; rows: Task[]; nameById: Map<string, string>; onOpen: (t: Task) => void }) {
  const { shown, more } = usePaging(rows.length === 0);
  if (rows.length === 0) return null;
  return (
    <section>
      <h2 className="sec-title">{title} · {rows.length}</h2>
      <ul className="stack">
        {rows.slice(0, shown).map((task) => (
          <li key={task.id}>
            <button type="button" className={`card card-tap${isTaskOverdue(task) ? ' is-overdue' : ''}`} onClick={() => onOpen(task)}>
              <span className="t-title">{task.title}</span>
              <TaskMeta task={task} projectName={nameById.get(task.project_id) ?? ''} showProject />
            </button>
          </li>
        ))}
      </ul>
      <ShowMore total={rows.length} shown={shown} onMore={more} />
    </section>
  );
}
