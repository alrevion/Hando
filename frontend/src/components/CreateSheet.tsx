import { useEffect, useRef, useState } from 'react';
import { Mic, Square, X } from 'lucide-react';
import type { User } from '../types';
import { ApiError, dictateTask, type DictateResult } from '../lib/api';
import { Sheet } from './Sheet';
import { useData } from '../context/DataContext';

/** Есть ли в этом браузере запись с микрофона. В WebView Telegram бывает и нет. */
function canRecord(): boolean {
  return typeof navigator !== 'undefined'
    && !!navigator.mediaDevices?.getUserMedia
    && typeof MediaRecorder !== 'undefined';
}

/**
 * Новая задача одной фразой: наговорить или написать.
 *
 * Разбирает её тот же код, что разбирает сообщения боту, -- срок и адресат
 * достаются из самой фразы. Поэтому здесь нет полей «срочность», «зависит от»
 * и прочего: подробная форма живёт на доске, а это быстрый ввод под большой
 * палец.
 *
 * `mode` задаёт, кому задача по умолчанию: на «Моих задачах» -- себе, на
 * «Поручениях» и доске нужно выбрать человека, иначе поручение молча осталось
 * бы у автора.
 */
export function CreateSheet({
  mode, me, onClose,
}: { mode: 'mine' | 'assigned'; me: User; onClose: () => void }) {
  const { users, refresh } = useData();
  const [text, setText] = useState('');
  const [assignee, setAssignee] = useState(mode === 'mine' ? me.id : '');
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [done, setDone] = useState<DictateResult | null>(null);
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
      const res = await dictateTask({ ...body, assignee_id: assignee || undefined });
      setDone(res);
      await refresh();
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

  const needsPerson = mode !== 'mine' && !assignee;

  return (
    <Sheet labelledBy="create-title" onClose={onClose}>
      <div className="sheet-head">
        <h2 id="create-title" className="sheet-title">
          {mode === 'mine' ? 'Новая задача себе' : 'Новое поручение'}
        </h2>
        <button type="button" onClick={onClose} aria-label="Закрыть" className="btn-icon"><X aria-hidden="true" /></button>
      </div>

      {done ? (
        <>
          {/* Показываем, КАК фраза понята: не тот адресат или не тот срок видно
              сразу, а не через неделю. */}
          <div className="alert alert-ok">Записал.</div>
          <div className="card">
            <span className="t-title">{done.title}</span>
            <span className="t-meta"><span>Кому: {done.assignees.join(', ') || 'вам'}</span></span>
            <span className="t-meta">
              <span>Срок: {done.deadline ? new Date(done.deadline).toLocaleString('ru-RU', { day: 'numeric', month: 'long', hour: '2-digit', minute: '2-digit' }) : 'не указан'}</span>
            </span>
          </div>
          <div className="btn-row">
            <button type="button" className="btn" onClick={() => { setDone(null); setText(''); }}>Ещё одну</button>
            <button type="button" className="btn btn-primary" onClick={onClose}>Готово</button>
          </div>
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
              <p className="hint">Срок можно назвать словами: «завтра», «до пятницы», «в пт».</p>
            </div>

            {mode !== 'mine' ? (
              <div className="field">
                <label className="lbl" htmlFor="create-who">Кому</label>
                <select id="create-who" className="inp" value={assignee} onChange={(e) => setAssignee(e.target.value)}>
                  <option value="">Из фразы</option>
                  {users.map((u) => <option key={u.id} value={u.id}>{u.name}</option>)}
                </select>
              </div>
            ) : null}

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
              <button type="submit" className="btn btn-primary" disabled={busy || !text.trim() || needsPerson}>
                {busy ? 'Отправляю…' : 'Создать'}
              </button>
            </div>
            {needsPerson ? <p className="hint">Выберите, кому поручение, или назовите имя в самой фразе.</p> : null}
          </form>
        </>
      )}
    </Sheet>
  );
}
