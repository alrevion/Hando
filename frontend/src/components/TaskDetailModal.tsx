import { useEffect, useState, type ReactNode } from 'react';
import { Sheet } from './Sheet';
import { AlertTriangle, CalendarDays, Download, File as FileIcon, Paperclip, Trash2 } from 'lucide-react';
import type { ContentBlock, Priority, Task, User } from '../types';
import { parseContentBlocks } from '../types';
import { PRIORITY_DOT, PRIORITY_LABEL } from '../lib/priority';
import { toggleChecklistItem } from '../lib/api';
import { IntervalSheet } from './IntervalSheet';
import { TimeSheet } from './TimeSheet';
import { formatDeadlineDays, isReviewOverdue, isTaskOverdue } from '../lib/overdue';
import { Lightbox } from './Lightbox';
import { checklistOf, REPEAT_CHOICES, repeatLabel, STATE_PILL, stateLabel } from '../lib/tasks';
import { endOfWeek, inDays } from './QuickEdit';
import { PRIORITIES } from '../lib/priority';
import { useAuth } from '../context/AuthContext';
import { useData } from '../context/DataContext';
import { ApiError, deleteTask, getAttachments, updateTask, uploadAttachment, type AttachmentRow } from '../lib/api';
import { toast } from '../lib/toast';

function formatSize(bytes: number) {
  if (bytes < 1024) return `${bytes} B`;
  if (bytes < 1024 * 1024) return `${Math.round(bytes / 1024)} KB`;
  return `${(bytes / (1024 * 1024)).toFixed(1)} MB`;
}

// Consecutive photo blocks render as one horizontal, wrapping strip instead of
// each on its own line -- a run of 3 photos reads as a gallery, not a scroll.
// Consecutive file blocks render as a vertical list (filenames need room).
type Group =
  | { kind: 'text'; block: Extract<ContentBlock, { type: 'text' }> }
  | { kind: 'images'; blocks: Extract<ContentBlock, { type: 'image' }>[] }
  | { kind: 'files'; blocks: Extract<ContentBlock, { type: 'file' }>[] };

function groupBlocks(blocks: ContentBlock[]): Group[] {
  const groups: Group[] = [];
  for (const block of blocks) {
    if (block.type === 'text') {
      groups.push({ kind: 'text', block });
    } else if (block.type === 'image') {
      const last = groups[groups.length - 1];
      if (last?.kind === 'images') last.blocks.push(block);
      else groups.push({ kind: 'images', blocks: [block] });
    } else {
      const last = groups[groups.length - 1];
      if (last?.kind === 'files') last.blocks.push(block);
      else groups.push({ kind: 'files', blocks: [block] });
    }
  }
  return groups;
}

interface TaskDetailModalProps {
  task: Task;
  // Запасное имя, если у задачи нет строк адресатов (старые записи).
  responsible: User | undefined;
  onClose: () => void;
  // Кнопки действий внизу шторки (доска передаёт свои; сквозные экраны -- нет).
  actions?: ReactNode;
}

function formatDeadline(deadline: string) {
  const d = new Date(deadline);
  if (Number.isNaN(d.getTime())) return deadline;
  return d.toLocaleDateString('ru-RU', { day: 'numeric', month: 'long' });
}

// Шторка с полным содержимым задачи: текст целиком, все фото (сразу, а не по
// клику), файлы. По фото открывается Lightbox с листанием по всем фото задачи.
export function TaskDetailModal({ task: opened, responsible, onClose, actions }: TaskDetailModalProps) {
  // Живая строка из склада: после правки или перехода шторка обязана показать
  // новое, а не снимок, с которым её открыли.
  const { refresh, tasks: live, users } = useData();
  const task = live.find((t) => t.id === opened.id) ?? opened;
  const [lightboxIndex, setLightboxIndex] = useState<number | null>(null);
  // Срок и срочность правит автор или руководитель -- те же правила, что на
  // сервере (routes.ts, PATCH /tasks/:id/quick). Кнопок, ведущих в 403, быть
  // не должно.
  const { user: me } = useAuth();
  const canQuickEdit = !!me && (task.author_id === me.id || me.role === 'creator' || me.role === 'super_admin');
  // Вложения -- в том числе присланные боту: они лежат в attachments, а не в
  // content_blocks, и раньше приложение их не показывало вовсе.
  const [files, setFiles] = useState<AttachmentRow[]>([]);
  const [title, setTitle] = useState(task.title);
  const [desc, setDesc] = useState(task.description ?? '');
  const [deadline, setDeadline] = useState<string | null>(task.deadline ?? null);
  const [priority, setPriority] = useState<Priority>(task.priority);
  const [repeat, setRepeat] = useState<number>(task.repeat_min ?? 0);
  const [sheet, setSheet] = useState<null | 'interval' | 'time'>(null);
  // Список живёт своей жизнью: галочка сохраняется сразу, а не по «Сохранить».
  // Человек стоит у полки и отмечает морковку -- лишнее нажатие тут лишнее.
  const [items, setItems] = useState(() => checklistOf(task));
  const [who, setWho] = useState((task.assignees ?? [])[0]?.user_id ?? '');
  const [busy, setBusy] = useState(false);
  const [filesTick, setFilesTick] = useState(0);
  const loadFiles = () => setFilesTick((n) => n + 1);
  useEffect(() => {
    let cancelled = false;
    getAttachments(task.id).then((rows) => { if (!cancelled) setFiles(rows); }).catch(() => { if (!cancelled) setFiles([]); });
    return () => { cancelled = true; };
  }, [task.id, filesTick]);
  const inBlocks = new Set(parseContentBlocks(task).flatMap((b) => (b.type === 'image' || b.type === 'file' ? [b.attachment_id] : [])));
  const extra = files.filter((f) => !inBlocks.has(f.id));
  async function run(fn: () => Promise<unknown>, done: string) {
    setBusy(true);
    try { await fn(); toast(done); await refresh(); } catch (err) { toast(err instanceof ApiError ? err.message : 'Не получилось.'); } finally { setBusy(false); }
  }
  const isOverdue = isTaskOverdue(task);
  const reviewOverdue = isReviewOverdue(task);
  const blocks = parseContentBlocks(task);
  const groups = groupBlocks(blocks);
  const images = blocks
    .filter((b): b is Extract<ContentBlock, { type: 'image' }> => b.type === 'image')
    .map((b) => ({ src: `/api/attachments/${b.attachment_id}/download`, alt: task.title }));
  const assignees = task.assignees ?? [];
  // Сервер разрешает правку в todo, а в работе -- только владельцу
  // (routes.ts, PATCH /tasks/:id). Кнопок, ведущих в 403, быть не должно.
  const canEdit = canQuickEdit && (task.status === 'todo'
    || (task.status === 'in_progress' && (me?.role === 'creator' || me?.role === 'super_admin')));
  const single = (task.kind ?? 'single') === 'single';
  const people = users.some((u) => u.id === me?.id) || !me ? users : [me, ...users];
  const dirty = title.trim() !== task.title
    || desc !== (task.description ?? '')
    || deadline !== (task.deadline ?? null)
    || priority !== task.priority
    || repeat !== (task.repeat_min ?? 0)
    || (single && who !== ((task.assignees ?? [])[0]?.user_id ?? ''));

  return (
    <Sheet title={task.title} onClose={onClose}>
        <div className="pills" style={{ marginTop: 0, marginBottom: 16 }}>
          <span className="pill">
            <span className={`dot ${PRIORITY_DOT[task.priority]}`} aria-hidden="true" />
            <span>{PRIORITY_LABEL[task.priority]}</span>
          </span>
          {task.deadline ? (
            <span className={isOverdue ? 'pill pill-red' : 'pill'}>
              {isOverdue ? <AlertTriangle aria-hidden="true" /> : <CalendarDays aria-hidden="true" />}
              <span>{formatDeadline(task.deadline)} · {formatDeadlineDays(task.deadline)}</span>
            </span>
          ) : null}
          {reviewOverdue ? (
            <span className="pill pill-orange" title="Сдано больше двух дней назад и не проверено">
              <AlertTriangle aria-hidden="true" />
              <span>Ждёт проверки</span>
            </span>
          ) : null}
        </div>

        {assignees.length > 0 || responsible ? (
          <>
            <div className="sec-title" style={{ margin: '0 0 8px' }}>Кто делает</div>
            <div className="pills" style={{ margin: '0 0 16px' }}>
              {assignees.length > 0
                ? assignees.map((a) => (
                    <span key={a.user_id} className={STATE_PILL[a.state] ?? 'pill'}>
                      <span>{a.user_name} · {stateLabel(a.state)}</span>
                    </span>
                  ))
                : <span className="pill"><span>{responsible!.name}</span></span>}
            </div>
          </>
        ) : null}

        {blocks.length === 0 ? <p className="muted">Описания нет.</p> : null}

        <div className="stack" style={{ gap: 12 }}>
          {(() => {
            let imgCursor = 0;
            return groups.map((group, gi) => {
              if (group.kind === 'text') {
                return group.block.text ? <p key={gi} className="prose">{group.block.text}</p> : null;
              }
              if (group.kind === 'images') {
                return (
                  <div key={gi} style={{ display: 'flex', flexWrap: 'wrap', gap: 8 }}>
                    {group.blocks.map((block) => {
                      const idx = imgCursor;
                      imgCursor += 1;
                      return (
                        <img
                          key={block.attachment_id}
                          src={`/api/attachments/${block.attachment_id}/download`}
                          alt=""
                          loading="eager"
                          onClick={() => setLightboxIndex(idx)}
                          style={{ width: 132, height: 132, objectFit: 'cover', borderRadius: 12, cursor: 'zoom-in', background: 'var(--fill2)' }}
                        />
                      );
                    })}
                  </div>
                );
              }
              return (
                <div key={gi} className="stack" style={{ gap: 6 }}>
                  {group.blocks.map((block) => (
                    <a
                      key={block.attachment_id}
                      href={`/api/attachments/${block.attachment_id}/download`}
                      className="card card-tap"
                      style={{ display: 'flex', alignItems: 'center', gap: 10, padding: '10px 12px', background: 'var(--fill2)', boxShadow: 'none', textDecoration: 'none' }}
                    >
                      <FileIcon aria-hidden="true" style={{ width: 18, height: 18, flexShrink: 0, color: 'var(--label3)' }} />
                      <span style={{ minWidth: 0, flex: 1, overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap', fontSize: 15 }}>{block.filename}</span>
                      <span className="muted" style={{ fontSize: 12.5, flexShrink: 0 }}>{formatSize(block.size_bytes)}</span>
                      <Download aria-hidden="true" style={{ width: 16, height: 16, flexShrink: 0, color: 'var(--blue)' }} />
                    </a>
                  ))}
                </div>
              );
            });
          })()}
        </div>

        {extra.length > 0 ? (
          <div className="stack" style={{ gap: 6, marginTop: 12 }}>
            <div className="sec-title" style={{ margin: 0 }}>Вложения</div>
            <div style={{ display: 'flex', flexWrap: 'wrap', gap: 8 }}>
              {extra.filter((f) => f.mime_type.startsWith('image/')).map((f) => (
                <a key={f.id} href={`/api/attachments/${f.id}/download`} target="_blank" rel="noreferrer">
                  <img src={`/api/attachments/${f.id}/download`} alt={f.filename} loading="lazy" style={{ width: 132, height: 132, objectFit: 'cover', borderRadius: 12, background: 'var(--fill2)' }} />
                </a>
              ))}
            </div>
            {extra.filter((f) => !f.mime_type.startsWith('image/')).map((f) => (
              <a key={f.id} href={`/api/attachments/${f.id}/download`} className="card card-tap"
                style={{ display: 'flex', alignItems: 'center', gap: 10, padding: '10px 12px', background: 'var(--fill2)', boxShadow: 'none', textDecoration: 'none' }}>
                <FileIcon aria-hidden="true" style={{ width: 18, height: 18, flexShrink: 0, color: 'var(--label3)' }} />
                <span style={{ minWidth: 0, flex: 1, overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap', fontSize: 15 }}>{f.filename}</span>
                <span className="muted" style={{ fontSize: 12.5, flexShrink: 0 }}>{formatSize(f.size_bytes)}</span>
                <Download aria-hidden="true" style={{ width: 16, height: 16, flexShrink: 0, color: 'var(--blue)' }} />
              </a>
            ))}
          </div>
        ) : null}

        {/* СПИСОК ПУНКТОВ. Галочка сохраняется сразу, отдельно от «Сохранить»:
            человек стоит у полки и отмечает морковку, лишнее нажатие тут
            лишнее. Ответ сервера возвращает список целиком -- он короткий, и
            так не разъезжается с тем, что отметили в боте. */}
        {items.length > 0 ? (
          <div style={{ marginTop: 14 }}>
            <div className="sec-title" style={{ margin: '0 0 8px' }}>
              Список · отмечено {items.filter((i) => i.d).length} из {items.length}
            </div>
            <ul className="stack" style={{ gap: 6 }}>
              {items.map((item, i) => (
                <li key={`${item.t}-${i}`}>
                  <button type="button" className="card card-tap" disabled={busy}
                    style={{ display: 'flex', alignItems: 'center', gap: 10, padding: '10px 12px', width: '100%', textAlign: 'left', font: 'inherit', color: 'inherit' }}
                    onClick={async () => {
                      const before = items;
                      // Отмечаем сразу, ответ только подтверждает: иначе
                      // галочка «думает» полсекунды на каждый пункт.
                      setItems(items.map((x, j) => (j === i ? { ...x, d: x.d ? null : new Date().toISOString() } : x)));
                      try {
                        setItems((await toggleChecklistItem(task.id, i)).checklist);
                      } catch { setItems(before); toast('Не получилось отметить.'); }
                    }}>
                    <span aria-hidden="true" style={{ fontSize: 17, lineHeight: 1 }}>{item.d ? '✅' : '⬜️'}</span>
                    <span style={{ minWidth: 0, flex: 1, textDecoration: item.d ? 'line-through' : 'none', color: item.d ? 'var(--label3)' : 'inherit' }}>{item.t}</span>
                  </button>
                </li>
              ))}
            </ul>
          </div>
        ) : null}

        <div className="sec-title" style={{ margin: '16px 0 8px' }}>Файлы</div>
        <div className="btn-row" style={{ marginTop: 0 }}>
          <label className="btn" style={{ position: 'relative', overflow: 'hidden' }}>
            <Paperclip aria-hidden="true" style={{ width: 16, height: 16 }} />Прикрепить файл
            <input type="file" disabled={busy} aria-label="Прикрепить файл" style={{ position: 'absolute', inset: 0, opacity: 0, width: '100%', height: '100%' }}
              onChange={async (e) => { const f = e.target.files?.[0]; if (!f) return; await run(() => uploadAttachment(task.id, f), 'Файл приложен'); loadFiles(); e.target.value = ''; }} />
          </label>
        </div>

        {/* ПРАВКА -- та же форма, что при создании: тема, кому, содержание,
            важность, срок, в том же порядке. Раньше экран правки выглядел
            иначе, чем экран создания, и это приходилось заново разгадывать.
            Правки живут на устройстве и уходят одним запросом по «Сохранить»:
            сеть не дёргается на каждое нажатие. */}
        {canEdit ? (
          <div className="stack" style={{ marginTop: 18, gap: 12 }}>
            <div className="sec-title" style={{ margin: 0 }}>Изменить</div>

            <div className="field">
              <label className="lbl" htmlFor="t-title">Тема</label>
              <input id="t-title" className="inp" value={title} disabled={busy} onChange={(e) => setTitle(e.target.value)} />
            </div>

            {single ? (
              <div className="field">
                <label className="lbl" htmlFor="t-who">Кому</label>
                <select id="t-who" className="inp" value={who} disabled={busy} onChange={(e) => setWho(e.target.value)}>
                  {people.map((u) => <option key={u.id} value={u.id}>{u.id === me?.id ? 'Мне' : u.name}</option>)}
                </select>
              </div>
            ) : null}

            <div className="field">
              <label className="lbl" htmlFor="t-desc">Содержание</label>
              <textarea id="t-desc" className="inp" rows={3} value={desc} disabled={busy}
                placeholder="Подробности, если нужны" onChange={(e) => setDesc(e.target.value)} />
            </div>

            <div>
              <div className="sec-title" style={{ margin: '0 0 8px' }}>Важность</div>
              <div className="chips" style={{ paddingBottom: 0 }}>
                {PRIORITIES.map((p) => (
                  <button key={p.value} type="button" disabled={busy}
                    className={priority === p.value ? 'chip on' : 'chip'}
                    onClick={() => setPriority(p.value as Priority)}>{p.label}</button>
                ))}
              </div>
            </div>

            <div>
              {/* Повтор -- ряд чипов, а не выпадающий список: вариантов пять,
                  и все они помещаются в строку. */}
              <div className="sec-title" style={{ margin: '0 0 8px' }}>Повтор{repeat && !REPEAT_CHOICES.includes(repeat) ? `: ${repeatLabel(repeat).toLowerCase()}` : ''}</div>
              {/* В две строки, как и срок: в одну пять вариантов не влезают. */}
              <div className="chips" style={{ paddingBottom: 0, flexWrap: 'wrap', overflowX: 'visible' }}>
                {REPEAT_CHOICES.map((d) => (
                  <button key={d} type="button" disabled={busy}
                    className={repeat === d ? 'chip on' : 'chip'}
                    onClick={() => setRepeat(d)}>{repeatLabel(d || null)}</button>
                ))}
                <button type="button" disabled={busy}
                  className={repeat && !REPEAT_CHOICES.includes(repeat) ? 'chip on' : 'chip'}
                  onClick={() => setSheet('interval')}>Свой</button>
              </div>
            </div>

            <div>
              <div className="sec-title" style={{ margin: '0 0 8px' }}>Срок{deadline ? '' : ' не указан'}</div>
              <div className="chips" style={{ paddingBottom: 0, flexWrap: 'wrap', overflowX: 'visible' }}>
                <button type="button" className="chip" disabled={busy} onClick={() => setDeadline(inDays(0))}>Сегодня</button>
                <button type="button" className="chip" disabled={busy} onClick={() => setDeadline(inDays(1))}>Завтра</button>
                <button type="button" className="chip" disabled={busy} onClick={() => setDeadline(endOfWeek())}>В конце недели</button>
                {deadline ? <button type="button" className="chip" disabled={busy} onClick={() => setDeadline(null)}>Убрать</button> : null}
                {deadline ? (
                  <button type="button" className="chip" disabled={busy} onClick={() => setSheet('time')}>Время</button>
                ) : null}
                <label className="chip" style={{ position: 'relative', overflow: 'hidden' }}>
                  <CalendarDays aria-hidden="true" style={{ width: 14, height: 14 }} />
                  Дата
                  <input type="date" disabled={busy} value={deadline ? deadline.slice(0, 10) : ''}
                    onChange={(e) => { if (e.target.value) setDeadline(e.target.value); }}
                    style={{ position: 'absolute', inset: 0, opacity: 0, width: '100%', height: '100%' }} />
                </label>
              </div>
            </div>

            <button type="button" className="btn btn-primary" disabled={busy || !dirty || title.trim().length < 2}
              onClick={() => run(() => updateTask(task.id, {
                title: title.trim(),
                description: desc,
                ...(single && who && who !== (task.assignees ?? [])[0]?.user_id ? { responsible_user_id: who } : {}),
                deadline,
                priority,
                repeat_min: repeat || null,
              }), 'Сохранено')}>
              Сохранить
            </button>
          </div>
        ) : null}

        {sheet === 'interval' ? (
          <IntervalSheet value={repeat || null} onPick={setRepeat} onClose={() => setSheet(null)} />
        ) : null}
        {sheet === 'time' ? (
          <TimeSheet iso={deadline} onPick={setDeadline} onClose={() => setSheet(null)} />
        ) : null}

        {actions ? <div className="stack" style={{ gap: 8, marginTop: 20 }}>{actions}</div> : null}

        {/* Разрушительное -- последним и отдельно: по правилам шторок iOS. */}
        {canQuickEdit ? (
          <button type="button" className="btn btn-danger" style={{ marginTop: 28 }} disabled={busy} onClick={async () => { if (window.confirm(`Удалить «${task.title}»?`)) { await run(() => deleteTask(task.id), 'Удалено'); onClose(); } }}>
            <Trash2 aria-hidden="true" style={{ width: 16, height: 16 }} />Удалить задачу
          </button>
        ) : null}

      {/* Просмотр фото поверх шторки: свой слой, поэтому живёт рядом с ней. */}
      {lightboxIndex !== null ? (
        <Lightbox images={images} startIndex={lightboxIndex} onClose={() => setLightboxIndex(null)} />
      ) : null}
    </Sheet>
  );
}
