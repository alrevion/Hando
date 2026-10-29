import type { ReactNode } from 'react';
import { CalendarDays, Check, ChevronsDown, ChevronsUp, Equal, LayoutGrid, ListChecks, Play, Repeat, User as UserIcon } from 'lucide-react';
import type { Assignee, Priority, Task } from '../types';
import { formatDeadlineDays, isTaskOverdue } from '../lib/overdue';
import { PRIORITY_LABEL } from '../lib/priority';
import { checklistOf, repeatLabel } from '../lib/tasks';

/**
 * Признаки задачи метками: кто и где -- первой строкой, важность и срок --
 * второй.
 *
 * ДВЕ строки, а не одна: в одну они не влезают на телефоне и уезжают за край.
 * Порядок продиктован тем, как человек читает карточку: «Подготовить отчёт» ->
 * «отдел Задачи, делает Артур» -> «средняя, через два дня». Сначала кто и где,
 * потом насколько срочно.
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
  task, projectName, showProject, showStage = true, who, extra,
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
}) {
  const overdue = isTaskOverdue(task);
  const PriorityIcon = PRIORITY_ICON[task.priority];
  const items = checklistOf(task);
  const stage = showStage ? STAGE[task.status] : undefined;
  const StageIcon = stage?.icon;

  // Первая строка -- «где и кто», вторая -- «насколько срочно». Пустая строка
  // не рисуется вовсе: у задачи себе на личной доске первой строки нет.
  const first = (
    <>
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

      {stage && StageIcon ? (
        <span className={stage.tone}>
          <StageIcon aria-hidden="true" />
          <span>{stage.label}</span>
        </span>
      ) : null}
    </>
  );
  const hasFirst = (showProject && projectName) || (who ?? []).length > 0 || !!stage;

  return (
    <>
      {hasFirst ? <span className="pills">{first}</span> : null}
      <span className="pills">
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

        {/* Повтор и список -- признаки самой задачи, а не её состояния:
            по ним видно, что она вернётся и что внутри есть пункты. */}
        {task.repeat_min ? (
          <span className="pill"><Repeat aria-hidden="true" /><span>{repeatLabel(task.repeat_min).toLowerCase()}</span></span>
        ) : null}
        {items.length > 0 ? (
          <span className={items.every((i) => i.d) ? 'pill pill-green' : 'pill'}>
            <ListChecks aria-hidden="true" /><span>{items.filter((i) => i.d).length} из {items.length}</span>
          </span>
        ) : null}

        {extra}
      </span>
    </>
  );
}
