import { useState, type FormEvent } from 'react';
import { Loader2, X } from 'lucide-react';
import type { Priority, Task, User } from '../types';
import { parseContentBlocks } from '../types';
import { ApiError, type TaskInput } from '../lib/api';
import { PRIORITIES } from '../lib/priority';
import { ContentEditor, type ComposeBlock } from './ContentEditor';

interface TaskFormModalProps {
  task?: Task; // undefined => creating a new task
  members: User[];
  // Other tasks in this project, offered as an optional predecessor ("can't
  // start until this one is done" -- see routes.ts POST /tasks/:id/move).
  otherTasks: Task[];
  onClose: () => void;
  onSubmit: (input: TaskInput, blocks: ComposeBlock[]) => Promise<void>;
}

// A "+" sits at every gap in ContentEditor (including before the first block
// and after the last), so there's no need to force a leading/trailing text
// block here -- the empty canvas, or the tail end of a loaded one, is already
// insertable from either type.
function toComposeBlocks(task: Task | undefined): ComposeBlock[] {
  if (!task) return [];
  return parseContentBlocks(task).map((b): ComposeBlock => {
    if (b.type === 'text') return { id: crypto.randomUUID(), kind: 'text', text: b.text };
    if (b.type === 'image')
      return {
        id: crypto.randomUUID(),
        kind: 'image',
        attachmentId: b.attachment_id,
        file: null,
        previewUrl: `/api/attachments/${b.attachment_id}/download`,
      };
    return {
      id: crypto.randomUUID(),
      kind: 'file',
      attachmentId: b.attachment_id,
      file: null,
      filename: b.filename,
      mimeType: b.mime_type,
      sizeBytes: b.size_bytes,
    };
  });
}

export function TaskFormModal({ task, members, otherTasks, onClose, onSubmit }: TaskFormModalProps) {
  const [title, setTitle] = useState(task?.title ?? '');
  const [responsibleId, setResponsibleId] = useState(task?.responsible_user_id ?? '');
  const [deadline, setDeadline] = useState(task?.deadline ?? '');
  const [priority, setPriority] = useState<Priority>(task?.priority ?? 'medium');
  const [dependsOn, setDependsOn] = useState(task?.depends_on_task_id ?? '');
  const [blocks, setBlocks] = useState<ComposeBlock[]>(() => toComposeBlocks(task));
  const [errors, setErrors] = useState<{ title?: string; responsible?: string }>({});
  const [formError, setFormError] = useState<string | null>(null);
  const [submitting, setSubmitting] = useState(false);

  const dependencyOptions = otherTasks.filter((t) => t.id !== task?.id);

  async function handleSubmit(e: FormEvent) {
    e.preventDefault();
    const nextErrors: typeof errors = {};
    if (!title.trim()) nextErrors.title = 'Title is required.';
    if (!responsibleId) nextErrors.responsible = 'Choose a responsible person.';
    setErrors(nextErrors);
    if (Object.keys(nextErrors).length > 0) return;

    const description = blocks
      .filter((b): b is Extract<ComposeBlock, { kind: 'text' }> => b.kind === 'text')
      .map((b) => b.text.trim())
      .filter(Boolean)
      .join('\n\n');

    setFormError(null);
    setSubmitting(true);
    try {
      await onSubmit(
        {
          title: title.trim(),
          description,
          responsible_user_id: responsibleId,
          deadline: deadline || null,
          priority,
          depends_on_task_id: dependsOn || null,
        },
        blocks,
      );
    } catch (err) {
      setFormError(err instanceof ApiError ? err.message : 'Could not save the task.');
    } finally {
      setSubmitting(false);
    }
  }

  return (
    <div className="fixed inset-0 z-20 flex items-center justify-center bg-slate-900/40 p-4">
      <div
        role="dialog"
        aria-modal="true"
        aria-labelledby="task-form-title"
        className="flex max-h-[85vh] w-full max-w-md flex-col rounded-lg bg-white p-6 shadow-lg"
      >
        <div className="mb-4 flex items-center justify-between">
          <h2 id="task-form-title" className="text-lg font-semibold text-slate-900">
            {task ? 'Edit task' : 'New task'}
          </h2>
          <button
            type="button"
            onClick={onClose}
            aria-label="Close"
            className="rounded p-1 text-slate-500 hover:bg-slate-100"
          >
            <X className="h-4 w-4" aria-hidden="true" />
          </button>
        </div>

        {formError ? (
          <div role="alert" className="mb-3 rounded-md border border-red-300 bg-red-50 p-2 text-sm text-red-800">
            {formError}
          </div>
        ) : null}

        {task && task.status === 'in_progress' ? (
          <div className="mb-3 rounded-md border border-amber-300 bg-amber-50 p-2 text-sm text-amber-800">
            Saving will move this task back to Todo.
          </div>
        ) : null}

        <form onSubmit={handleSubmit} noValidate className="flex min-h-0 flex-1 flex-col overflow-y-auto">
          <label htmlFor="task-title" className="mb-1 block text-sm font-medium text-slate-700">
            Title
          </label>
          <input
            id="task-title"
            value={title}
            onChange={(e) => setTitle(e.target.value)}
            aria-invalid={!!errors.title}
            aria-describedby={errors.title ? 'task-title-error' : undefined}
            className="mb-1 w-full rounded-md border border-slate-300 px-3 py-2 text-sm focus-visible:outline-blue-600"
          />
          {errors.title ? (
            <p id="task-title-error" role="alert" className="mb-2 text-xs text-red-700">
              {errors.title}
            </p>
          ) : (
            <div className="mb-2" />
          )}

          <label htmlFor="task-responsible" className="mb-1 block text-sm font-medium text-slate-700">
            Responsible
          </label>
          <select
            id="task-responsible"
            value={responsibleId}
            onChange={(e) => setResponsibleId(e.target.value)}
            aria-invalid={!!errors.responsible}
            aria-describedby={errors.responsible ? 'task-responsible-error' : undefined}
            className="mb-1 w-full rounded-md border border-slate-300 bg-white px-3 py-2 text-sm focus-visible:outline-blue-600"
          >
            <option value="">Select a person…</option>
            {members.map((m) => (
              <option key={m.id} value={m.id}>
                {m.name}
              </option>
            ))}
          </select>
          {errors.responsible ? (
            <p id="task-responsible-error" role="alert" className="mb-2 text-xs text-red-700">
              {errors.responsible}
            </p>
          ) : (
            <div className="mb-2" />
          )}

          <span className="mb-1 block text-sm font-medium text-slate-700">Priority</span>
          <div className="mb-4 flex gap-2">
            {PRIORITIES.map((p) => (
              <button
                key={p.value}
                type="button"
                onClick={() => setPriority(p.value)}
                aria-pressed={priority === p.value}
                className={`flex items-center gap-1.5 rounded-md border px-3 py-1.5 text-sm ${
                  priority === p.value ? 'border-blue-600 bg-blue-50 text-blue-700' : 'border-slate-300 text-slate-600 hover:bg-slate-50'
                }`}
              >
                <span className={`h-2 w-2 rounded-full ${p.dot}`} aria-hidden="true" />
                {p.label}
              </button>
            ))}
          </div>

          <label htmlFor="task-deadline" className="mb-1 block text-sm font-medium text-slate-700">
            Deadline (optional)
          </label>
          <input
            id="task-deadline"
            type="date"
            value={deadline ?? ''}
            onChange={(e) => setDeadline(e.target.value)}
            className="mb-4 w-full rounded-md border border-slate-300 px-3 py-2 text-sm focus-visible:outline-blue-600"
          />

          <label htmlFor="task-depends-on" className="mb-1 block text-sm font-medium text-slate-700">
            Depends on (optional)
          </label>
          <select
            id="task-depends-on"
            value={dependsOn}
            onChange={(e) => setDependsOn(e.target.value)}
            className="mb-4 w-full rounded-md border border-slate-300 bg-white px-3 py-2 text-sm focus-visible:outline-blue-600"
          >
            <option value="">No dependency</option>
            {dependencyOptions.map((t) => (
              <option key={t.id} value={t.id}>
                {t.title}
              </option>
            ))}
          </select>

          <span className="mb-1 block text-sm font-medium text-slate-700">Content</span>
          <ContentEditor blocks={blocks} onChange={setBlocks} />

          <div className="mt-4 flex justify-end gap-2">
            <button
              type="button"
              onClick={onClose}
              className="rounded-md border border-slate-300 px-3 py-1.5 text-sm text-slate-700 hover:bg-slate-50"
            >
              Cancel
            </button>
            <button
              type="submit"
              disabled={submitting}
              className="flex items-center gap-2 rounded-md bg-blue-600 px-3 py-1.5 text-sm font-medium text-white hover:bg-blue-700 disabled:bg-blue-300"
            >
              {submitting ? <Loader2 className="h-4 w-4 animate-spin" aria-hidden="true" /> : null}
              Save
            </button>
          </div>
        </form>
      </div>
    </div>
  );
}
