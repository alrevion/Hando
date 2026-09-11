import { useState } from 'react';
import { X } from 'lucide-react';
import { Sheet } from './Sheet';

/** Одна строка от человека: причина отказа, комментарий «не успею», подтверждение именем. */
export function AskText({
  title, placeholder, submitLabel, danger, onSubmit, onClose,
}: { title: string; placeholder: string; submitLabel: string; danger?: boolean; onSubmit: (text: string) => Promise<void>; onClose: () => void }) {
  const [text, setText] = useState('');
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  return (
    <Sheet labelledBy="ask-title" onClose={onClose}>
      <div className="sheet-head">
        <h2 id="ask-title" className="sheet-title">{title}</h2>
        <button type="button" onClick={onClose} aria-label="Закрыть" className="btn-icon"><X aria-hidden="true" /></button>
      </div>
      {error ? <div role="alert" className="alert alert-err">{error}</div> : null}
      <form onSubmit={async (e) => {
        e.preventDefault();
        if (!text.trim()) return;
        setBusy(true);
        try { await onSubmit(text.trim()); onClose(); } catch (err) { setError(err instanceof Error ? err.message : 'Не получилось.'); } finally { setBusy(false); }
      }}>
        <div className="field">
          <textarea className="inp" autoFocus rows={3} value={text} placeholder={placeholder} onChange={(e) => setText(e.target.value)} />
        </div>
        <div className="btn-row">
          <button type="button" className="btn" onClick={onClose}>Отмена</button>
          <button type="submit" className={danger ? 'btn btn-danger' : 'btn btn-primary'} disabled={busy || !text.trim()}>{submitLabel}</button>
        </div>
      </form>
    </Sheet>
  );
}
