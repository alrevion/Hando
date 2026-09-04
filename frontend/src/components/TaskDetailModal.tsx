import { useState } from 'react';
import { AlertTriangle, CalendarDays, Download, File as FileIcon, User as UserIcon, X } from 'lucide-react';
import type { ContentBlock, Task, User } from '../types';
import { parseContentBlocks } from '../types';
import { userBadgeColor } from '../lib/badgeColor';
import { PRIORITY_DOT, PRIORITY_LABEL } from '../lib/priority';
import { formatDeadlineDays, isReviewOverdue, isTaskOverdue } from '../lib/overdue';
import { Lightbox } from './Lightbox';

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
  responsible: User | undefined;
  onClose: () => void;
}

function formatDeadline(deadline: string) {
  const d = new Date(deadline);
  if (Number.isNaN(d.getTime())) return deadline;
  return d.toLocaleDateString();
}

// Read-only view of the canvas a truncated card can't show: full text plus
// every inline photo, loaded eagerly (not on click-to-download like before).
// Clicking a photo opens the fullscreen Lightbox with left/right nav across
// every photo in this task.
export function TaskDetailModal({ task, responsible, onClose }: TaskDetailModalProps) {
  const [lightboxIndex, setLightboxIndex] = useState<number | null>(null);
  const isOverdue = isTaskOverdue(task);
  const reviewOverdue = isReviewOverdue(task);
  const blocks = parseContentBlocks(task);
  const groups = groupBlocks(blocks);
  const images = blocks
    .filter((b): b is Extract<ContentBlock, { type: 'image' }> => b.type === 'image')
    .map((b) => ({ src: `/api/attachments/${b.attachment_id}/download`, alt: task.title }));

  return (
    <div className="fixed inset-0 z-20 flex items-center justify-center bg-slate-900/40 p-4" onClick={onClose}>
      <div
        role="dialog"
        aria-modal="true"
        aria-labelledby="task-detail-title"
        className="max-h-[85vh] w-full max-w-md overflow-y-auto rounded-lg bg-white p-6 shadow-lg"
        onClick={(e) => e.stopPropagation()}
      >
        <div className="mb-3 flex items-start justify-between gap-2">
          <h2 id="task-detail-title" className="text-lg font-semibold text-slate-900">
            {task.title}
          </h2>
          <button
            type="button"
            onClick={onClose}
            aria-label="Close"
            className="shrink-0 rounded p-1 text-slate-500 hover:bg-slate-100"
          >
            <X className="h-4 w-4" aria-hidden="true" />
          </button>
        </div>

        <div className="mb-4 flex flex-wrap items-center gap-2">
          <span className="inline-flex items-center gap-1.5 rounded-full bg-slate-100 px-2.5 py-1 text-xs font-medium text-slate-700">
            <span className={`h-2 w-2 rounded-full ${PRIORITY_DOT[task.priority]}`} aria-hidden="true" />
            {PRIORITY_LABEL[task.priority]}
          </span>
          <span
            className={`inline-flex items-center gap-1 rounded-full px-2.5 py-1 text-xs font-medium ${userBadgeColor(task.responsible_user_id)}`}
          >
            <UserIcon className="h-3.5 w-3.5" aria-hidden="true" />
            {responsible ? responsible.name : 'Unassigned'}
          </span>
          {task.deadline ? (
            <span
              className={`inline-flex items-center gap-1 rounded-full px-2.5 py-1 text-xs font-medium ${
                isOverdue ? 'bg-red-50 text-red-700' : 'bg-slate-100 text-slate-700'
              }`}
            >
              {isOverdue ? <AlertTriangle className="h-3.5 w-3.5" aria-hidden="true" /> : <CalendarDays className="h-3.5 w-3.5" aria-hidden="true" />}
              {formatDeadline(task.deadline)} · {formatDeadlineDays(task.deadline)}
            </span>
          ) : null}
          {reviewOverdue ? (
            <span
              className="inline-flex items-center gap-1 rounded-full bg-red-50 px-2.5 py-1 text-xs font-medium text-red-700"
              title="Done for 2+ days without being reviewed"
            >
              <AlertTriangle className="h-3.5 w-3.5" aria-hidden="true" />
              Review overdue
            </span>
          ) : null}
        </div>

        {blocks.length === 0 ? <p className="text-sm text-slate-400">No content.</p> : null}

        <div className="flex flex-col gap-3">
          {(() => {
            let imgCursor = 0;
            return groups.map((group, gi) => {
              if (group.kind === 'text') {
                return group.block.text ? (
                  <p key={gi} className="whitespace-pre-wrap text-sm text-slate-700">
                    {group.block.text}
                  </p>
                ) : null;
              }
              if (group.kind === 'images') {
                return (
                  <div key={gi} className="flex flex-wrap gap-2">
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
                          className="h-32 w-32 cursor-zoom-in rounded-md object-cover sm:h-40 sm:w-40"
                        />
                      );
                    })}
                  </div>
                );
              }
              return (
                <div key={gi} className="flex flex-col gap-1">
                  {group.blocks.map((block) => (
                    <a
                      key={block.attachment_id}
                      href={`/api/attachments/${block.attachment_id}/download`}
                      className="flex items-center gap-2 rounded-md border border-slate-200 px-2 py-1.5 text-sm text-blue-700 hover:bg-slate-50"
                    >
                      <FileIcon className="h-4 w-4 shrink-0 text-slate-400" aria-hidden="true" />
                      <span className="min-w-0 flex-1 truncate">{block.filename}</span>
                      <span className="shrink-0 text-xs text-slate-400">{formatSize(block.size_bytes)}</span>
                      <Download className="h-3.5 w-3.5 shrink-0" aria-hidden="true" />
                    </a>
                  ))}
                </div>
              );
            });
          })()}
        </div>
      </div>

      {lightboxIndex !== null ? (
        <Lightbox images={images} startIndex={lightboxIndex} onClose={() => setLightboxIndex(null)} />
      ) : null}
    </div>
  );
}
