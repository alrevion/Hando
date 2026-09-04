import { useEffect, useState, type FormEvent } from 'react';
import { Loader2, Undo2 } from 'lucide-react';
import type { Project, TaskEvent } from '../types';
import { ApiError, getProjectArchive, restoreTask, type ProjectArchive } from '../lib/api';

function formatDateTime(iso: string) {
  const d = new Date(iso);
  if (Number.isNaN(d.getTime())) return iso;
  return d.toLocaleString();
}

function describeOverdue(seconds: number) {
  const hours = Math.floor(seconds / 3600);
  if (hours < 1) return 'less than an hour late';
  if (hours < 24) return `${hours}h late`;
  return `${Math.floor(hours / 24)}d late`;
}

interface ArchiveTabProps {
  project: Project;
}

export function ArchiveTab({ project }: ArchiveTabProps) {
  const [data, setData] = useState<ProjectArchive | null>(null);
  const [loadError, setLoadError] = useState<string | null>(null);
  const [loading, setLoading] = useState(true);
  const [restoringId, setRestoringId] = useState<string | null>(null);

  function load() {
    setLoading(true);
    getProjectArchive(project.id)
      .then((res) => {
        setData(res);
        setLoadError(null);
      })
      .catch((err) => setLoadError(err instanceof ApiError ? err.message : 'Could not load the archive.'))
      .finally(() => setLoading(false));
  }

  useEffect(load, [project.id]);

  const entries = data?.archivedTasks ?? [];
  const projectEvents = data?.projectEvents ?? [];

  return (
    <div className="flex h-full flex-col overflow-y-auto p-6">
      <h1 className="mb-4 text-xl font-semibold text-slate-900">{project.name} — Archive</h1>

      {loadError ? (
        <div role="alert" className="mb-3 rounded-md border border-red-300 bg-red-50 p-2 text-sm text-red-800">
          {loadError}
        </div>
      ) : null}

      <section className="mb-6">
        <h2 className="mb-2 text-sm font-semibold uppercase tracking-wide text-slate-500">
          Project activity
        </h2>
        {loading ? (
          <p className="text-sm text-slate-500">Loading…</p>
        ) : projectEvents.length === 0 ? (
          <p className="text-sm text-slate-500">No project or membership changes yet.</p>
        ) : (
          <ul className="space-y-1 rounded-lg border border-slate-200 bg-white p-3">
            {projectEvents.map((event: TaskEvent & { actor_name: string | null }) => (
              <li key={event.id} className="text-xs text-slate-500">
                <span className="font-medium text-slate-700">{event.actor_name ?? 'System'}</span>{' '}
                {event.action} · {formatDateTime(event.created_at)}
              </li>
            ))}
          </ul>
        )}
      </section>

      <h2 className="mb-2 text-sm font-semibold uppercase tracking-wide text-slate-500">
        Archived tasks
      </h2>
      {loading ? (
        <p className="text-sm text-slate-500">Loading…</p>
      ) : entries.length === 0 ? (
        <p className="text-sm text-slate-500">Nothing archived yet.</p>
      ) : (
        <ul className="space-y-3">
          {entries.map(({ task, events }) => (
            <li key={task.id} className="rounded-lg border border-slate-200 bg-white p-4">
              <div className="mb-2 flex items-start justify-between gap-2">
                <div>
                  <h2 className="text-sm font-medium text-slate-900">{task.title}</h2>
                  {task.description ? (
                    <p className="text-xs text-slate-600">{task.description}</p>
                  ) : null}
                </div>
                <button
                  type="button"
                  onClick={() => setRestoringId(task.id)}
                  className="flex shrink-0 items-center gap-1 rounded-md border border-slate-300 px-2 py-1 text-xs text-slate-700 hover:bg-slate-50"
                >
                  <Undo2 className="h-3 w-3" aria-hidden="true" />
                  Restore
                </button>
              </div>

              <ul className="space-y-1 border-t border-slate-100 pt-2">
                {events.map((event) => (
                  <li key={event.id} className="text-xs text-slate-500">
                    <span className="font-medium text-slate-700">{event.actor_name ?? 'System'}</span>{' '}
                    {event.action} · {formatDateTime(event.created_at)}
                    {event.overdue_by ? ` · ${describeOverdue(event.overdue_by)}` : ''}
                    {event.comment ? ` · "${event.comment}"` : ''}
                  </li>
                ))}
              </ul>

              {restoringId === task.id ? (
                <RestoreForm
                  taskId={task.id}
                  onDone={() => {
                    setRestoringId(null);
                    load();
                  }}
                  onCancel={() => setRestoringId(null)}
                />
              ) : null}
            </li>
          ))}
        </ul>
      )}
    </div>
  );
}

function RestoreForm({
  taskId,
  onDone,
  onCancel,
}: {
  taskId: string;
  onDone: () => void;
  onCancel: () => void;
}) {
  const [comment, setComment] = useState('');
  const [error, setError] = useState<string | null>(null);
  const [submitting, setSubmitting] = useState(false);

  async function handleSubmit(e: FormEvent) {
    e.preventDefault();
    if (!comment.trim()) {
      setError('A comment is required to restore this task.');
      return;
    }
    setError(null);
    setSubmitting(true);
    try {
      await restoreTask(taskId, comment.trim());
      onDone();
    } catch (err) {
      setError(err instanceof ApiError ? err.message : 'Could not restore the task.');
    } finally {
      setSubmitting(false);
    }
  }

  return (
    <form onSubmit={handleSubmit} className="mt-3 border-t border-slate-100 pt-3" noValidate>
      <label htmlFor={`restore-comment-${taskId}`} className="mb-1 block text-xs font-medium text-slate-700">
        Reason for restoring (required)
      </label>
      <textarea
        id={`restore-comment-${taskId}`}
        value={comment}
        onChange={(e) => setComment(e.target.value)}
        aria-invalid={!!error}
        aria-describedby={error ? `restore-comment-error-${taskId}` : undefined}
        rows={2}
        className="mb-1 w-full rounded-md border border-slate-300 px-2 py-1 text-sm focus-visible:outline-blue-600"
      />
      {error ? (
        <p id={`restore-comment-error-${taskId}`} role="alert" className="mb-2 text-xs text-red-700">
          {error}
        </p>
      ) : (
        <div className="mb-2" />
      )}
      <div className="flex gap-2">
        <button
          type="submit"
          disabled={submitting}
          className="flex items-center gap-1 rounded-md bg-blue-600 px-2 py-1 text-xs font-medium text-white hover:bg-blue-700 disabled:bg-blue-300"
        >
          {submitting ? <Loader2 className="h-3 w-3 animate-spin" aria-hidden="true" /> : null}
          Confirm restore
        </button>
        <button
          type="button"
          onClick={onCancel}
          className="rounded-md border border-slate-300 px-2 py-1 text-xs text-slate-700 hover:bg-slate-50"
        >
          Cancel
        </button>
      </div>
    </form>
  );
}
