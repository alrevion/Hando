import { useCallback, useEffect, useMemo, useState } from 'react';
import type { ContentBlock, Priority, Project, Task, TaskStatus, User } from '../types';
import { parseContentBlocks } from '../types';
import {
  ApiError,
  confirmTask,
  createTask,
  deleteAttachment,
  deleteTask,
  getProjectMembers,
  getTasks,
  moveTask,
  rejectTask,
  updateTask,
  uploadAttachment,
  type TaskInput,
} from '../lib/api';
import { usePolling } from '../hooks/usePolling';
import { PRIORITIES } from '../lib/priority';
import type { ComposeBlock } from './ContentEditor';
import { TaskCard } from './TaskCard';
import { TaskDetailModal } from './TaskDetailModal';
import { TaskFormModal } from './TaskFormModal';
import { RejectTaskModal } from './RejectTaskModal';

type DeadlineSort = 'asc' | 'desc' | null;

const COLUMNS: { status: TaskStatus; label: string }[] = [
  { status: 'todo', label: 'Todo' },
  { status: 'in_progress', label: 'In Progress' },
  { status: 'done', label: 'Done' },
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
}

export function BoardView({ project, user, initialTask }: BoardViewProps) {
  const [tasks, setTasks] = useState<Task[]>([]);
  const [members, setMembers] = useState<User[]>([]);
  const [loadError, setLoadError] = useState<string | null>(null);
  const [actionError, setActionError] = useState<string | null>(null);
  const [actionInfo, setActionInfo] = useState<string | null>(null);
  const [editingTask, setEditingTask] = useState<Task | null>(null);
  const [viewingTask, setViewingTask] = useState<Task | null>(initialTask ?? null);
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

  const fetchTasks = useCallback(() => {
    getTasks(project.id)
      .then((data) => {
        setTasks(data.filter((t) => t.status !== 'archived'));
        setLoadError(null);
      })
      .catch((err) => setLoadError(err instanceof ApiError ? err.message : 'Could not load tasks.'));
  }, [project.id]);

  usePolling(fetchTasks, 5000);

  useEffect(() => {
    getProjectMembers(project.id)
      .then(setMembers)
      .catch(() => setMembers([]));
  }, [project.id]);

  async function runAction(taskId: string, action: () => Promise<unknown>) {
    setActionError(null);
    setActionInfo(null);
    setBusyId(taskId);
    try {
      await action();
      fetchTasks();
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
      fetchTasks();
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
    fetchTasks();
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
    fetchTasks();
    const { persisted, failed } = await resolveBlocks(id, blocks);
    await updateTask(id, { content_blocks: JSON.stringify(persisted) });
    fetchTasks();
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
    fetchTasks();
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

  return (
    <div className="flex h-full flex-col p-6">
      <div className="mb-3 flex items-center justify-between gap-3">
        <h1 className="text-xl font-semibold text-slate-900">{project.name}</h1>
        <button
          type="button"
          onClick={() => setCreating(true)}
          className="rounded-md bg-blue-600 px-3 py-1.5 text-sm font-medium text-white hover:bg-blue-700"
        >
          New task
        </button>
      </div>

      <div className="mb-4 flex flex-wrap items-center gap-3">
        <div className="flex items-center gap-1.5">
          <span className="text-xs font-medium text-slate-500">Срочность:</span>
          {PRIORITIES.map((p) => (
            <button
              key={p.value}
              type="button"
              onClick={() => togglePriorityFilter(p.value)}
              aria-pressed={priorityFilter.has(p.value)}
              className={`flex items-center gap-1.5 rounded-full border px-2 py-1 text-xs font-medium ${
                priorityFilter.has(p.value) ? 'border-blue-600 bg-blue-50 text-blue-700' : 'border-slate-300 text-slate-600 hover:bg-slate-50'
              }`}
            >
              <span className={`h-1.5 w-1.5 rounded-full ${p.dot}`} aria-hidden="true" />
              {p.label}
            </button>
          ))}
        </div>

        <div className="h-4 w-px bg-slate-300" aria-hidden="true" />

        <div className="flex items-center gap-1.5">
          <span className="text-xs font-medium text-slate-500">Дедлайн:</span>
          <button
            type="button"
            onClick={() => setDeadlineSort((s) => (s === 'asc' ? null : 'asc'))}
            aria-pressed={deadlineSort === 'asc'}
            className={`rounded-full border px-2 py-1 text-xs font-medium ${
              deadlineSort === 'asc' ? 'border-blue-600 bg-blue-50 text-blue-700' : 'border-slate-300 text-slate-600 hover:bg-slate-50'
            }`}
          >
            Раньше
          </button>
          <button
            type="button"
            onClick={() => setDeadlineSort((s) => (s === 'desc' ? null : 'desc'))}
            aria-pressed={deadlineSort === 'desc'}
            className={`rounded-full border px-2 py-1 text-xs font-medium ${
              deadlineSort === 'desc' ? 'border-blue-600 bg-blue-50 text-blue-700' : 'border-slate-300 text-slate-600 hover:bg-slate-50'
            }`}
          >
            Позже
          </button>
        </div>
      </div>

      {loadError ? (
        <div role="alert" className="mb-3 rounded-md border border-red-300 bg-red-50 p-2 text-sm text-red-800">
          {loadError}
        </div>
      ) : null}
      {actionError ? (
        <div role="alert" className="mb-3 rounded-md border border-red-300 bg-red-50 p-2 text-sm text-red-800">
          {actionError}
        </div>
      ) : null}
      {actionInfo ? (
        <div role="status" className="mb-3 rounded-md border border-emerald-300 bg-emerald-50 p-2 text-sm text-emerald-800">
          {actionInfo}
        </div>
      ) : null}

      <div className="grid flex-1 grid-cols-1 gap-4 overflow-y-auto sm:grid-cols-3">
        {COLUMNS.map((col) => (
          <div key={col.status} className="flex min-h-0 flex-col rounded-lg bg-slate-50 p-3">
            <h2 className="mb-3 text-sm font-semibold uppercase tracking-wide text-slate-500">
              {col.label}
              <span className="ml-2 rounded-full bg-slate-200 px-2 py-0.5 text-xs font-normal text-slate-600">
                {visibleTasks.filter((t) => t.status === col.status).length}
              </span>
            </h2>
            <div className="flex flex-1 flex-col gap-2 overflow-y-auto">
              {visibleTasks
                .filter((t) => t.status === col.status)
                .map((task) => (
                  <TaskCard
                    key={task.id}
                    task={task}
                    responsible={memberById.get(task.responsible_user_id)}
                    canManage={canManage}
                    currentUserId={user.id}
                    blockedByTitle={blockedByTitle(task)}
                    busy={busyId === task.id}
                    onEdit={() => setEditingTask(task)}
                    onAdvance={() => handleAdvance(task)}
                    onConfirm={() => handleConfirm(task)}
                    onReject={() => setRejectingTask(task)}
                    onDelete={() => handleDelete(task)}
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
          responsible={memberById.get(viewingTask.responsible_user_id)}
          onClose={() => setViewingTask(null)}
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
