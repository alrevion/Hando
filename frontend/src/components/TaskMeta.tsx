import type { ReactNode } from 'react';
import { CalendarDays, Check, ChevronsDown, ChevronsUp, Equal, LayoutGrid, Play, User as UserIcon } from 'lucide-react';
import type { Assignee, Priority, Task } from '../types';
import { formatDeadlineDays, isTaskOverdue } from '../lib/overdue';
import { PRIORITY_LABEL } from '../lib/priority';

/**
 * Признаки задачи одной строкой: срочность, срок, этап, доска, адресаты.
 *
 * Всё метками с иконкой слева, а не точками и текстом через точку-разделитель:
 * точка цветом кодирует смысл, и человек обязан помнить, что оранжевая --
 * «средне». Метка называет вещь словом, а иконка даёт зацепку глазу.
 *
 * Доска показывается ТОЛЬКО когда их больше одной: пока доска одна, «Задачи»
 * на каждой карточке -- чистый шум, повторённый столько раз, сколько задач.
 */

const PRIORITY_ICON: Record<Priority, typeof ChevronsUp> = {
  urgent: ChevronsUp,
  medium: Equal,
  low: ChevronsDown,
};

const PRIORITY_TONE: Record<Priority, string> = {
  urgent: 'pill pill-red',
  medium: 'pill pill-orange',
  low: 'pill',
};

const STAGE: Partial<Record<Task['status'], { label: string; tone: string; icon: typeof Play }>> = {
  in_progress: { label: 'В работе', tone: 'pill pill-blue', icon: Play },
  done: { label: 'На проверке', tone: 'pill pill-green', icon: Check },
};

/** Тон метки по состоянию адресата -- тот же словарь, что в поручениях. */
const STATE_TONE: Record<Assignee['state'], string> = {
  pending: 'pill',
  accepted: 'pill pill-blue',
  done: 'pill pill-green',
  confirmed: 'pill pill-green',
  rejected: 'pill pill-orange',
  declined: 'pill pill-red',
};

export function TaskMeta({
  task, projectName, showProject, showStage = true, who, extra, line,
}: {
  task: Task;
  projectName?: string;
  /** Доска называется, только если их несколько. */
  showProject?: boolean;
  showStage?: boolean;
  /** Кого показать: строки адресатов или одно имя. Пусто -- никого. */
  who?: { name: string; state?: Assignee['state'] }[];
  /** Дополнительные метки экрана (например «Ждёт задачу»). */
  extra?: ReactNode;
  /** Одной строкой без переноса -- для плотных списков. */
  line?: boolean;
}) {
  const overdue = isTaskOverdue(task);
  const PriorityIcon = PRIORITY_ICON[task.priority];
  const stage = showStage ? STAGE[task.status] : undefined;
  const StageIcon = stage?.icon;

  return (
    <span className={line ? 'pills pills-line' : 'pills'}>
      <span className={PRIORITY_TONE[task.priority]}>
        <PriorityIcon aria-hidden="true" />
        <span>{PRIORITY_LABEL[task.priority]}</span>
      </span>

      {task.deadline ? (
        <span className={overdue ? 'pill pill-red' : 'pill'}>
          <CalendarDays aria-hidden="true" />
          <span>{formatDeadlineDays(task.deadline)}</span>
        </span>
      ) : null}

      {stage && StageIcon ? (
        <span className={stage.tone}>
          <StageIcon aria-hidden="true" />
          <span>{stage.label}</span>
        </span>
      ) : null}

      {showProject && projectName ? (
        <span className="pill">
          <LayoutGrid aria-hidden="true" />
          <span>{projectName}</span>
        </span>
      ) : null}

      {(who ?? []).map((w) => (
        <span key={w.name} className={w.state ? STATE_TONE[w.state] : 'pill'}>
          <UserIcon aria-hidden="true" />
          <span>{w.name}</span>
        </span>
      ))}

      {extra}
    </span>
  );
}
