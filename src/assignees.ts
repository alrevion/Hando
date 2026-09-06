// Адресаты поручения и их автомат состояний (шаг 3 плана).
//
// До этого шага «кто делает» было колонкой tasks.responsible_user_id -- одно имя
// на задачу. Спека требует рассылку на 14 человек с 14 НЕЗАВИСИМЫМИ состояниями
// и 14 независимыми таймерами; колонкой это невыразимо.
//
// Статус самой задачи с этого шага -- СВЁРТКА состояний адресатов, а не
// самостоятельное поле. Свёртка идёт через applyTransition (transition.ts),
// чтобы инвариант «единственный писатель tasks.status» остался верным.
import type { Env, Task, TaskStatus } from './types';
import { nowIso, uuid } from './db';
import { applyTransition } from './transition';

export type AssigneeState = 'pending' | 'accepted' | 'done' | 'confirmed' | 'rejected' | 'declined';

export type Assignee = {
  id: string;
  task_id: string;
  user_id: string;
  org_id: string;
  state: AssigneeState;
  accepted_at: string | null;
  acknowledged_at: string | null;
  done_at: string | null;
  due_at: string | null;
  last_escalated_at: string | null;
  reminder_sent_at: string | null;
  review_reminded_at: string | null;
  declined_reason: string | null;
  created_at: string;
};

// ack -- «ознакомиться, а не выполнить»: приказ, расписание, объявление.
// Делать нечего, нужно знать, что прочитали.
export type TaskKind = 'single' | 'each' | 'any' | 'ack';

// Разрешённые переходы строки адресата.
//
// accepted -> declined разрешён НАМЕРЕННО («взялся и не смог»). Запрет оставлял
// бы человеку только rejected, который требует сначала done, то есть вынуждал бы
// врать про выполнение, чтобы отказаться.
// rejected -> ... : отклонённая автором работа возвращается в accepted, оттуда
// путь тот же, что и обычно.
const ALLOWED: Record<AssigneeState, AssigneeState[]> = {
  pending: ['accepted', 'declined'],
  accepted: ['done', 'declined'],
  done: ['confirmed', 'rejected'],
  confirmed: [],
  rejected: ['done', 'declined'],
  declined: [],
};

export function canTransition(from: AssigneeState, to: AssigneeState): boolean {
  return (ALLOWED[from] ?? []).includes(to);
}

/**
 * Сбрасывает ВСЕХ адресатов в исходное состояние -- «задача пришла заново».
 *
 * Правило владельца (2026-09-06): правка задачи -- это НОВАЯ задача, а не
 * изменённая старая, «так честнее по отношению ко всем». Азиз принимал ТУ
 * задачу, не эту: его «Принял» аннулируется вместе со всеми остальными.
 *
 * Гасятся и таймеры: у новой задачи новый срок, и он обязан получить
 * собственный цикл напоминаний, а не доедать предыдущий.
 *
 * Отказы тоже сбрасываются: отказ был от прежней формулировки. Иначе человек,
 * отказавшийся от «покрасить забор», не увидел бы «покрасить забор до пятницы,
 * краска оплачена».
 */
export function resetAssignees(env: Env, taskId: string, dueAt: string | null): D1PreparedStatement {
  return env.DB.prepare(
    `UPDATE task_assignees SET state = 'pending', accepted_at = NULL, acknowledged_at = NULL,
       done_at = NULL, declined_reason = NULL, due_at = ?,
       last_escalated_at = NULL, reminder_sent_at = NULL, review_reminded_at = NULL
     WHERE task_id = ?`,
  ).bind(dueAt, taskId);
}

/**
 * Отмечает работу принятой. Без этого состояние 'confirmed' недостижимо, и
 * строки навсегда остаются в 'done' -- из-за чего cron слал «пора проверить»
 * по задачам, которые автор уже принял.
 */
export function confirmAssignees(env: Env, taskId: string): D1PreparedStatement {
  return env.DB.prepare("UPDATE task_assignees SET state = 'confirmed' WHERE task_id = ? AND state = 'done'").bind(taskId);
}

/** Строки адресатов задачи. */
export async function loadAssignees(env: Env, taskId: string, orgId: string): Promise<Assignee[]> {
  const { results } = await env.DB.prepare('SELECT * FROM task_assignees WHERE task_id = ? AND org_id = ? ORDER BY created_at')
    .bind(taskId, orgId)
    .all<Assignee>();
  return results;
}

/** Моя строка в этой задаче. null -- я не адресат. */
export async function myAssignee(env: Env, taskId: string, userId: string, orgId: string): Promise<Assignee | null> {
  return env.DB.prepare('SELECT * FROM task_assignees WHERE task_id = ? AND user_id = ? AND org_id = ?')
    .bind(taskId, userId, orgId)
    .first<Assignee>();
}

/** Операторы вставки адресатов -- отдаются вызывающему, чтобы лечь в его batch. */
export function buildAssignees(env: Env, task: { id: string; org_id: string }, userIds: string[], dueAt: string | null) {
  return userIds.map((userId) =>
    env.DB.prepare(
      'INSERT INTO task_assignees (id, task_id, user_id, org_id, state, due_at) VALUES (?, ?, ?, ?, ?, ?)',
    ).bind(uuid(), task.id, userId, task.org_id, 'pending', dueAt),
  );
}

/**
 * Свёртка состояний адресатов в статус задачи.
 *
 * Правила по видам:
 *   single -- один адресат, статус повторяет его состояние;
 *   each   -- задача закрыта, когда закрыты ВСЕ неотказавшиеся;
 *   any    -- достаточно одного закрывшего.
 *
 * ПУСТОЙ КВОРУМ ⇒ archived, а не done. Если отказались все, «все неотказавшиеся
 * закрыты» истинно вакуумно -- и задача, которую никто не сделал, закрылась бы
 * как выполненная. Это дефект, найденный при разборе ADR-3, и он исправляется
 * здесь явной проверкой.
 */
export function rollup(kind: TaskKind, states: AssigneeState[]): TaskStatus {
  if (states.length === 0) return 'archived';
  const live = states.filter((s) => s !== 'declined');
  if (live.length === 0) return 'archived'; // отказались все -- см. комментарий выше

  // Для 'ack' «принял» И ЕСТЬ закрытие: человека просили прочитать, он прочитал.
  // Требовать от него ещё и «Готово» значило бы заставлять отчитываться о работе,
  // которой не было.
  const closed = (s: AssigneeState) =>
    s === 'done' || s === 'confirmed' || (kind === 'ack' && s === 'accepted');
  if (kind === 'any') {
    if (live.some(closed)) return 'done';
  } else if (live.every(closed)) {
    return 'done';
  }
  // Хоть кто-то взялся -- задача в работе. Иначе она ещё никем не принята.
  return live.some((s) => s === 'accepted' || s === 'rejected' || closed(s)) ? 'in_progress' : 'todo';
}

/**
 * Переводит строку адресата и пересчитывает статус задачи одним проходом.
 * Уведомление -- следствие перехода, идёт в outbox через applyTransition.
 */
export async function transitionAssignee(
  env: Env,
  opts: {
    task: Task;
    assignee: Assignee;
    to: AssigneeState;
    actorId: string;
    reason?: string | null;
    /** Новый персональный срок (reject задаёт его). */
    dueAt?: string | null;
    notify?: { emoji: string; label: string; extraLine?: string; track?: boolean; deletePrevious?: boolean };
  },
): Promise<{ ok: true } | { ok: false; error: string }> {
  const { task, assignee, to, actorId, reason, dueAt, notify } = opts;
  if (!canTransition(assignee.state, to)) {
    return { ok: false, error: `invalid transition ${assignee.state} -> ${to}` };
  }
  const now = nowIso();

  // Поля строки адресата по целевому состоянию. Таймеры гасятся на reject --
  // новый срок обязан получить собственный цикл напоминаний, иначе он проживёт
  // без единого предупреждения.
  const sets: string[] = ['state = ?'];
  const vals: unknown[] = [to];
  if (to === 'accepted' && assignee.accepted_at === null) { sets.push('accepted_at = ?'); vals.push(now); }
  if (to === 'done') { sets.push('done_at = ?'); vals.push(now); }
  if (to === 'declined') { sets.push('declined_reason = ?'); vals.push(reason ?? null); }
  if (to === 'rejected') {
    sets.push('done_at = NULL', 'last_escalated_at = NULL', 'reminder_sent_at = NULL', 'review_reminded_at = NULL');
    if (dueAt !== undefined) { sets.push('due_at = ?'); vals.push(dueAt); }
  }
  // ОДИН batch, а не два .run(): ADR-1 требует этого именно потому, что
  // «двойная запись двумя отдельными .run() при вытеснении изолята оставляет
  // представления расходящимися». Здесь расходились бы состояние строки и
  // журнал: строка переведена, события нет.
  //
  // Пересчёт статуса задачи ниже -- третья запись, и своим batch'ем она
  // накрыта, но с этой парой в одну транзакцию не сводится: rollup обязан
  // ПРОЧИТАТЬ уже обновлённые строки, а чтение внутри batch увидело бы старые.
  // Разрыв назван явно: при вытеснении между ними строка адресата верна, а
  // tasks.status отстаёт до следующего действия по этой задаче.
  await env.DB.batch([
    env.DB.prepare(`UPDATE task_assignees SET ${sets.join(', ')} WHERE id = ?`).bind(...vals, assignee.id),
    // Событие по САМОЙ строке адресата: журнал обязан различать «Пётр отказался»
    // и «задача отклонена». target_type='assignee' добавлен пересборкой 2b.
    env.DB.prepare(
      `INSERT INTO events (id, actor_id, org_id, target_type, target_id, action, comment, overdue_by, created_at)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)`,
    ).bind(uuid(), actorId, task.org_id, 'assignee', assignee.id, to, reason ?? null, null, now),
  ]);

  // В журнал уходит ДВА события, и это не дубль: строка адресата пишет своё
  // состояние ('accepted', 'declined'), задача -- свой переход ('moved_done').
  // Слои разные: «Пётр отказался» и «задача закрыта» -- разные факты, и после
  // рассылки на 14 человек первое случается 14 раз, а второе один.
  await recomputeTaskStatus(env, task, actorId, notify);
  return { ok: true };
}

/** Пересчитывает статус задачи по её адресатам и применяет переход, если он нужен. */
export async function recomputeTaskStatus(
  env: Env,
  task: Task,
  actorId: string | null,
  notify?: { emoji: string; label: string; extraLine?: string; track?: boolean; deletePrevious?: boolean },
): Promise<void> {
  const rows = await loadAssignees(env, task.id, task.org_id);
  const next = rollup((task.kind ?? 'single') as TaskKind, rows.map((r) => r.state));

  // Статус не изменился -- значит переход задачи не состоялся. Уведомление всё
  // равно отправляем: человеку важно «Пётр принял», даже если доска не сдвинулась.
  const changed = next !== task.status;
  if (!changed && !notify) return;

  await applyTransition(env, {
    task,
    to: next,
    actorId,
    // Действие описывает переход ЗАДАЧИ, а не состояние строки: словарь журнала
    // остаётся прежним ('moved_in_progress'/'moved_done'), и отчёты, написанные
    // до шага 3, продолжают читаться.
    action: changed ? `moved_${next}` : 'assignee_changed',
    // Задача закрылась -- гасим отслеживаемое сообщение: иначе cron позже
    // попытается удалить чужой message_id, а само сообщение «🚀 В работе»
    // останется висеть под уже готовой задачей.
    set: next === 'done'
      ? { done_at: task.done_at ?? nowIso(), telegram_message_id: null }
      : undefined,
    notify,
  });
}
