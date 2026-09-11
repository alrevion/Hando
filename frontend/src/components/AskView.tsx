import { useEffect, useRef, useState } from 'react';
import { Send } from 'lucide-react';
import { ApiError, askAssistant, type AskTurn } from '../lib/api';

/**
 * «Вопрос» -- собеседник (раздел 23): как пользоваться Hando и за что взяться.
 * Уточняющие вопросы -- часть работы, поэтому это диалог, а не одна реплика.
 */
export function AskView() {
  const [turns, setTurns] = useState<AskTurn[]>([]);
  const [text, setText] = useState('');
  const [busy, setBusy] = useState(false);
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
          {busy ? <div className="bubble muted">Думаю…</div> : null}
          <div ref={end} />
        </div>
      )}
      <form className="t-row" style={{ gap: 8, marginTop: 12, alignItems: 'flex-end' }} onSubmit={(e) => { e.preventDefault(); void send(); }}>
        <textarea className="inp grow" rows={2} value={text} placeholder="Ваш вопрос…" onChange={(e) => setText(e.target.value)}
          onKeyDown={(e) => { if (e.key === 'Enter' && !e.shiftKey) { e.preventDefault(); void send(); } }} />
        <button type="submit" className="btn btn-primary" disabled={busy || !text.trim()} aria-label="Отправить"><Send aria-hidden="true" style={{ width: 16, height: 16 }} /></button>
      </form>
    </div>
  );
}
