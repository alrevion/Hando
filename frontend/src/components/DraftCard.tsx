import { useRef, useState } from 'react';
import { CalendarDays, Check, Clock, Mic, Paperclip, Repeat, Square, Trash2, Wand2 } from 'lucide-react';
import type { Priority, User } from '../types';
import { ApiError, confirmDraft, deleteDraft, refineDraftByPhrase, uploadDraftFile, type DraftEdits, type DraftView } from '../lib/api';
import { PRIORITIES } from '../lib/priority';
import { REPEAT_CHOICES, repeatLabel } from '../lib/tasks';
import { IntervalSheet } from './IntervalSheet';
import { TimeSheet } from './TimeSheet';
import { endOfWeek, inDays } from './QuickEdit';

/** Есть ли запись с микрофона: в WebView Telegram бывает и нет. */
function canRecord(): boolean {
  return typeof navigator !== 'undefined'
    && !!navigator.mediaDevices?.getUserMedia
    && typeof MediaRecorder !== 'undefined';
}

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
  const [repeat, setRepeat] = useState<number>(draft.repeat_min ?? 0);
  const [sheet, setSheet] = useState<null | 'interval' | 'time'>(null);
  const [files, setFiles] = useState(draft.media_count);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  // Поправка словами -- тот же путь, что ответ на карточку в боте: фраза
  // разбирается поверх того, что сейчас на экране, и меняет только названные
  // поля. Записи в базу нет: карточка живёт на устройстве до «Создать».
  const [fix, setFix] = useState('');
  const [heard, setHeard] = useState<string | null>(null);
  const [recording, setRecording] = useState(false);
  const recorder = useRef<MediaRecorder | null>(null);

  function applyPatch(p: { title?: string; assignee_ids?: string[]; deadline?: string | null; priority?: Priority }) {
    if (p.title !== undefined) setTitle(p.title);
    if (p.assignee_ids !== undefined) setWho(p.assignee_ids[0] ?? '');
    if (p.deadline !== undefined) setDeadline(p.deadline);
    if (p.priority !== undefined) { setPriority(p.priority); setTouched(true); }
  }

  async function sendFix(input: { text: string } | { audio: Blob }) {
    const res = await run(() => refineDraftByPhrase(draft.id, input, {
      title: title.trim(), assignee_ids: who ? [who] : [], deadline, priority,
    }));
    if (!res) return;
    setHeard(res.heard);
    if (Object.keys(res.patch).length === 0) {
      setError('Не понял поправку. Скажите, что именно изменить: «срок вторник», «не Азизу, а Беку», «это срочно».');
      return;
    }
    applyPatch(res.patch);
    setFix('');
  }

  async function toggleFixRecording() {
    if (recording) { recorder.current?.stop(); return; }
    setError(null);
    try {
      const stream = await navigator.mediaDevices.getUserMedia({ audio: true });
      const rec = new MediaRecorder(stream);
      const chunks: Blob[] = [];
      rec.ondataavailable = (e) => { if (e.data.size > 0) chunks.push(e.data); };
      rec.onstop = async () => {
        stream.getTracks().forEach((t) => t.stop());
        setRecording(false);
        const blob = new Blob(chunks, { type: rec.mimeType || 'audio/webm' });
        if (blob.size > 0) await sendFix({ audio: blob });
      };
      recorder.current = rec;
      rec.start();
      setRecording(true);
    } catch {
      setError('Микрофон недоступен. Напишите поправку текстом.');
    }
  }

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
    repeat_min: repeat || null,
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

      {/* ПОВТОР -- рядом со сроком, а не в глубине правки: «поливать через
          день» это свойство самой задачи, и ставится оно там же, где срок. */}
      <div className="sec-title" style={{ margin: '4px 0 8px' }}>Повтор{repeat && !REPEAT_CHOICES.includes(repeat) ? `: ${repeatLabel(repeat).toLowerCase()}` : ''}</div>
      {/* В ДВЕ СТРОКИ, как и срок: пять вариантов в одну строку уезжают за
          край, и последний («Каждый месяц») человек просто не видит. */}
      <div className="chips" style={{ paddingBottom: 10, flexWrap: 'wrap', overflowX: 'visible' }}>
        {REPEAT_CHOICES.map((d) => (
          <button key={d} type="button" disabled={busy}
            className={repeat === d ? 'chip on' : 'chip'}
            onClick={() => setRepeat(d)}>{repeatLabel(d || null)}</button>
        ))}
        <button type="button" disabled={busy}
          className={repeat && !REPEAT_CHOICES.includes(repeat) ? 'chip on' : 'chip'}
          onClick={() => setSheet('interval')}>
          <Repeat aria-hidden="true" style={{ width: 14, height: 14 }} />Свой
        </button>
      </div>

      <div className="sec-title" style={{ margin: '4px 0 8px' }}>Срок{deadline ? `: ${when(deadline)}` : ' не указан'}</div>
      <div className="chips" style={{ paddingBottom: 8, flexWrap: 'wrap', overflowX: 'visible' }}>
        <button type="button" className="chip" disabled={busy} onClick={() => setDeadline(inDays(0))}>Сегодня</button>
        <button type="button" className="chip" disabled={busy} onClick={() => setDeadline(inDays(1))}>Завтра</button>
        <button type="button" className="chip" disabled={busy} onClick={() => setDeadline(endOfWeek())}>В конце недели</button>
        {deadline ? <button type="button" className="chip" disabled={busy} onClick={() => setDeadline(null)}>Убрать</button> : null}
        {deadline ? (
          <button type="button" className="chip" disabled={busy} onClick={() => setSheet('time')}>
            <Clock aria-hidden="true" style={{ width: 14, height: 14 }} />Время
          </button>
        ) : null}
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

      <div className="sec-title" style={{ margin: '4px 0 8px' }}>Файлы</div>

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

      {/* ПОПРАВКА СЛОВАМИ -- то же, что ответ на карточку в боте: не надо искать
          нужное поле, достаточно сказать, что не так. */}
      <div className="field" style={{ marginTop: 12 }}>
        <label className="lbl" htmlFor={`d-fix-${draft.id}`}>Поправить словами</label>
        <div className="ask-compose" style={{ marginTop: 0 }}>
          <input id={`d-fix-${draft.id}`} className="inp grow" value={fix} disabled={busy}
            placeholder="«не Азизу, а Беку», «срок вторник», «это срочно»"
            onChange={(e) => { setFix(e.target.value); setError(null); }}
            onKeyDown={(e) => { if (e.key === 'Enter' && fix.trim()) { e.preventDefault(); void sendFix({ text: fix.trim() }); } }} />
          {canRecord() ? (
            <button type="button" className={recording ? 'btn-icon is-tall is-danger' : 'btn-icon is-tall'} disabled={busy && !recording}
              aria-label={recording ? 'Остановить запись' : 'Наговорить поправку'} onClick={() => void toggleFixRecording()}>
              {recording ? <Square aria-hidden="true" /> : <Mic aria-hidden="true" />}
            </button>
          ) : null}
          <button type="button" className="btn-icon is-tall is-accent" disabled={busy || !fix.trim()}
            aria-label="Применить поправку" onClick={() => void sendFix({ text: fix.trim() })}>
            <Wand2 aria-hidden="true" />
          </button>
        </div>
        {recording ? <p className="hint">Идёт запись — нажмите квадрат, когда закончите.</p> : null}
      </div>

      {sheet === 'interval' ? (
        <IntervalSheet value={repeat || null} onPick={setRepeat} onClose={() => setSheet(null)} />
      ) : null}
      {sheet === 'time' ? (
        <TimeSheet iso={deadline} onPick={setDeadline} onClose={() => setSheet(null)} />
      ) : null}

      {/* Что именно услышано -- чтобы «Иве» вместо «Еве» было видно сразу. */}
      {heard ? <p className="hint">Поправка: «{heard}»</p> : draft.heard ? <p className="hint">Услышал: «{draft.heard}»</p> : null}

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
