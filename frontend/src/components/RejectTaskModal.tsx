import { useState, type FormEvent } from 'react';
import { Loader2, X } from 'lucide-react';
import type { Task } from '../types';
import { ApiError } from '../lib/api';

interface RejectTaskModalProps {
  task: Task;
  onClose: () => void;
  onReject: (comment: string, extraDays: number) => Promise<void>;
}

// Rejecting a done task back to in_progress needs a reason, plus a fresh
// deadline -- "how many more days" recalculates it from now (see routes.ts
// POST /tasks/:id/reject).
export function RejectTaskModal({ task, onClose, onReject }: RejectTaskModalProps) {
  const [comment, setComment] = useState('');
  const [extraDays, setExtraDays] = useState(1);
  const [error, setError] = useState<string | null>(null);
  const [submitting, setSubmitting] = useState(false);

  async function handleSubmit(e: FormEvent) {
    e.preventDefault();
    if (!comment.trim()) {
      setError('A reason is required.');
      return;
    }
    if (!Number.isInteger(extraDays) || extraDays < 1) {
      setError('Extra days must be a positive whole number.');
      return;
    }
    setError(null);
    setSubmitting(true);
    try {
      await onReject(comment.trim(), extraDays);
      onClose();
    } catch (err) {
      setError(err instanceof ApiError ? err.message : 'Could not reject the task.');
    } finally {
      setSubmitting(false);
    }
  }

  return (
    <div className="fixed inset-0 z-20 flex items-center justify-center bg-slate-900/40 p-4" onClick={onClose}>
      <div
        role="dialog"
        aria-modal="true"
        aria-labelledby="reject-task-title"
        className="w-full max-w-sm rounded-lg bg-white p-6 shadow-lg"
        onClick={(e) => e.stopPropagation()}
      >
        <div className="mb-4 flex items-center justify-between">
          <h2 id="reject-task-title" className="text-lg font-semibold text-slate-900">
            Reject "{task.title}"
          </h2>
          <button type="button" onClick={onClose} aria-label="Close" className="rounded p-1 text-slate-500 hover:bg-slate-100">
            <X className="h-4 w-4" aria-hidden="true" />
          </button>
        </div>

        {error ? (
          <div role="alert" className="mb-3 rounded-md border border-red-300 bg-red-50 p-2 text-sm text-red-800">
            {error}
          </div>
        ) : null}

        <form onSubmit={handleSubmit} noValidate>
          <label htmlFor="reject-comment" className="mb-1 block text-sm font-medium text-slate-700">
            Reason
          </label>
          <textarea
            id="reject-comment"
            value={comment}
            onChange={(e) => setComment(e.target.value)}
            rows={3}
            placeholder="What still needs fixing?"
            className="mb-4 w-full resize-none rounded-md border border-slate-300 px-3 py-2 text-sm focus-visible:outline-blue-600"
          />

          <label htmlFor="reject-extra-days" className="mb-1 block text-sm font-medium text-slate-700">
            Extra days until the new deadline
          </label>
          <input
            id="reject-extra-days"
            type="number"
            min={1}
            step={1}
            value={extraDays}
            onChange={(e) => setExtraDays(Number(e.target.value))}
            className="mb-4 w-full rounded-md border border-slate-300 px-3 py-2 text-sm focus-visible:outline-blue-600"
          />

          <div className="flex justify-end gap-2">
            <button type="button" onClick={onClose} className="rounded-md border border-slate-300 px-3 py-1.5 text-sm text-slate-700 hover:bg-slate-50">
              Cancel
            </button>
            <button
              type="submit"
              disabled={submitting}
              className="flex items-center gap-2 rounded-md bg-blue-600 px-3 py-1.5 text-sm font-medium text-white hover:bg-blue-700 disabled:bg-blue-300"
            >
              {submitting ? <Loader2 className="h-4 w-4 animate-spin" aria-hidden="true" /> : null}
              Reject
            </button>
          </div>
        </form>
      </div>
    </div>
  );
}
