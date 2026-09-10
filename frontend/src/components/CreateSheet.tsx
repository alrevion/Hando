import { useEffect, useRef, useState } from 'react';
import { Mic, Square, X } from 'lucide-react';
import type { User } from '../types';
import { ApiError, dictateTask, type DraftView } from '../lib/api';
import { DraftCard } from './DraftCard';
import { useData } from '../context/DataContext';
import { Sheet } from './Sheet';

/** Есть ли в этом браузере запись с микрофона. В WebView Telegram бывает и нет. */
function canRecord(): boolean {
  return typeof navigator !== 'undefined'
    && !!navigator.mediaDevices?.getUserMedia
    && typeof MediaRecorder !== 'undefined';
}

/**
 * Новая задача одной фразой: наговорить или написать.
 *
 * Разбирает её тот же код, что разбирает сообщения боту, и результат -- тот
 * же ЧЕРНОВИК: карточка «как понял» с полями, которые правятся на месте.
 * Задача появляется только после «Создать». Полей «кому» и «важность» до
 * разбора нет нарочно: их видно и правится в карточке, а форма до неё --
 * это одна фраза под большой палец.
 *
 * `mode` задаёт, кому по умолчанию: на «Моих задачах» -- себе, на
 * «Поручениях» адресат без имени во фразе остаётся пустым, и карточка спросит.
 */
export function CreateSheet({
  mode, me, onClose,
}: { mode: 'mine' | 'assigned'; me: User; onClose: () => void }) {
  const { users, refresh } = useData();
  const [text, setText] = useState('');
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [draft, setDraft] = useState<DraftView | null>(null);
  const [created, setCreated] = useState(false);
  const [recording, setRecording] = useState(false);
  const recorder = useRef<MediaRecorder | null>(null);

  // Микрофон отпускается ВСЕГДА, даже если шторку закрыли на середине записи:
  // иначе в статус-баре остаётся висеть красная точка.
  useEffect(() => () => {
    recorder.current?.stream.getTracks().forEach((t) => t.stop());
  }, []);

  async function send(body: { text: string } | { audio: Blob }) {
    setBusy(true);
    setError(null);
    try {
      setDraft(await dictateTask({ ...body, mode }));
    } catch (err) {
      setError(err instanceof ApiError ? err.message : 'Не получилось. Попробуйте ещё раз.');
    } finally {
      setBusy(false);
    }
  }

  async function toggleRecording() {
    if (recording) {
      recorder.current?.stop();
      return;
    }
    setError(null);
    try {
      const stream = await navigator.mediaDevices.getUserMedia({ audio: true });
      const rec = new MediaRecorder(stream);
      const chunks: Blob[] = [];
      rec.ondataavailable = (e) => { if (e.data.size > 0) chunks.push(e.data); };
      rec.onstop = () => {
        stream.getTracks().forEach((t) => t.stop());
        setRecording(false);
        const blob = new Blob(chunks, { type: rec.mimeType || 'audio/webm' });
        if (blob.size > 0) void send({ audio: blob });
      };
      recorder.current = rec;
      rec.start();
      setRecording(true);
    } catch {
      // Отказ в доступе к микрофону -- не ошибка приложения, а решение человека.
      setError('Микрофон недоступен. Напишите текстом или наговорите боту в чат.');
    }
  }

  const reset = () => { setDraft(null); setCreated(false); setText(''); };

  return (
    <Sheet labelledBy="create-title" onClose={onClose}>
      <div className="sheet-head">
        <h2 id="create-title" className="sheet-title">
          {created ? 'Создано' : draft ? 'Проверьте черновик' : mode === 'mine' ? 'Новая задача себе' : 'Новое поручение'}
        </h2>
        <button type="button" onClick={onClose} aria-label="Закрыть" className="btn-icon"><X aria-hidden="true" /></button>
      </div>

      {created ? (
        <>
          <div className="alert alert-ok">Поручение создано{draft?.assignees.length ? ` — ${draft.assignees.join(', ')} получит уведомление` : ''}.</div>
          <div className="btn-row">
            <button type="button" className="btn" onClick={reset}>Ещё одно</button>
            <button type="button" className="btn btn-primary" onClick={onClose}>Готово</button>
          </div>
        </>
      ) : draft ? (
        <>
          <DraftCard
            draft={draft}
            users={users}
            me={me}
            onChange={setDraft}
            onCreated={async () => { setCreated(true); await refresh(); }}
            onDeleted={reset}
          />
          <p className="hint">Черновик не пропадёт: он есть и в «Черновиках» бота, пока вы не нажмёте «Создать».</p>
        </>
      ) : (
        <>
          {error ? <div role="alert" className="alert alert-err">{error}</div> : null}

          <form onSubmit={(e) => { e.preventDefault(); if (text.trim()) void send({ text: text.trim() }); }}>
            <div className="field">
              <label className="lbl" htmlFor="create-text">Что нужно сделать</label>
              <textarea
                id="create-text"
                className="inp"
                autoFocus
                rows={3}
                value={text}
                placeholder={mode === 'mine' ? 'Сдать отчёт в пятницу' : 'Азизу подготовить отчёт до пятницы'}
                onChange={(e) => setText(e.target.value)}
              />
              <p className="hint">Срок и важность можно назвать словами: «завтра до трёх», «в пт», «срочно». Потом всё можно поправить.</p>
            </div>

            <div className="btn-row">
              {canRecord() ? (
                <button
                  type="button"
                  className={recording ? 'btn btn-danger' : 'btn'}
                  onClick={toggleRecording}
                  disabled={busy}
                >
                  {recording ? <Square aria-hidden="true" style={{ width: 16, height: 16 }} /> : <Mic aria-hidden="true" style={{ width: 16, height: 16 }} />}
                  {recording ? 'Стоп' : 'Наговорить'}
                </button>
              ) : null}
              <button type="submit" className="btn btn-primary" disabled={busy || !text.trim()}>
                {busy ? 'Разбираю…' : 'Далее'}
              </button>
            </div>
          </form>
        </>
      )}
    </Sheet>
  );
}
