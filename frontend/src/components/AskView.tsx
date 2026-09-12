import { useEffect, useRef, useState } from 'react';
import { Mic, Send, Square } from 'lucide-react';
import { ApiError, askAssistant, askByVoice, type AskTurn } from '../lib/api';

/** Есть ли в этом браузере запись с микрофона -- как в CreateSheet, но здесь
 *  только чтобы решить, показывать ли кнопку микрофона вообще. */
function canRecord(): boolean {
  return typeof navigator !== 'undefined'
    && !!navigator.mediaDevices?.getUserMedia
    && typeof MediaRecorder !== 'undefined';
}

/**
 * «Вопрос» -- собеседник (раздел 23): как пользоваться Hando и за что взяться.
 * Уточняющие вопросы -- часть работы, поэтому это диалог, а не одна реплика.
 */
export function AskView() {
  const [turns, setTurns] = useState<AskTurn[]>([]);
  const [text, setText] = useState('');
  const [busy, setBusy] = useState(false);
  // Запись уходит на расшифровку тем же whisper, что разбирает голосовые боту,
  // и возвращается уже ответом. Отдельный маршрут нужен потому, что путь
  // создания задачи из голоса завёл бы черновик поручения вместо ответа.
  const [voiceHint, setVoiceHint] = useState<string | null>(null);
  const [recording, setRecording] = useState(false);
  const recorder = useRef<MediaRecorder | null>(null);
  // Микрофон отпускается всегда, даже если экран закрыли на середине записи:
  // иначе в статус-баре остаётся висеть красная точка.
  useEffect(() => () => { recorder.current?.stream.getTracks().forEach((t) => t.stop()); }, []);

  async function ask(question: string, history: AskTurn[], answer: string) {
    setTurns([...history, { role: 'user', text: question }, { role: 'assistant', text: answer }]);
  }

  async function toggleRecording() {
    if (recording) { recorder.current?.stop(); return; }
    setVoiceHint(null);
    try {
      const stream = await navigator.mediaDevices.getUserMedia({ audio: true });
      const rec = new MediaRecorder(stream);
      const chunks: Blob[] = [];
      rec.ondataavailable = (e) => { if (e.data.size > 0) chunks.push(e.data); };
      rec.onstop = async () => {
        stream.getTracks().forEach((t) => t.stop());
        setRecording(false);
        const blob = new Blob(chunks, { type: rec.mimeType || 'audio/webm' });
        if (blob.size === 0) return;
        const history = turns;
        setBusy(true);
        try {
          const r = await askByVoice(blob);
          await ask(r.question, history, r.answer);
        } catch (err) {
          setVoiceHint(err instanceof ApiError ? err.message : 'Не удалось разобрать запись.');
        } finally {
          setBusy(false);
        }
      };
      recorder.current = rec;
      rec.start();
      setRecording(true);
    } catch {
      // Отказ в доступе к микрофону -- решение человека, а не ошибка.
      setVoiceHint('Микрофон недоступен. Напишите текстом или наговорите боту в чат.');
    }
  }
  const end = useRef<HTMLDivElement>(null);
  useEffect(() => { end.current?.scrollIntoView({ block: 'end' }); }, [turns]);

  async function send() {
    const q = text.trim();
    if (!q || busy) return;
    setText('');
    const history = turns;
    setTurns([...turns, { role: 'user', text: q }]);
    setBusy(true);
    try {
      const a = await askAssistant(q, history);
      setTurns((t) => [...t, { role: 'assistant', text: a.answer }]);
    } catch (err) {
      setTurns((t) => [...t, { role: 'assistant', text: err instanceof ApiError ? err.message : 'Не получилось ответить. Попробуйте ещё раз.' }]);
    } finally {
      setBusy(false);
    }
  }

  return (
    <div className="lg:h-full lg:overflow-y-auto lg:p-6">
      <h1 className="h1">Вопрос</h1>
      {turns.length === 0 ? (
        <div className="empty">
          <b>Спросите или скомандуйте</b>
          «За что взяться сначала?», «Что у меня горит на этой неделе?»
          {/* Команда отличается от вопроса только тем, что в ней названа тема
              задачи: отдельного режима нет, и объяснять его не приходится. */}
          Назовите тему — и командуйте: «взял в работу подготовить отчёт»,
          «подготовить отчёт готово», «не успеваю подготовить отчёт, жду документы»,
          «верни подготовить отчёт на доработку, нет итогов».
        </div>
      ) : (
        <div className="stack" style={{ gap: 8 }}>
          {turns.map((t, i) => (
            <div key={i} className={t.role === 'user' ? 'bubble bubble-me' : 'bubble'}>{t.text}</div>
          ))}
          {busy ? (
            // Вместо «Думаю…» -- три пульсирующие точки, как индикатор набора
            // в мессенджерах: тот же пузырь, но без текста, который дублирует
            // спиннер рядом с кнопкой отправки.
            <div className="bubble" aria-live="polite" aria-label="Помощник печатает">
              <span className="typing"><span /><span /><span /></span>
            </div>
          ) : null}
          <div ref={end} />
        </div>
      )}

      <form className="ask-compose" onSubmit={(e) => { e.preventDefault(); void send(); }}>
        {canRecord() ? (
          <button
            type="button"
            className={recording ? 'btn-icon is-danger' : 'btn-icon'}
            aria-label={recording ? 'Остановить запись' : 'Наговорить вопрос'}
            disabled={busy && !recording}
            onClick={() => void toggleRecording()}
          >
            {recording ? <Square aria-hidden="true" /> : <Mic aria-hidden="true" />}
          </button>
        ) : null}
        <textarea
          className="inp grow"
          rows={1}
          value={text}
          placeholder="Ваш вопрос…"
          onChange={(e) => { setText(e.target.value); setVoiceHint(null); }}
          onKeyDown={(e) => { if (e.key === 'Enter' && !e.shiftKey) { e.preventDefault(); void send(); } }}
        />
        <button type="submit" className="btn-icon is-accent" disabled={busy || !text.trim()} aria-label="Спросить">
          <Send aria-hidden="true" />
        </button>
      </form>
      {recording ? <p className="hint">Идёт запись — нажмите квадрат, когда закончите.</p> : null}
      {voiceHint ? <p className="hint">{voiceHint}</p> : null}
    </div>
  );
}
