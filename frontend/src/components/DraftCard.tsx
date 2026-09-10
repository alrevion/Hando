import { useState } from 'react';
import { CalendarDays, Check, Trash2 } from 'lucide-react';
import type { Priority, User } from '../types';
import { ApiError, confirmDraft, deleteDraft, patchDraft, type DraftView } from '../lib/api';
import { PRIORITIES } from '../lib/priority';
import { endOfWeek, inDays } from './QuickEdit';

/** «пт, 12 сентября, 18:00» -- по часам телефона: смотрит-то человек. */
function when(iso: string): string {
  return new Intl.DateTimeFormat('ru-RU', { weekday: 'short', day: 'numeric', month: 'long', hour: '2-digit', minute: '2-digit' })
    .format(new Date(iso));
}

/**
 * Карточка черновика -- та же, что бот присылает в чат: тема, кому, срок,
 * важность, «услышал». Каждое поле правится на месте, и только «Создать»
 * заводит поручение. Это самая главная кнопка: разбор ошибается, и не тому
 * понятый адресат должен ловиться здесь, а не через неделю.
 */
export function DraftCard({
  draft, users, me, onChange, onCreated, onDeleted,
}: {
  draft: DraftView;
  users: User[];
  me: User;
  onChange?: (d: DraftView) => void;
  onCreated: (taskId: string) => void;
  onDeleted: () => void;
}) {
  const [d, setD] = useState(draft);
  const [title, setTitle] = useState(draft.title);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const who = d.assignee_ids[0] ?? '';
  // Люди -- участники организации; автор в списке всегда, даже если
  // справочник ему недоступен (сотрудник видит только себя).
  const people = users.some((u) => u.id === me.id) ? users : [me, ...users];

  async function run<T>(fn: () => Promise<T>): Promise<T | undefined> {
    setBusy(true);
    setError(null);
    try {
      return await fn();
    } catch (err) {
      setError(err instanceof ApiError ? err.message : 'Не получилось. Попробуйте ещё раз.');
      return undefined;
    } finally {
      setBusy(false);
    }
  }

  async function patch(p: Parameters<typeof patchDraft>[1]) {
    const next = await run(() => patchDraft(d.id, p));
    if (next) { setD(next); setTitle(next.title); onChange?.(next); }
  }

  return (
    <div className="card">
      {error ? <div role="alert" className="alert alert-err">{error}</div> : null}

      <div className="field">
        <label className="lbl" htmlFor={`d-title-${d.id}`}>Тема</label>
        <input
          id={`d-title-${d.id}`}
          className="inp"
          value={title}
          disabled={busy}
          onChange={(e) => setTitle(e.target.value)}
          onBlur={() => { const t = title.trim(); if (t && t !== d.title) void patch({ title: t }); }}
        />
      </div>

      <div className="field">
        <label className="lbl" htmlFor={`d-who-${d.id}`}>Кому</label>
        <select
          id={`d-who-${d.id}`}
          className="inp"
          value={who}
          disabled={busy}
          aria-invalid={!who}
          onChange={(e) => void patch({ assignee_ids: e.target.value ? [e.target.value] : [] })}
        >
          <option value="">Не понял — выберите</option>
          {people.map((u) => <option key={u.id} value={u.id}>{u.id === me.id ? 'Мне' : u.name}</option>)}
        </select>
      </div>

      <div className="sec-title" style={{ margin: '4px 0 8px' }}>Срок{d.deadline ? `: ${when(d.deadline)}` : ' не указан'}</div>
      <div className="chips" style={{ paddingBottom: 8, flexWrap: 'wrap', overflowX: 'visible' }}>
        <button type="button" className="chip" disabled={busy} onClick={() => void patch({ deadline: inDays(0) })}>Сегодня</button>
        <button type="button" className="chip" disabled={busy} onClick={() => void patch({ deadline: inDays(1) })}>Завтра</button>
        <button type="button" className="chip" disabled={busy} onClick={() => void patch({ deadline: endOfWeek() })}>В конце недели</button>
        {d.deadline ? <button type="button" className="chip" disabled={busy} onClick={() => void patch({ deadline: null })}>Убрать</button> : null}
        <label className="chip" style={{ position: 'relative', overflow: 'hidden' }}>
          <CalendarDays aria-hidden="true" style={{ width: 14, height: 14 }} />
          Дата
          {/* Поле прозрачно и растянуто на кнопку: нажатие открывает системный
              выбор даты, а вид остаётся наш. */}
          <input
            type="date"
            disabled={busy}
            value={d.deadline ? d.deadline.slice(0, 10) : ''}
            onChange={(e) => { if (e.target.value) void patch({ deadline: e.target.value }); }}
            style={{ position: 'absolute', inset: 0, opacity: 0, width: '100%', height: '100%' }}
          />
        </label>
      </div>

      <div className="sec-title" style={{ margin: '4px 0 8px' }}>
        Важность{d.priority_explicit ? '' : <span className="muted"> · не сказана</span>}
      </div>
      <div className="chips" style={{ paddingBottom: 8 }}>
        {PRIORITIES.map((p) => (
          <button
            key={p.value}
            type="button"
            disabled={busy}
            className={d.priority === p.value ? 'chip on' : 'chip'}
            onClick={() => void patch({ priority: p.value as Priority })}
          >
            {p.label}
          </button>
        ))}
      </div>

      {/* Что именно услышано -- чтобы «Иве» вместо «Еве» было видно сразу. */}
      {d.heard ? <p className="hint">Услышал: «{d.heard}»{d.media_count > 0 ? ` · вложений: ${d.media_count}` : ''}</p> : null}

      <div className="btn-row">
        <button
          type="button"
          className="btn btn-danger"
          disabled={busy}
          onClick={async () => { if (await run(() => deleteDraft(d.id))) onDeleted(); }}
        >
          <Trash2 aria-hidden="true" style={{ width: 16, height: 16 }} />
          Удалить
        </button>
        <button
          type="button"
          className="btn btn-primary"
          disabled={busy || !who}
          onClick={async () => { const r = await run(() => confirmDraft(d.id)); if (r) onCreated(r.id); }}
        >
          <Check aria-hidden="true" style={{ width: 16, height: 16 }} />
          Создать
        </button>
      </div>
      {!who ? <p className="hint">Выберите, кому поручение, — без этого не создать.</p> : null}
    </div>
  );
}
