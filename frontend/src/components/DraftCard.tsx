import { useState } from 'react';
import { CalendarDays, Check, Paperclip, Trash2 } from 'lucide-react';
import type { Priority, User } from '../types';
import { ApiError, confirmDraft, deleteDraft, uploadDraftFile, type DraftEdits, type DraftView } from '../lib/api';
import { PRIORITIES } from '../lib/priority';
import { endOfWeek, inDays } from './QuickEdit';

/** «пт, 12 сентября, 18:00» -- по часам телефона: смотрит-то человек. */
function when(iso: string): string {
  return new Intl.DateTimeFormat('ru-RU', { weekday: 'short', day: 'numeric', month: 'long', hour: '2-digit', minute: '2-digit' })
    .format(new Date(iso));
}

/**
 * Карточка черновика -- та же, что бот присылает в чат: тема, кому, содержание,
 * вложения, важность, срок. Только «Создать» заводит поручение.
 *
 * ВСЕ правки живут НА УСТРОЙСТВЕ. Раньше каждое нажатие -- срок, важность,
 * кому -- уходило на сервер отдельным запросом, и человек ждал сеть на каждый
 * чип: на медленном интернете карточка отвечала через секунду после нажатия.
 * Теперь сеть трогается ровно дважды: файл при выборе (его иначе не донести) и
 * «Создать», которое отправляет весь итог одним запросом.
 *
 * Цена: закрыл карточку -- правки не сохранились. Это честный размен, о нём
 * говорит подпись под кнопками.
 */
export function DraftCard({
  draft, users, me, mode, onCreated, onDeleted,
}: {
  draft: DraftView;
  users: User[];
  me: User;
  /** «Мои задачи» -- поручение себе, спрашивать «кому» незачем. */
  mode?: 'mine' | 'assigned';
  onCreated: (taskId: string) => void;
  onDeleted: () => void;
}) {
  const [title, setTitle] = useState(draft.title);
  const [description, setDescription] = useState(draft.description ?? '');
  const [who, setWho] = useState(draft.assignee_ids[0] ?? (mode === 'mine' ? me.id : ''));
  const [deadline, setDeadline] = useState<string | null>(draft.deadline);
  const [priority, setPriority] = useState<Priority>(draft.priority);
  const [priorityTouched, setTouched] = useState(draft.priority_explicit);
  const [files, setFiles] = useState(draft.media_count);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);

  // Люди -- участники организации; автор в списке всегда, даже если справочник
  // ему недоступен (сотрудник видит только себя).
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

  const edits = (): DraftEdits => ({
    title: title.trim(),
    description: description.trim() ? description.trim() : null,
    assignee_ids: who ? [who] : [],
    deadline,
    priority,
  });

  return (
    <div className="card">
      {error ? <div role="alert" className="alert alert-err">{error}</div> : null}

      <div className="field">
        <label className="lbl" htmlFor={`d-title-${draft.id}`}>Тема</label>
        <input id={`d-title-${draft.id}`} className="inp" value={title} disabled={busy}
          onChange={(e) => setTitle(e.target.value)} />
      </div>

      {mode === 'mine' ? null : (
        <div className="field">
          <label className="lbl" htmlFor={`d-who-${draft.id}`}>Кому</label>
          <select id={`d-who-${draft.id}`} className="inp" value={who} disabled={busy} aria-invalid={!who}
            onChange={(e) => setWho(e.target.value)}>
            <option value="">Не понял — выберите</option>
            {people.map((u) => <option key={u.id} value={u.id}>{u.id === me.id ? 'Мне' : u.name}</option>)}
          </select>
        </div>
      )}

      <div className="field">
        <label className="lbl" htmlFor={`d-desc-${draft.id}`}>Содержание</label>
        <textarea id={`d-desc-${draft.id}`} className="inp" rows={3} value={description} disabled={busy}
          placeholder="Подробности, если нужны: где взять, с кем согласовать, что считать готовым"
          onChange={(e) => setDescription(e.target.value)} />
      </div>

      <div className="sec-title" style={{ margin: '4px 0 8px' }}>Важность</div>
      <div className="chips" style={{ paddingBottom: 8 }}>
        {PRIORITIES.map((p) => (
          <button key={p.value} type="button" disabled={busy}
            className={priority === p.value ? 'chip on' : 'chip'}
            onClick={() => { setPriority(p.value as Priority); setTouched(true); }}>
            {p.label}
          </button>
        ))}
        {priorityTouched ? null : <span className="muted" style={{ alignSelf: 'center', fontSize: 12.5 }}>не сказана</span>}
      </div>

      <div className="sec-title" style={{ margin: '4px 0 8px' }}>Срок{deadline ? `: ${when(deadline)}` : ' не указан'}</div>
      <div className="chips" style={{ paddingBottom: 8, flexWrap: 'wrap', overflowX: 'visible' }}>
        <button type="button" className="chip" disabled={busy} onClick={() => setDeadline(inDays(0))}>Сегодня</button>
        <button type="button" className="chip" disabled={busy} onClick={() => setDeadline(inDays(1))}>Завтра</button>
        <button type="button" className="chip" disabled={busy} onClick={() => setDeadline(endOfWeek())}>В конце недели</button>
        {deadline ? <button type="button" className="chip" disabled={busy} onClick={() => setDeadline(null)}>Убрать</button> : null}
        <label className="chip" style={{ position: 'relative', overflow: 'hidden' }}>
          <CalendarDays aria-hidden="true" style={{ width: 14, height: 14 }} />
          Дата
          {/* Поле прозрачно и растянуто на кнопку: нажатие открывает системный
              выбор даты, а вид остаётся наш. */}
          <input type="date" disabled={busy} value={deadline ? deadline.slice(0, 10) : ''}
            onChange={(e) => { if (e.target.value) setDeadline(e.target.value); }}
            style={{ position: 'absolute', inset: 0, opacity: 0, width: '100%', height: '100%' }} />
        </label>
      </div>

      {/* Файл -- единственное, что нельзя отложить до «Создать»: он должен
          уехать в хранилище сразу, иначе его негде держать до подтверждения. */}
      <label className="btn" style={{ position: 'relative', overflow: 'hidden', marginTop: 4 }}>
        <Paperclip aria-hidden="true" style={{ width: 16, height: 16 }} />
        {files > 0 ? `Вложений: ${files}` : 'Прикрепить файл'}
        <input type="file" disabled={busy} aria-label="Прикрепить файл"
          style={{ position: 'absolute', inset: 0, opacity: 0, width: '100%', height: '100%' }}
          onChange={async (e) => {
            const f = e.target.files?.[0];
            e.target.value = '';
            if (!f) return;
            const next = await run(() => uploadDraftFile(draft.id, f));
            if (next) setFiles(next.media_count);
          }} />
      </label>

      {/* Что именно услышано -- чтобы «Иве» вместо «Еве» было видно сразу. */}
      {draft.heard ? <p className="hint">Услышал: «{draft.heard}»</p> : null}

      <div className="btn-row">
        <button type="button" className="btn btn-danger" disabled={busy}
          onClick={async () => { if (await run(() => deleteDraft(draft.id))) onDeleted(); }}>
          <Trash2 aria-hidden="true" style={{ width: 16, height: 16 }} />
          Удалить
        </button>
        <button type="button" className="btn btn-primary" disabled={busy || !who || title.trim().length < 2}
          onClick={async () => { const r = await run(() => confirmDraft(draft.id, edits())); if (r) onCreated(r.id); }}>
          <Check aria-hidden="true" style={{ width: 16, height: 16 }} />
          Создать
        </button>
      </div>
      {!who ? <p className="hint">Выберите, кому поручение, — без этого не создать.</p> : null}
    </div>
  );
}
