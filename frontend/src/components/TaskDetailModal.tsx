import { useState, type ReactNode } from 'react';
import { Sheet } from './Sheet';
import { AlertTriangle, CalendarDays, Download, File as FileIcon, X } from 'lucide-react';
import type { ContentBlock, Task, User } from '../types';
import { parseContentBlocks } from '../types';
import { PRIORITY_DOT, PRIORITY_LABEL } from '../lib/priority';
import { formatDeadlineDays, isReviewOverdue, isTaskOverdue } from '../lib/overdue';
import { Lightbox } from './Lightbox';
import { STATE_PILL, stateLabel } from '../lib/tasks';

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
export function TaskDetailModal({ task, responsible, onClose, actions }: TaskDetailModalProps) {
  const [lightboxIndex, setLightboxIndex] = useState<number | null>(null);
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
          <h2 id="task-detail-title" className="sheet-title">{task.title}</h2>
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

        {actions ? <div className="stack" style={{ gap: 8, marginTop: 20 }}>{actions}</div> : null}

      {/* Просмотр фото поверх шторки: свой слой, поэтому живёт рядом с ней. */}
      {lightboxIndex !== null ? (
        <Lightbox images={images} startIndex={lightboxIndex} onClose={() => setLightboxIndex(null)} />
      ) : null}
    </Sheet>
  );
}
