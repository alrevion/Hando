import { useMemo, useState } from 'react';
import { Check, Trash2, UserRound, X } from 'lucide-react';
import type { Task, User } from '../types';
import { useOrgTasks } from '../hooks/useOrgTasks';
import { useData } from '../context/DataContext';
import { isTaskOverdue } from '../lib/overdue';
import { ApiError, confirmTask, deleteTask, rejectTask, updateTask } from '../lib/api';
import { toast } from '../lib/toast';
import { TaskDetailModal } from './TaskDetailModal';
import { TaskMeta } from './TaskMeta';
import { RejectTaskModal } from './RejectTaskModal';
import { Sheet } from './Sheet';

/**
 * «Поручения» -- что я раздал, по этапам (раздел 22): к выполнению, в работе,
 * сдано. Сданное принимают или возвращают здесь; любое живое -- переназначают
 * или удаляют. Директор открывает приложение ради этого экрана.
 */
const PAGE = 10;

export function AssignedView({ user }: { user: User }) {
  const { tasks, projects, loading, loadError } = useOrgTasks();
  const { users, refresh } = useData();
  const [viewing, setViewing] = useState<Task | null>(null);
  const [rejecting, setRejecting] = useState<Task | null>(null);
  const [reassigning, setReassigning] = useState<Task | null>(null);
  // Занятые задачи -- множество: действие по одной не должно разблокировать другую.
  const [busy, setBusy] = useState<Set<string>>(new Set());

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
  // Этапы -- сегментами, как были колонки доски: один этап на экране, а не три
  // списка подряд. Доску убрали, а её главное свойство («вижу, что где стоит»)
  // осталось здесь.
  const sections = [
    { key: 'todo', title: 'К выполнению', rows: mine.filter(({ task }) => task.status === 'todo') },
    { key: 'in_progress', title: 'В работе', rows: mine.filter(({ task }) => task.status === 'in_progress') },
    { key: 'done', title: 'Сдано', rows: mine.filter(({ task }) => task.status === 'done') },
  ];
  const [stage, setStage] = useState(0);
  // Длинные списки грузятся порциями: на сотне поручений экран иначе думает
  // секунду только на отрисовку.
  const [shown, setShown] = useState(PAGE);
  const current = sections[stage];
  const visible = current.rows.slice(0, shown);

  /** true -- получилось; ошибку показывает тостом, а шторка решает сама, закрываться ли. */
  async function act(task: Task, fn: () => Promise<unknown>, done: string): Promise<boolean> {
    setBusy((b) => new Set(b).add(task.id));
    try { await fn(); toast(done); await refresh(); return true; } catch (err) { toast(err instanceof ApiError ? err.message : 'Не получилось.'); return false; } finally { setBusy((b) => { const n = new Set(b); n.delete(task.id); return n; }); }
  }

  return (
    <div className="lg:h-full lg:overflow-y-auto lg:p-6">
      <h1 className="h1">Мои поручения</h1>
      {loadError ? <div role="alert" className="alert alert-err">{loadError}</div> : null}

      {loading ? (
        <p className="muted">Загрузка…</p>
      ) : mine.length === 0 ? (
        <div className="empty">
          <b>Вы пока ничего не поручали</b>
          Нажмите «+» или наговорите боту: «Азизу завтра подготовить отчёт».
        </div>
      ) : (
        <>
          {/* Этапы -- обычными кнопками, теми же, что фильтры срока и важности:
              сегментный переключатель обещает «одно из», а тут это просто
              фильтр списка, и живёт он в том же языке, что остальной экран. */}
          {/* Отступ до списка -- как у заголовка раздела: кнопки этапа не должны
              липнуть к первой карточке. */}
          <div className="chips" style={{ paddingBottom: 16 }} aria-label="Этап">
            {sections.map((sec, i) => (
              <button key={sec.key} type="button" aria-pressed={i === stage}
                className={i === stage ? 'chip on' : 'chip'}
                onClick={() => { setStage(i); setShown(PAGE); }}>
                {sec.title}{sec.rows.length > 0 ? ` · ${sec.rows.length}` : ''}
              </button>
            ))}
          </div>

          {current.rows.length === 0 ? <p className="muted" style={{ marginTop: 16 }}>Здесь пока пусто.</p> : null}
          <ul className="stack">
            {visible.map(({ task, projectName }) => {
              const isBusy = busy.has(task.id);
              return (
                <li key={task.id} className={`card${isTaskOverdue(task) ? ' is-overdue' : ''}`}>
                  <button type="button" style={{ display: 'block', width: '100%', textAlign: 'left', background: 'none', border: 'none', padding: 0, font: 'inherit', color: 'inherit' }} onClick={() => setViewing(task)}>
                    <span className="t-title">{task.title}</span>
                    <TaskMeta task={task} projectName={projectName} showProject={projects.length > 1} line showStage={false}
                      who={(task.assignees ?? []).filter((a) => a.user_id !== user.id).map((a) => ({ name: a.user_name, state: a.state }))} />
                  </button>
                  <div className="btn-row" style={{ marginTop: 10 }}>
                    {task.status === 'done' && !task.confirmed_at ? (
                      <>
                        <button type="button" className="btn btn-sm btn-primary" disabled={isBusy} onClick={() => act(task, () => confirmTask(task.id), 'Принято')}>
                          <Check aria-hidden="true" style={{ width: 14, height: 14 }} />Принять
                        </button>
                        <button type="button" className="btn btn-sm" disabled={isBusy} onClick={() => setRejecting(task)}>
                          <X aria-hidden="true" style={{ width: 14, height: 14 }} />Вернуть
                        </button>
                      </>
                    ) : task.status === 'done' ? (
                      <span className="pill pill-green"><span>Принято</span></span>
                    ) : (
                      <>
                        {task.kind === 'single' ? (
                          <button type="button" className="btn btn-sm" disabled={isBusy} onClick={() => setReassigning(task)}>
                            <UserRound aria-hidden="true" style={{ width: 14, height: 14 }} />Переназначить
                          </button>
                        ) : null}
                        <button type="button" className="btn btn-sm btn-danger" disabled={isBusy} onClick={() => { if (window.confirm(`Удалить «${task.title}»?`)) void act(task, () => deleteTask(task.id), 'Удалено'); }}>
                          <Trash2 aria-hidden="true" style={{ width: 14, height: 14 }} />Удалить
                        </button>
                      </>
                    )}
                  </div>
                </li>
              );
            })}
          </ul>
          {current.rows.length > visible.length ? (
            <button type="button" className="btn" style={{ marginTop: 12 }} onClick={() => setShown((n) => n + PAGE)}>
              Показать ещё
            </button>
          ) : null}
        </>
      )}

      {rejecting ? (
        <RejectTaskModal task={rejecting} onClose={() => setRejecting(null)}
          onReject={async (comment, extraDays) => { if (!(await act(rejecting, () => rejectTask(rejecting.id, comment, extraDays), 'Возвращено в работу'))) throw new Error('Не получилось.'); }} />
      ) : null}
      {reassigning ? (
        <Sheet labelledBy="reassign-title" onClose={() => setReassigning(null)}>
          <div className="sheet-head">
            <h2 id="reassign-title" className="sheet-title">Кому переназначить</h2>
            <button type="button" onClick={() => setReassigning(null)} aria-label="Закрыть" className="btn-icon"><X aria-hidden="true" /></button>
          </div>
          <ul className="stack">
            {users.filter((u) => u.id !== user.id && !u.frozen_at).map((u) => (
              <li key={u.id}>
                <button type="button" className="card card-tap" onClick={async () => {
                  const t = reassigning; setReassigning(null);
                  await act(t, () => updateTask(t.id, { responsible_user_id: u.id }), `Теперь у ${u.name}`);
                }}>
                  <span className="t-title">{u.name}</span>
                  {u.position ? <span className="t-meta"><span>{u.position}</span></span> : null}
                </button>
              </li>
            ))}
          </ul>
        </Sheet>
      ) : null}
      {viewing ? <TaskDetailModal task={viewing} responsible={undefined} onClose={() => setViewing(null)} /> : null}
    </div>
  );
}
