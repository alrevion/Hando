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
import { applyTransition, assigneeButtons, buildNotification, describeOverdue } from './transition';
import type { InlineButton } from './telegram';
import { assignableMembers } from './hierarchy';
import { membershipRole } from './auth';

export type AssigneeState = 'pending' | 'accepted' | 'done' | 'confirmed' | 'rejected' | 'declined';

export type Assignee = {
  id: string;
  task_id: string;
  user_id: string;
  org_id: string;
  state: AssigneeState;
  accepted_at: string | null;
  /**
   * Когда человек СЕЛ ЗА РАБОТУ. Отдельно от accepted_at: «принял» -- это
   * согласие, а не начало, и автор про разницу спрашивал прямо. Отметкой
   * времени, а не состоянием: state закрыт CHECK'ом, и его правка в SQLite --
   * пересборка таблицы. NULL при accepted -- «принято»; дата -- «в работе».
   */
  started_at: string | null;
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
export function resetAssignees(env: Env, taskId: string, dueAt: string | null): D1PreparedStatement[] {
  return [
    env.DB.prepare(
      `UPDATE task_assignees SET state = 'pending', accepted_at = NULL, acknowledged_at = NULL,
         done_at = NULL, declined_reason = NULL, due_at = ?,
         last_escalated_at = NULL, reminder_sent_at = NULL, review_reminded_at = NULL
       WHERE task_id = ?`,
    ).bind(dueAt, taskId),
    // Журнал напоминаний -- тоже с нуля: разовые «за час», «в срок» иначе
    // считались бы уже отправленными, и новый срок прошёл бы без предупреждения.
    clearReminders(env, taskId),
  ];
}

/**
 * Отмечает работу принятой. Без этого состояние 'confirmed' недостижимо, и
 * строки навсегда остаются в 'done' -- из-за чего cron слал «пора проверить»
 * по задачам, которые автор уже принял.
 */
export function confirmAssignees(env: Env, taskId: string): D1PreparedStatement {
  return env.DB.prepare("UPDATE task_assignees SET state = 'confirmed' WHERE task_id = ? AND state = 'done'").bind(taskId);
}

/**
 * Повторяющаяся задача заводит СЛЕДУЮЩИЙ заход -- в момент, когда закрыли
 * предыдущий.
 *
 * По часам, а не по закрытию, делать нельзя: невыполненная задача плодила бы
 * копии сама себя, и к пятнице «полить цветы» висело бы пять раз. Закрытие --
 * единственный момент, когда точно известно, что круг пройден.
 *
 * Срок нового захода считается от СТАРОГО срока, а не от «сейчас»: полив через
 * день остаётся через день, даже если вчерашний полив подтвердили только
 * сегодня вечером. Если старый срок уже далеко позади (задачу закрыли сильно
 * позже), отсчёт идёт от текущего момента -- иначе новая задача родилась бы
 * просроченной.
 */
/** Повтор «каждый месяц» в минутах: 30 суток. Им помечен КАЛЕНДАРНЫЙ месяц. */
export const MONTH_MIN = 30 * 1440;

/**
 * Срок следующего захода.
 *
 * Месяц -- КАЛЕНДАРНЫЙ, а не «плюс 30 суток». «Каждого 18 числа» при шаге в 30
 * суток уползало бы с 18-го: за год на пять дней раньше. Поэтому ровно
 * MONTH_MIN читается как «то же число следующего месяца». Число, которого в
 * месяце нет (31-е в сентябре), прижимается к последнему дню месяца, а не
 * переезжает на 1 октября.
 *
 * Если старый срок далеко позади, отсчёт идёт от «сейчас» -- иначе новый заход
 * родился бы просроченным. Шагаем, пока не окажемся в будущем.
 */
export function nextRound(fromMs: number, minutes: number, nowMs: number): Date {
  const step = (ms: number): number => {
    if (minutes !== MONTH_MIN) return ms + minutes * 60_000;
    const d = new Date(ms);
    const day = d.getUTCDate();
    d.setUTCDate(1);
    d.setUTCMonth(d.getUTCMonth() + 1);
    const last = new Date(Date.UTC(d.getUTCFullYear(), d.getUTCMonth() + 1, 0)).getUTCDate();
    d.setUTCDate(Math.min(day, last));
    return d.getTime();
  };
  let at = step(fromMs);
  // Потолок -- страховка от бесконечного цикла на испорченной строке.
  for (let i = 0; at <= nowMs && i < 1000; i++) at = step(at);
  return new Date(at);
}

async function respawnRepeating(env: Env, task: Task, actorId: string): Promise<void> {
  const minutes = task.repeat_min;
  if (!minutes || minutes < 1) return;
  const from = task.deadline ? Date.parse(task.deadline) : Date.now();
  const deadline = nextRound(from, minutes, Date.now()).toISOString();

  // Кто делал, тот и делает дальше: список адресатов копируется как есть, без
  // отказавшихся -- они уже сказали, что этим не занимаются.
  const { results: live } = await env.DB.prepare(
    "SELECT user_id, state FROM task_assignees WHERE task_id = ? AND org_id = ? AND state <> 'declined'",
  ).bind(task.id, task.org_id).all<{ user_id: string; state: AssigneeState }>();
  if (live.length === 0) return;
  // СОГЛАСИЕ ПЕРЕХОДИТ НА СЛЕДУЮЩИЙ КРУГ. «Поливать цветы через день» принимают
  // один раз, а не через день: иначе каждый круг снова просил «✅ Принять» и
  // раз в час напоминал «не принято» о деле, на которое человек уже подписался.
  // Кто на прошлом круге так и не согласился (в «кто первый» закрыл другой) --
  // решает заново.
  const agreed = new Set(live.filter((a) => a.state !== 'pending').map((a) => a.user_id));

  const id = uuid();
  const fresh = await env.DB.prepare('SELECT * FROM tasks WHERE id = ?').bind(task.id).first<Task>() ?? task;
  await env.DB.batch([
    env.DB.prepare(
      `INSERT INTO tasks (id, org_id, project_id, title, description, repeat_min, checklist, author_id, kind, source, status, priority, deadline)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, 'repeat', ?, ?, ?)`,
    ).bind(id, fresh.org_id, fresh.project_id, fresh.title, fresh.description ?? '', minutes,
      // Галочки сбрасываются: список покупок на следующую неделю пустой.
      resetChecklist(fresh.checklist), fresh.author_id, fresh.kind,
      initialStatus(fresh.kind as TaskKind, live.map((a) => a.user_id), fresh.author_id, agreed), fresh.priority, deadline),
    env.DB.prepare(
      `INSERT INTO events (id, actor_id, org_id, target_type, target_id, action, comment, overdue_by, created_at)
       VALUES (?, ?, ?, 'task', ?, 'created', 'повтор', NULL, ?)`,
    ).bind(uuid(), actorId, fresh.org_id, id, nowIso()),
    ...buildAssignees(env, { id, org_id: fresh.org_id, kind: fresh.kind }, live.map((a) => a.user_id), deadline, fresh.author_id, agreed),
  ]);

  // Карточка новому кругу -- каждому, кроме того, кто её сам и закрыл.
  const writes: D1PreparedStatement[] = [];
  const nextTask = { ...fresh, id, deadline, telegram_message_id: null } as Task;
  for (const a of live) {
    if (a.user_id === actorId) continue;
    writes.push(await buildNotification(env, nextTask, 'created',
      { emoji: '🔁', label: 'Снова по кругу', buttons: assigneeButtons(nextTask, a.user_id, agreed.has(a.user_id)) },
      deadline, a.user_id, actorId));
  }
  if (writes.length) await env.DB.batch(writes);
}

/** Новый круг начинается с чистых галочек. */
function resetChecklist(raw: string | null): string | null {
  if (!raw) return null;
  try {
    const v = JSON.parse(raw) as { t: string }[];
    return Array.isArray(v) ? JSON.stringify(v.map((x) => ({ t: x.t, d: null }))) : null;
  } catch { return null; }
}

/**
 * Приёмка работы -- ОДНА дорога для приложения и для кнопки «✔️ Принять» под
 * поводом в боте. Кнопка раньше писала confirmed_at напрямую: строки адресатов
 * оставались в 'done', события в журнале не было, а исполнитель не узнавал, что
 * работу приняли, -- сообщение «✔️ Подтверждено» рождается здесь.
 */
export async function confirmWork(env: Env, task: Task, actorId: string, notify = true): Promise<number | null> {
  let overdueBy: number | null = null;
  if (task.deadline && task.done_at) {
    const late = Math.floor((Date.parse(task.done_at) - Date.parse(task.deadline)) / 1000);
    overdueBy = late > 0 ? late : 0;
  }
  await env.DB.batch([confirmAssignees(env, task.id)]);
  // Статус не меняется: подтверждение живёт в confirmed_at. Но это переход
  // жизненного цикла, и идти он обязан тем же путём.
  await applyTransition(env, {
    task, to: task.status, actorId, action: 'confirmed', overdueBy,
    set: { confirmed_at: nowIso() },
    // Молча -- когда человек закрывает СВОЮ задачу: письмо самому себе о том,
    // что ты только что сделал, -- шум.
    notify: notify
      ? { emoji: '✔️', label: 'Подтверждено', extraLine: overdueBy == null ? undefined : describeOverdue(overdueBy) }
      : undefined,
  });
  await respawnRepeating(env, task, actorId);
  return overdueBy;
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
/**
 * С чего начинается строка адресата. Поручил САМ СЕБЕ -- строка рождается
 * принятой: принимать своё незачем, человек только что сам это и продиктовал.
 *
 * Раньше такая строка рождалась «не принято», и отсюда тянулась цепочка:
 * напоминание раз в час «примите» (для задачи себе его текст пришлось
 * переписывать в «Ещё не начато»), кнопка «Принять» у своей же задачи и
 * «🚀 Принято, кто: Яков» -- автору о нём самом. Лечить надо было не текст, а
 * начальное состояние: у принятой строки нет ни повода для напоминания, ни
 * перехода, о котором извещать.
 *
 * Правило построчное: в «мне и Азизу» принята только своя строка, Азиз
 * принимает сам.
 *
 * Рассылка «ознакомиться» (ack) -- исключение: там принятие и есть закрытие, и
 * родиться принятой значило бы родиться закрытой.
 */
export function initialState(
  userId: string, authorId: string | null | undefined, kind: TaskKind,
  /** Кто уже согласился на прошлом круге повтора (respawnRepeating). */
  agreed?: ReadonlySet<string>,
): AssigneeState {
  if (kind === 'ack') return 'pending';
  return (authorId && userId === authorId) || agreed?.has(userId) ? 'accepted' : 'pending';
}

/** Статус новой задачи -- свёртка начальных строк, а не константа 'todo'. */
export function initialStatus(kind: TaskKind, userIds: string[], authorId: string | null | undefined, agreed?: ReadonlySet<string>): TaskStatus {
  return rollup(kind, userIds.map((u) => initialState(u, authorId, kind, agreed)));
}

export function buildAssignees(
  env: Env, task: { id: string; org_id: string; kind?: string | null }, userIds: string[], dueAt: string | null,
  authorId: string | null | undefined, agreed?: ReadonlySet<string>,
) {
  const now = nowIso();
  const kind = (task.kind ?? 'single') as TaskKind;
  return userIds.map((userId) => {
    const state = initialState(userId, authorId, kind, agreed);
    return env.DB.prepare(
      'INSERT INTO task_assignees (id, task_id, user_id, org_id, state, due_at, accepted_at) VALUES (?, ?, ?, ?, ?, ?, ?)',
    ).bind(uuid(), task.id, userId, task.org_id, state, dueAt, state === 'accepted' ? now : null);
  });
}

/** Стирает журнал напоминаний задачи: у нового срока свои напоминания. */
export function clearReminders(env: Env, taskId: string): D1PreparedStatement {
  return env.DB.prepare('DELETE FROM reminders WHERE assignee_row_id IN (SELECT id FROM task_assignees WHERE task_id = ?)').bind(taskId);
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
 * «Сел за работу»: состояние остаётся accepted, появляется started_at.
 *
 * Отдельной функцией, а не флагом в transitionAssignee: перехода состояния тут
 * нет, а значит нет ни проверки автомата, ни пересчёта статуса задачи --
 * свёртка и до, и после даёт in_progress. Всё, что нужно, -- отметка времени,
 * событие в журнал и весть автору.
 */
export async function startWork(env: Env, task: Task, mine: Assignee, actorId: string): Promise<boolean> {
  if (mine.state !== 'accepted' || mine.started_at) return false;
  const now = nowIso();
  await env.DB.batch([
    env.DB.prepare('UPDATE task_assignees SET started_at = ? WHERE id = ? AND started_at IS NULL').bind(now, mine.id),
    // tasks.updated_at ОБЯЗАТЕЛЬНО, хотя сама задача не меняется.
    //
    // Приложение догружает изменения по этой отметке: «отдай всё, что новее
    // такого-то времени». Начало работы живёт в строке адресата, и без касания
    // задачи строка до клиента не доезжала -- тост говорил «в работе», а
    // карточка оставалась в «Принято» до полной перезагрузки.
    env.DB.prepare('UPDATE tasks SET updated_at = ? WHERE id = ?').bind(now, task.id),
    env.DB.prepare(
      `INSERT INTO events (id, actor_id, org_id, target_type, target_id, action, comment, overdue_by, created_at)
       VALUES (?, ?, ?, 'assignee', ?, 'started', NULL, NULL, ?)`,
    ).bind(uuid(), actorId, task.org_id, mine.id, now),
  ]);
  if (task.author_id && task.author_id !== actorId) {
    await env.DB.batch([await buildNotification(
      env, task, 'started', { emoji: '🚀', label: 'В работе' }, task.deadline ?? null, task.author_id, actorId,
    )]);
  }
  return true;
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
    // started_at тоже гасится: работа возвращена, и «в работе» она станет
    // снова только когда человек за неё сядет.
    sets.push('done_at = NULL', 'started_at = NULL', 'last_escalated_at = NULL', 'reminder_sent_at = NULL', 'review_reminded_at = NULL');
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
    // Возврат в работу даёт новый срок -- и новый цикл напоминаний.
    ...(to === 'rejected' ? [env.DB.prepare('DELETE FROM reminders WHERE assignee_row_id = ?').bind(assignee.id)] : []),
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
  // Двигал не сам адресат -- значит ему и сообщаем: иначе он узнает о
  // переводе, только нажав кнопку в боте и получив «Уже нельзя».
  await recomputeTaskStatus(env, task, actorId, notify, assignee.user_id === actorId ? undefined : [assignee.user_id]);
  return { ok: true };
}

/** Пересчитывает статус задачи по её адресатам и применяет переход, если он нужен. */
export async function recomputeTaskStatus(
  env: Env,
  task: Task,
  actorId: string | null,
  notify?: { emoji: string; label: string; extraLine?: string; track?: boolean; deletePrevious?: boolean },
  alsoNotify?: string[],
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
    alsoNotify,
  });
}

// ------------------------------------------------ ответы адресата с карточки
//
// «Не успею», «Отказать», «Переназначить» -- один путь для бота и для API:
// вторая копия правил разошлась бы с первой на первой же правке.

/**
 * Кому можно переназначить: подтверждённые участники организации, без автора.
 * Порядок ФИКСИРОВАН (имя, id): кнопка хранит индекс, а не id -- два uuid в
 * callback_data не помещаются в 64 байта.
 */
export async function reassignCandidates(env: Env, orgId: string, authorId: string | null): Promise<{ id: string; name: string }[]> {
  if (!authorId) return [];
  const role = await membershipRole(env.DB, orgId, authorId);
  if (!role) return [];
  // Кому автор ВПРАВЕ поручать (дерево, раздел 19), без себя. Порядок
  // фиксирован (имя, id): кнопка хранит индекс и хвост id.
  return (await assignableMembers(env, orgId, authorId, role)).filter((m) => m.id !== authorId).map((m) => ({ id: m.id, name: m.name }));
}

/** Кнопки автору под ответом адресата. Переназначить рассылку нельзя: у неё нет «того самого» адресата. */
function authorButtons(task: Task, after: 'late' | 'declined'): InlineButton[][] {
  const rows: InlineButton[][] = [];
  if (after === 'late') {
    // «Перенести срок» открывает штатную клавиатуру срока (cal:…:back -> dueKeyboard).
    rows.push([{ text: '📅 Перенести срок', callback_data: `cal:${task.id}:back` }, { text: 'Оставить как есть', callback_data: `keep:${task.id}` }]);
  }
  const row: InlineButton[] = [];
  if (task.kind !== 'each') row.push({ text: '👤 Переназначить', callback_data: `ra:${task.id}:` });
  if (after === 'declined') row.push({ text: '🗑 Отменить задачу', callback_data: `cancel:${task.id}` });
  if (row.length) rows.push(row);
  return rows;
}

/** Причина -- одной строкой и с потолком: перевод строки в ней подделал бы следующую строку карточки автора. */
function cleanReason(text: string): string {
  return text.replace(/\s+/g, ' ').trim().slice(0, 500);
}

/** «Не успею»: состояние строки не меняется, автор получает причину и кнопки. */
export async function lateAssignee(env: Env, task: Task, mine: Assignee, actorId: string, rawComment: string): Promise<boolean> {
  const comment = cleanReason(rawComment);
  // Гейт по состоянию: на отказавшейся или сданной строке «не успею» не значит ничего,
  // а без гейта каждое нажатие слало бы автору новую карточку.
  if (mine.state !== 'pending' && mine.state !== 'accepted') return false;
  const writes = [
    env.DB.prepare(
      `INSERT INTO events (id, actor_id, org_id, target_type, target_id, action, comment, overdue_by, created_at)
       VALUES (?, ?, ?, 'assignee', ?, 'late', ?, NULL, ?)`,
    ).bind(uuid(), actorId, task.org_id, mine.id, comment, nowIso()),
  ];
  if (task.author_id && task.author_id !== actorId) {
    writes.push(await buildNotification(env, task, 'late', {
      emoji: '⏳', label: 'Не успевает', extraLine: `Причина: ${comment}`, buttons: authorButtons(task, 'late'),
    }, task.deadline ?? null, task.author_id, actorId));
  }
  await env.DB.batch(writes);
  return true;
}

/**
 * Отказ: строка -> declined, автору причина и кнопки. Уведомление АВТОРУ, а не
 * «живым адресатам»: отказавшийся из списка уже выпал, автора в нём не было
 * никогда, и при единственном адресате не уходило бы ничего.
 */
export async function declineAssignee(
  env: Env, task: Task, mine: Assignee, actorId: string, rawReason: string,
): Promise<{ ok: true } | { ok: false; error: string }> {
  const reason = cleanReason(rawReason);
  const res = await transitionAssignee(env, { task, assignee: mine, to: 'declined', actorId, reason });
  if (!res.ok) return res;
  if (task.author_id && task.author_id !== actorId) {
    await env.DB.batch([await buildNotification(env, task, 'declined', {
      emoji: '🚫', label: 'Отказ от поручения', extraLine: `Причина: ${reason}`, buttons: authorButtons(task, 'declined'),
    }, task.deadline ?? null, task.author_id, actorId)]);
  }
  return { ok: true };
}

/**
 * Переназначение: прежние живые строки -> declined («переназначено»), новый
 * адресат -> pending, статус задачи пересчитывается.
 *
 * ON CONFLICT нужен всерьёз: у отказавшегося строка уже есть (уникальный индекс
 * task_id+user_id), и «вернуть ему же» -- это воскрешение строки, а не вставка.
 * Пересчёт после -- тоже всерьёз: единственный адресат отказался, свёртка дала
 * archived, и без пересчёта новый человек получил бы карточку архивной задачи.
 */
export async function reassignTask(env: Env, task: Task, toUserId: string, actorId: string): Promise<void> {
  const now = nowIso();
  await env.DB.batch([
    env.DB.prepare(
      `UPDATE task_assignees SET state = 'declined', declined_reason = 'переназначено'
       WHERE task_id = ? AND user_id <> ? AND state IN ('pending', 'accepted', 'rejected')`,
    ).bind(task.id, toUserId),
    env.DB.prepare(
      `INSERT INTO task_assignees (id, task_id, user_id, org_id, state, due_at) VALUES (?, ?, ?, ?, 'pending', ?)
       ON CONFLICT(task_id, user_id) DO UPDATE SET state = 'pending', accepted_at = NULL, acknowledged_at = NULL, done_at = NULL,
         declined_reason = NULL, due_at = excluded.due_at, last_escalated_at = NULL, reminder_sent_at = NULL, review_reminded_at = NULL`,
    ).bind(uuid(), task.id, toUserId, task.org_id, task.deadline ?? null),
    clearReminders(env, task.id),
    env.DB.prepare(
      `INSERT INTO events (id, actor_id, org_id, target_type, target_id, action, comment, overdue_by, created_at)
       VALUES (?, ?, ?, 'task', ?, 'reassigned', ?, NULL, ?)`,
    ).bind(uuid(), actorId, task.org_id, task.id, toUserId, now),
    await buildNotification(env, task, 'created', { emoji: '📌', label: 'Вам поручено', buttons: assigneeButtons(task, toUserId) }, task.deadline ?? null, toUserId, actorId),
  ]);
  await recomputeTaskStatus(env, task, actorId);
}
