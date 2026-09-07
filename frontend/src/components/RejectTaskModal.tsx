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
    <div className="sheet-backdrop" onClick={onClose}>
      <div role="dialog" aria-modal="true" aria-labelledby="reject-task-title" className="sheet" onClick={(e) => e.stopPropagation()}>
        <div className="sheet-grab" aria-hidden="true" />
        <div className="sheet-head">
          <h2 id="reject-task-title" className="sheet-title">Вернуть «{task.title}»</h2>
          <button type="button" onClick={onClose} aria-label="Закрыть" className="btn-icon">
            <X aria-hidden="true" />
          </button>
        </div>

        {error ? <div role="alert" className="alert alert-err">{error}</div> : null}

        <form onSubmit={handleSubmit} noValidate>
          <div className="field">
            <label htmlFor="reject-comment" className="lbl">Что не так</label>
            <textarea
              id="reject-comment"
              value={comment}
              onChange={(e) => setComment(e.target.value)}
              rows={3}
              placeholder="Что нужно доделать?"
              className="inp"
            />
          </div>

          <div className="field">
            <label htmlFor="reject-extra-days" className="lbl">Дней на доработку</label>
            <input
              id="reject-extra-days"
              type="number"
              inputMode="numeric"
              min={1}
              step={1}
              value={extraDays}
              onChange={(e) => setExtraDays(Number(e.target.value))}
              className="inp"
            />
          </div>

          <div className="btn-row">
            <button type="button" onClick={onClose} className="btn">Отмена</button>
            <button type="submit" disabled={submitting} className="btn btn-danger">
              {submitting ? <Loader2 className="h-4 w-4 animate-spin" aria-hidden="true" /> : null}
              Вернуть
            </button>
          </div>
        </form>
      </div>
    </div>
  );
}
