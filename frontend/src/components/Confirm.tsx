import { useState } from 'react';
import { X } from 'lucide-react';
import { Sheet } from './Sheet';

/**
 * Подтверждение рискованного действия. Одно окно на весь продукт: удалить
 * организацию, удалить человека, заморозить, удалить задачу.
 *
 * `confirmWord` включает строгий режим: кнопка оживает, только когда человек
 * НАБРАЛ слово руками. Вставка запрещена нарочно -- смысл строгого режима в
 * паузе, а copy-paste эту паузу убирает. Автодополнение и подсказки клавиатуры
 * тоже выключены: они подставляют название целиком.
 */
export function Confirm({
  title, text, confirmLabel, confirmWord, onConfirm, onClose,
}: {
  title: string;
  text?: string;
  confirmLabel: string;
  /** Слово, которое надо набрать руками. Без него -- обычное «да/нет». */
  confirmWord?: string;
  onConfirm: () => Promise<void> | void;
  onClose: () => void;
}) {
  const [typed, setTyped] = useState('');
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const ready = !confirmWord || typed.trim() === confirmWord;

  async function go() {
    if (!ready || busy) return;
    setBusy(true);
    setError(null);
    try {
      await onConfirm();
      onClose();
    } catch (err) {
      setError(err instanceof Error ? err.message : 'Не получилось.');
      setBusy(false);
    }
  }

  return (
    <Sheet labelledBy="confirm-title" onClose={onClose}>
      <div className="sheet-head">
        <h2 id="confirm-title" className="sheet-title">{title}</h2>
        <button type="button" onClick={onClose} aria-label="Закрыть" className="btn-icon"><X aria-hidden="true" /></button>
      </div>
      {error ? <div role="alert" className="alert alert-err">{error}</div> : null}
      {text ? <p className="prose" style={{ marginTop: 0 }}>{text}</p> : null}

      {confirmWord ? (
        <div className="field">
          <label className="lbl" htmlFor="confirm-word">Наберите «{confirmWord}», чтобы подтвердить</label>
          <input
            id="confirm-word"
            className="inp"
            autoFocus
            value={typed}
            autoComplete="off"
            autoCorrect="off"
            autoCapitalize="off"
            spellCheck={false}
            onChange={(e) => setTyped(e.target.value)}
            onPaste={(e) => e.preventDefault()}
            onDrop={(e) => e.preventDefault()}
            onKeyDown={(e) => { if (e.key === 'Enter') { e.preventDefault(); void go(); } }}
          />
          <p className="hint">Вставить нельзя — наберите руками.</p>
        </div>
      ) : null}

      <div className="btn-row">
        <button type="button" className="btn" onClick={onClose} disabled={busy}>Отмена</button>
        <button type="button" className="btn btn-danger" disabled={!ready || busy} onClick={() => void go()}>{confirmLabel}</button>
      </div>
    </Sheet>
  );
}
