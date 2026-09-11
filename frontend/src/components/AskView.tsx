import { useEffect, useRef, useState } from 'react';
import { Mic, Send } from 'lucide-react';
import { ApiError, askAssistant, type AskTurn } from '../lib/api';

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
  // На бэкенде нет функции «расшифруй аудио и спроси»: dictateTask принимает
  // звук, но создаёт черновик ЗАДАЧИ, а askAssistant принимает только текст.
  // Поэтому настоящую запись (как в CreateSheet) здесь не заводим -- она бы
  // просила доступ к микрофону ради звука, который некуда отправить, и тихо
  // его выбрасывала. Кнопка есть, но честно объясняет, что делать вместо неё.
  const [voiceHint, setVoiceHint] = useState(false);
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
          <b>Спросите что угодно</b>
          «Как отметить выполненную?», «За что взяться сначала?», «Что у меня горит на этой неделе?»
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
            className="btn-icon"
            aria-label="Наговорить вопрос"
            onClick={() => setVoiceHint(true)}
          >
            <Mic aria-hidden="true" />
          </button>
        ) : null}
        <textarea
          className="inp grow"
          rows={1}
          value={text}
          placeholder="Ваш вопрос…"
          onChange={(e) => { setText(e.target.value); setVoiceHint(false); }}
          onKeyDown={(e) => { if (e.key === 'Enter' && !e.shiftKey) { e.preventDefault(); void send(); } }}
        />
        <button type="submit" className="btn-icon is-accent" disabled={busy || !text.trim()} aria-label="Спросить">
          <Send aria-hidden="true" />
        </button>
      </form>
      {voiceHint ? <p className="hint">Наговорите вопрос боту в чат -- здесь голосом пока нельзя.</p> : null}
    </div>
  );
}
