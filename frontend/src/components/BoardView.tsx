import { useEffect, useMemo, useState, type ReactNode } from 'react';
import { ArrowRight, Check, Pencil, Plus, Trash2, X } from 'lucide-react';
import type { ContentBlock, Priority, Project, Task, TaskStatus, User } from '../types';
import { parseContentBlocks } from '../types';
import {
  ApiError,
  confirmTask,
  createTask,
  deleteAttachment,
  deleteTask,
  moveTask,
  rejectTask,
  updateTask,
  uploadAttachment,
  type TaskInput,
} from '../lib/api';
import { useData } from '../context/DataContext';
import { PRIORITIES } from '../lib/priority';
import type { ComposeBlock } from './ContentEditor';
import { TaskCard } from './TaskCard';
import { TaskDetailModal } from './TaskDetailModal';
import { TaskFormModal } from './TaskFormModal';
import { RejectTaskModal } from './RejectTaskModal';
import { assigneeKey, isMine } from '../lib/tasks';

type DeadlineSort = 'asc' | 'desc' | null;

const COLUMNS: { status: TaskStatus; label: string }[] = [
  { status: 'todo', label: 'К выполнению' },
  { status: 'in_progress', label: 'В работе' },
  { status: 'done', label: 'Сдано' },
];

const NEXT_STATUS: Partial<Record<TaskStatus, TaskStatus>> = {
  todo: 'in_progress',
  in_progress: 'done',
};

interface BoardViewProps {
  project: Project;
  user: User;
  // Set when arriving via a Telegram notification's deep link (?task=<id>) --
  // opens straight to that task's detail view instead of just the board.
  initialTask?: Task | null;
  // Переключатель досок на телефоне (чипы из MobileShell) -- рисуется под
  // заголовком, чтобы порядок был «что это -> какие ещё есть -> этапы».
  projectSwitcher?: ReactNode;
}

export function BoardView({ project, user, initialTask, projectSwitcher }: BoardViewProps) {
  // Задачи берутся из общего склада, а не грузятся заново: открытие доски
  // больше не поход в сеть, и «Загрузка…» на уже виденном не мигает.
  const { tasks: allTasks, error: loadError, ready, refresh, membersOf } = useData();
  const tasks = useMemo(
    () => allTasks.filter((t) => t.project_id === project.id && t.status !== 'archived'),
    [allTasks, project.id],
  );
  const [members, setMembers] = useState<User[]>([]);
  const [actionError, setActionError] = useState<string | null>(null);
  const [actionInfo, setActionInfo] = useState<string | null>(null);
  const [editingTask, setEditingTask] = useState<Task | null>(null);
  const [viewingTask, setViewingTask] = useState<Task | null>(initialTask ?? null);
  // Какая колонка видна на телефоне (на lg+ видны все три).
  const [mobileCol, setMobileCol] = useState<TaskStatus>('todo');
  const [rejectingTask, setRejectingTask] = useState<Task | null>(null);
  const [creating, setCreating] = useState(false);
  const [busyId, setBusyId] = useState<string | null>(null);
  const [priorityFilter, setPriorityFilter] = useState<Set<Priority>>(new Set());
  const [deadlineSort, setDeadlineSort] = useState<DeadlineSort>(null);

  const canManage = user.role === 'creator' || user.role === 'super_admin';

  function togglePriorityFilter(p: Priority) {
    setPriorityFilter((prev) => {
      const next = new Set(prev);
      if (next.has(p)) next.delete(p);
      else next.add(p);
      return next;
    });
  }

  // Empty filter set = show everything. Deadline-less tasks always sort last,
  // regardless of direction -- there's no "earlier/later" to place them by.
  const visibleTasks = useMemo(() => {
    const filtered = priorityFilter.size === 0 ? tasks : tasks.filter((t) => priorityFilter.has(t.priority));
    if (!deadlineSort) return filtered;
    return [...filtered].sort((a, b) => {
      if (!a.deadline && !b.deadline) return 0;
      if (!a.deadline) return 1;
      if (!b.deadline) return -1;
      const diff = Date.parse(a.deadline) - Date.parse(b.deadline);
      return deadlineSort === 'asc' ? diff : -diff;
    });
  }, [tasks, priorityFilter, deadlineSort]);

  // Люди доски нужны форме создания, а не ленте: склад отдаёт их из кэша, так
  // что повторное открытие доски запроса не делает.
  useEffect(() => {
    let alive = true;
    membersOf(project.id).then((list) => { if (alive) setMembers(list); });
    return () => { alive = false; };
  }, [project.id, membersOf]);

  async function runAction(taskId: string, action: () => Promise<unknown>) {
    setActionError(null);
    setActionInfo(null);
    setBusyId(taskId);
    try {
      await action();
      // Своё изменение подтягивается сразу, а не ждёт следующего опроса.
      await refresh();
    } catch (err) {
      setActionError(err instanceof ApiError ? err.message : 'The action could not be completed.');
    } finally {
      setBusyId(null);
    }
  }

  function handleAdvance(task: Task) {
    const next = NEXT_STATUS[task.status];
    if (!next) return;
    runAction(task.id, () => moveTask(task.id, next));
  }

  function describeOverdue(seconds: number) {
    if (seconds <= 0) return 'on time.';
    const hours = Math.floor(seconds / 3600);
    if (hours < 1) return 'less than an hour late.';
    if (hours < 24) return `${hours}h late.`;
    return `${Math.floor(hours / 24)}d late.`;
  }

  async function handleConfirm(task: Task) {
    setActionError(null);
    setActionInfo(null);
    setBusyId(task.id);
    try {
      const { overdue_by } = await confirmTask(task.id);
      setActionInfo(`Confirmed "${task.title}" -- ${overdue_by == null ? 'no deadline was set.' : describeOverdue(overdue_by)}`);
      await refresh();
    } catch (err) {
      setActionError(err instanceof ApiError ? err.message : 'The action could not be completed.');
    } finally {
      setBusyId(null);
    }
  }

  // Not routed through runAction: the modal shows its OWN inline error and stays
  // open on failure (so the typed reason/extra-days aren't lost), only closing
  // itself once onReject resolves without throwing.
  async function handleRejectSubmit(comment: string, extraDays: number) {
    if (!rejectingTask) return;
    setActionError(null);
    setActionInfo(null);
    await rejectTask(rejectingTask.id, comment, extraDays);
    await refresh();
  }

  function handleDelete(task: Task) {
    runAction(task.id, () => deleteTask(task.id).then(() => task));
  }

  // Both photo and generic-file blocks are backed by an attachment row --
  // this is what needs cleaning up when a block is dropped from the canvas.
  function attachmentIdsOf(blocks: ContentBlock[]): string[] {
    return blocks.flatMap((b) => (b.type === 'image' || b.type === 'file' ? [b.attachment_id] : []));
  }

  // Uploads run after the task itself is saved -- a failed photo/file must not
  // look like the task wasn't created/saved (it was), so report it separately.
  // Sequential (not Promise.all) so the resolved order matches the canvas order.
  async function resolveBlocks(taskId: string, blocks: ComposeBlock[]): Promise<{ persisted: ContentBlock[]; failed: number }> {
    const persisted: ContentBlock[] = [];
    let failed = 0;
    for (const block of blocks) {
      if (block.kind === 'text') {
        if (block.text.trim()) persisted.push({ type: 'text', text: block.text });
        continue;
      }
      if (block.attachmentId) {
        persisted.push(
          block.kind === 'image'
            ? { type: 'image', attachment_id: block.attachmentId }
            : { type: 'file', attachment_id: block.attachmentId, filename: block.filename, mime_type: block.mimeType, size_bytes: block.sizeBytes },
        );
        continue;
      }
      if (!block.file) continue;
      try {
        const uploaded = await uploadAttachment(taskId, block.file);
        persisted.push(
          block.kind === 'image'
            ? { type: 'image', attachment_id: uploaded.id }
            : { type: 'file', attachment_id: uploaded.id, filename: uploaded.filename, mime_type: uploaded.mime_type, size_bytes: uploaded.size_bytes },
        );
        if (block.kind === 'image') URL.revokeObjectURL(block.previewUrl);
      } catch {
        failed += 1;
      }
    }
    return { persisted, failed };
  }

  async function handleCreateSubmit(input: TaskInput, blocks: ComposeBlock[]) {
    const { id } = await createTask(project.id, input);
    setCreating(false);
    await refresh();
    const { persisted, failed } = await resolveBlocks(id, blocks);
    await updateTask(id, { content_blocks: JSON.stringify(persisted) });
    await refresh();
    if (failed) setActionError(`Task saved, but ${failed} photo/file(s) failed to upload.`);
  }

  async function handleEditSubmit(input: TaskInput, blocks: ComposeBlock[]) {
    if (!editingTask) return;
    const before = attachmentIdsOf(parseContentBlocks(editingTask));
    const { persisted, failed } = await resolveBlocks(editingTask.id, blocks);
    const after = new Set(attachmentIdsOf(persisted));
    // A photo/file the user removed while editing was only dropped locally
    // (see ContentEditor) -- only actually delete it now that the edit is
    // saved, so hitting Cancel never destroys an attachment.
    const removed = before.filter((id) => !after.has(id));
    await Promise.allSettled(removed.map((id) => deleteAttachment(id)));
    await updateTask(editingTask.id, { ...input, content_blocks: JSON.stringify(persisted) });
    setEditingTask(null);
    await refresh();
    if (failed) setActionError(`Task saved, but ${failed} photo/file(s) failed to upload.`);
  }

  const memberById = new Map(members.map((m) => [m.id, m]));
  const taskById = new Map(tasks.map((t) => [t.id, t]));

  // The predecessor's title, only when it isn't done/archived yet -- see
  // routes.ts POST /tasks/:id/move for the actual gate this mirrors.
  function blockedByTitle(task: Task): string | undefined {
    if (!task.depends_on_task_id) return undefined;
    const dep = taskById.get(task.depends_on_task_id);
    if (!dep || dep.status === 'done' || dep.status === 'archived') return undefined;
    return dep.title;
  }

  // Действия в шторке задачи. Правила те же, что на карточке (TaskCard):
  // двигает только исполнитель, принимает/возвращает руководитель, правит
  // todo -- любой, in_progress -- руководитель. Кнопки, которые прямо сейчас
  // недоступны, не показываем вовсе -- шторка не место для серых кнопок.
  function sheetActions(task: Task): ReactNode {
    const blocked = blockedByTitle(task);
    const canMove = isMine(task, user.id) && !blocked && (task.status === 'todo' || task.status === 'in_progress');
    const editable = task.status === 'todo' || (task.status === 'in_progress' && canManage);
    const review = task.status === 'done' && canManage && !task.confirmed_at;
    const busy = busyId === task.id;
    if (!canMove && !editable && !review && !canManage) return null;
    const after = (fn: () => void) => () => { setViewingTask(null); fn(); };
    return (
      <>
        {canMove ? (
          <button type="button" className="btn btn-primary" disabled={busy} onClick={after(() => handleAdvance(task))}>
            <ArrowRight aria-hidden="true" style={{ width: 16, height: 16 }} />
            {task.status === 'todo' ? 'Взять в работу' : 'Сдать'}
          </button>
        ) : null}
        {review ? (
          <div className="btn-row" style={{ marginTop: 0 }}>
            <button type="button" className="btn btn-primary" disabled={busy} onClick={after(() => handleConfirm(task))}>
              <Check aria-hidden="true" style={{ width: 16, height: 16 }} />
              Принять
            </button>
            <button type="button" className="btn" disabled={busy} onClick={after(() => setRejectingTask(task))}>
              <X aria-hidden="true" style={{ width: 16, height: 16 }} />
              Вернуть
            </button>
          </div>
        ) : null}
        {editable || canManage ? (
          <div className="btn-row" style={{ marginTop: 0 }}>
            {editable ? (
              <button type="button" className="btn" disabled={busy} onClick={after(() => setEditingTask(task))}>
                <Pencil aria-hidden="true" style={{ width: 16, height: 16 }} />
                Изменить
              </button>
            ) : null}
            {canManage ? (
              <button type="button" className="btn btn-danger" disabled={busy} onClick={after(() => handleDelete(task))}>
                <Trash2 aria-hidden="true" style={{ width: 16, height: 16 }} />
                В архив
              </button>
            ) : null}
          </div>
        ) : null}
      </>
    );
  }

  return (
    <div className="flex h-full flex-col lg:p-6">
      <div className="h1-row">
        {/* Когда рядом есть переключатель досок (телефон), имя доски пишет
            он -- заголовок называет экран, иначе название стоит дважды. */}
        <h1 className="h1">{projectSwitcher ? 'Доска' : project.name}</h1>
        <button type="button" onClick={() => setCreating(true)} className="btn btn-sm btn-primary">
          <Plus aria-hidden="true" style={{ width: 16, height: 16 }} />
          Новая
        </button>
      </div>

      {projectSwitcher}

      {/* Фильтры -- одна строка чипов: срочность (можно несколько) и порядок
          по сроку (один из двух). Только на широком экране: на телефоне в
          колонке единицы задач, и ряд фильтров -- шум перед списком. */}
      <div className="chips only-wide" aria-label="Фильтры">
        {PRIORITIES.map((p) => (
          <button
            key={p.value}
            type="button"
            onClick={() => togglePriorityFilter(p.value)}
            aria-pressed={priorityFilter.has(p.value)}
            className={priorityFilter.has(p.value) ? 'chip on' : 'chip'}
          >
            <span className={`dot ${p.dot}`} aria-hidden="true" />
            {p.label}
          </button>
        ))}
        <span aria-hidden="true" style={{ width: 1, background: 'var(--sep)', margin: '8px 4px' }} />
        <button
          type="button"
          onClick={() => setDeadlineSort((s) => (s === 'asc' ? null : 'asc'))}
          aria-pressed={deadlineSort === 'asc'}
          className={deadlineSort === 'asc' ? 'chip on' : 'chip'}
        >
          Срок: раньше
        </button>
        <button
          type="button"
          onClick={() => setDeadlineSort((s) => (s === 'desc' ? null : 'desc'))}
          aria-pressed={deadlineSort === 'desc'}
          className={deadlineSort === 'desc' ? 'chip on' : 'chip'}
        >
          Срок: позже
        </button>
      </div>

      {/* На телефоне колонки не влезают рядом -- показываем одну, выбранную
          сегментом; на широком экране (lg) сегмент прячется и видны все три. */}
      <div className="chips only-narrow" role="tablist" aria-label="Этап">
        {COLUMNS.map((col) => (
          <button
            key={col.status}
            type="button"
            role="tab"
            aria-selected={mobileCol === col.status}
            onClick={() => setMobileCol(col.status)}
            className={mobileCol === col.status ? 'chip on' : 'chip'}
          >
            {col.label}
            <span className="cnt">{visibleTasks.filter((t) => t.status === col.status).length}</span>
          </button>
        ))}
      </div>

      {loadError ? <div role="alert" className="alert alert-err">{loadError}</div> : null}
      {actionError ? <div role="alert" className="alert alert-err">{actionError}</div> : null}
      {actionInfo ? <div role="status" className="alert alert-ok">{actionInfo}</div> : null}

      <div className="grid flex-1 grid-cols-1 gap-4 lg:min-h-0 lg:grid-cols-3 lg:overflow-y-auto">
        {COLUMNS.map((col) => (
          <div
            key={col.status}
            className={`${col.status === mobileCol ? 'flex' : 'hidden lg:flex'} min-h-0 flex-col lg:rounded-[14px] lg:bg-[var(--fill2)] lg:p-3`}
          >
            <h2 className="sec-title hidden lg:block" style={{ marginTop: 0 }}>
              {col.label}
              <span className="cnt" style={{ marginLeft: 8, fontWeight: 500, color: 'var(--label3)' }}>
                {visibleTasks.filter((t) => t.status === col.status).length}
              </span>
            </h2>
            <div className="stack lg:min-h-0 lg:flex-1 lg:overflow-y-auto">
              {visibleTasks.filter((t) => t.status === col.status).length === 0 ? (
                <p className="muted" style={{ padding: '12px 4px' }}>{ready ? 'Здесь пусто.' : 'Загрузка…'}</p>
              ) : null}
              {visibleTasks
                .filter((t) => t.status === col.status)
                .map((task) => (
                  <TaskCard
                    key={task.id}
                    task={task}
                    responsible={memberById.get(assigneeKey(task))}
                    canManage={canManage}
                    currentUserId={user.id}
                    blockedByTitle={blockedByTitle(task)}
                    busy={busyId === task.id}
                    onAdvance={() => handleAdvance(task)}
                    onConfirm={() => handleConfirm(task)}
                    onReject={() => setRejectingTask(task)}
                    onView={() => setViewingTask(task)}
                  />
                ))}
            </div>
          </div>
        ))}
      </div>

      {viewingTask ? (
        <TaskDetailModal
          task={viewingTask}
          responsible={memberById.get(assigneeKey(viewingTask))}
          onClose={() => setViewingTask(null)}
          actions={sheetActions(viewingTask)}
        />
      ) : null}

      {creating ? (
        <TaskFormModal members={members} otherTasks={tasks} onClose={() => setCreating(false)} onSubmit={handleCreateSubmit} />
      ) : null}
      {editingTask ? (
        <TaskFormModal
          task={editingTask}
          members={members}
          otherTasks={tasks}
          onClose={() => setEditingTask(null)}
          onSubmit={handleEditSubmit}
        />
      ) : null}
      {rejectingTask ? (
        <RejectTaskModal task={rejectingTask} onClose={() => setRejectingTask(null)} onReject={handleRejectSubmit} />
      ) : null}
    </div>
  );
}
