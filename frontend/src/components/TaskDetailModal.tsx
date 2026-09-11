import { useEffect, useState, type ReactNode } from 'react';
import { Sheet } from './Sheet';
import { AlertTriangle, CalendarDays, Download, File as FileIcon, Paperclip, Pencil, Trash2, X } from 'lucide-react';
import type { ContentBlock, Task, User } from '../types';
import { parseContentBlocks } from '../types';
import { PRIORITY_DOT, PRIORITY_LABEL } from '../lib/priority';
import { formatDeadlineDays, isReviewOverdue, isTaskOverdue } from '../lib/overdue';
import { Lightbox } from './Lightbox';
import { STATE_PILL, stateLabel } from '../lib/tasks';
import { QuickEdit } from './QuickEdit';
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
  const { refresh, tasks: live } = useData();
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
  const [editing, setEditing] = useState(false);
  const [title, setTitle] = useState(task.title);
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

  return (
    <Sheet labelledBy="task-detail-title" onClose={onClose}>
        <div className="sheet-head">
          {editing ? (
            <form className="grow t-row" style={{ gap: 6 }} onSubmit={async (e) => { e.preventDefault(); if (title.trim() && title.trim() !== task.title) await run(() => updateTask(task.id, { title: title.trim() }), 'Тема изменена'); setEditing(false); }}>
              <input className="inp grow" autoFocus value={title} aria-label="Тема" onChange={(e) => setTitle(e.target.value)} />
              <button type="submit" className="btn btn-sm btn-primary" disabled={busy}>Ок</button>
            </form>
          ) : <h2 id="task-detail-title" className="sheet-title">{task.title}</h2>}
          {/* Тема правится в todo; в работе -- только владельцем, и это возврат в todo (routes PATCH /tasks/:id). */}
          {canQuickEdit && !editing && (task.status === 'todo' || (task.status === 'in_progress' && me?.role !== 'member' && me?.role !== 'admin')) ? (
            <button type="button" onClick={() => setEditing(true)} aria-label="Изменить тему" className="btn-icon"><Pencil aria-hidden="true" /></button>
          ) : null}
          <button type="button" onClick={onClose} aria-label="Закрыть" className="btn-icon">
            <X aria-hidden="true" />
          </button>
        </div>

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

        <div className="btn-row" style={{ marginTop: 14 }}>
          <label className="btn" style={{ position: 'relative', overflow: 'hidden' }}>
            <Paperclip aria-hidden="true" style={{ width: 16, height: 16 }} />Прикрепить файл
            <input type="file" disabled={busy} aria-label="Прикрепить файл" style={{ position: 'absolute', inset: 0, opacity: 0, width: '100%', height: '100%' }}
              onChange={async (e) => { const f = e.target.files?.[0]; if (!f) return; await run(() => uploadAttachment(task.id, f), 'Файл приложен'); loadFiles(); e.target.value = ''; }} />
          </label>
        </div>

        {canQuickEdit ? <div style={{ marginTop: 18 }}><QuickEdit task={task} /></div> : null}

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
