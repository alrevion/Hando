import type { MouseEvent } from 'react';
import { AlertTriangle, ArrowRight, Check, CheckCircle2, X } from 'lucide-react';
import type { Task, User } from '../types';

import { isReviewOverdue, isTaskOverdue } from '../lib/overdue';
import { assigneeLabel, isMine } from '../lib/tasks';
import { TaskMeta } from './TaskMeta';

interface TaskCardProps {
  task: Task;
  responsible: User | undefined;
  canManage: boolean; // super_admin/creator
  currentUserId: string;
  // Title of the predecessor task, when it's not done/archived yet -- blocks
  // the advance action (see routes.ts POST /tasks/:id/move).
  blockedByTitle?: string;
  onAdvance: () => void;
  onConfirm: () => void;
  onReject: () => void;
  onView: () => void;
  busy: boolean;
}

const ADVANCE_LABEL: Partial<Record<Task['status'], string>> = {
  todo: 'Взять в работу',
  in_progress: 'Сдать',
};

// Карточка одной высоты: заголовок и описание в одну строку с многоточием,
// чтобы колонка читалась ровной лентой. Полный текст и вложения -- в шторке
// (onView), не здесь.
export function TaskCard({
  task,
  responsible,
  canManage,
  currentUserId,
  blockedByTitle,
  onAdvance,
  onConfirm,
  onReject,
  onView,
  busy,
}: TaskCardProps) {
  // Двигает карточку только тот, кто делает -- без исключений для ролей
  // (routes.ts POST /tasks/:id/move). Стрелка «заблокировано» тоже только ему:
  // постороннему не показываем ни действие, ни его недоступность.
  // «Моя ли это задача» -- есть ли моя строка среди адресатов. У рассылки их
  // много, и сравнение с одним человеком тут больше не работает.
  const isResponsible = isMine(task, currentUserId);
  const canMove = isResponsible && !blockedByTitle;
  const advanceLabel = !isResponsible
    ? undefined
    : canMove
      ? ADVANCE_LABEL[task.status]
      : blockedByTitle && task.status === 'todo'
        ? `Ждёт задачу «${blockedByTitle}»`
        : undefined;
  const isOverdue = isTaskOverdue(task);
  const reviewOverdue = isReviewOverdue(task);
  const who = task.assignees?.length ? assigneeLabel(task) : responsible?.name ?? 'без адресата';

  function stop(fn: () => void) {
    return (e: MouseEvent) => {
      e.stopPropagation();
      fn();
    };
  }

  return (
    <div onClick={onView} className={`card card-tap${isOverdue ? ' is-overdue' : ''}`}>
      <div className="t-row" style={{ alignItems: 'center' }}>
        <div className="grow">
          <span className="t-title">{task.title}</span>
          {task.description ? <span className="t-meta"><span>{task.description}</span></span> : null}
        </div>
        {advanceLabel ? (
          <button
            type="button"
            onClick={canMove ? stop(onAdvance) : stop(() => {})}
            disabled={busy || !canMove}
            title={advanceLabel}
            aria-label={advanceLabel}
            className={canMove ? 'btn-icon is-accent' : 'btn-icon'}
          >
            <ArrowRight aria-hidden="true" />
          </button>
        ) : null}
      </div>

      <TaskMeta
        task={task}
        who={[{ name: who }]}
        showStage={false}
        line
        extra={reviewOverdue ? (
          <span className="pill pill-orange" title="Сдано больше двух дней назад и не проверено">
            <AlertTriangle aria-hidden="true" />
            <span>Ждёт проверки</span>
          </span>
        ) : task.status === 'done' && task.confirmed_at ? (
          <span className="pill pill-green">
            <CheckCircle2 aria-hidden="true" />
            <span>Принято</span>
          </span>
        ) : null}
      />

      {task.status === 'done' && canManage && !task.confirmed_at ? (
        <div className="btn-row" style={{ marginTop: 12 }}>
          <button type="button" onClick={stop(onConfirm)} disabled={busy} className="btn btn-sm btn-primary">
            <Check aria-hidden="true" style={{ width: 14, height: 14 }} />
            Принять
          </button>
          <button type="button" onClick={stop(onReject)} disabled={busy} className="btn btn-sm">
            <X aria-hidden="true" style={{ width: 14, height: 14 }} />
            Вернуть
          </button>
        </div>
      ) : null}
    </div>
  );
}
