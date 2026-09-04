// Единственное место, где меняется tasks.status (шаг 1 плана).
//
// До этого статус писали шесть разных мест: пять роутов и autoArchive в cron.
// Каждое само решало, какие поля жизненного цикла погасить и что отправить в
// Telegram, -- и решали по-разному. Отсюда и приёмка шага: закрытие через API и
// закрытие, вызванное cron, обязаны давать ОДИНАКОВУЮ строку tasks.
//
// Инвариант проверяется тестом test/single-writer.test.ts грепом по src/:
// `UPDATE tasks SET ... status` вне этого файла -- падение.
import type { Env, Task, TaskStatus } from './types';
import { nowIso, uuid } from './db';

// Колонки жизненного цикла, которые переход вправе трогать помимо status.
// Список закрытый намеренно: переход -- не универсальный UPDATE, и title через
// него не проедет.
export type LifecycleFields = {
  done_at?: string | null;
  confirmed_at?: string | null;
  deadline?: string | null;
  last_escalated_at?: string | null;
  reminder_sent_at?: string | null;
  review_reminded_at?: string | null;
  telegram_message_id?: string | null;
};

export type TransitionInput = {
  task: Task;
  // Может совпадать с текущим статусом: confirm не двигает задачу с 'done',
  // но меняет её жизненный цикл и обязан идти тем же путём.
  to: TaskStatus;
  actorId: string | null;
  action: string;
  comment?: string | null;
  overdueBy?: number | null;
  set?: LifecycleFields;
  notify?: {
    emoji: string;
    label: string;
    extraLine?: string;
    // Сообщение, которое потом заменяет эскалация: его id уезжает в
    // tasks.telegram_message_id -- но уже проходом отправки, а не здесь.
    // На момент batch сообщения ещё не существует, и в этом весь смысл outbox.
    track?: boolean;
    // Погасить прежнее отслеживаемое сообщение перед отправкой нового.
    deletePrevious?: boolean;
    // Инлайновые кнопки: callback_data вида "<действие>:<taskId>".
    buttons?: { text: string; callback_data: string }[][];
  };
};

const APP_URL = 'https://hando.alrevion.com';

// Текст собирается ЗДЕСЬ, а не в проходе отправки: payload обязан быть
// самодостаточным. Иначе повторная отправка через сутки взяла бы уже изменённые
// имя и дедлайн, и человек получил бы сообщение о состоянии, которого не было.
async function composeText(
  env: Env,
  task: Task,
  n: NonNullable<TransitionInput['notify']>,
  deadline: string | null,
): Promise<string> {
  const resp = await env.DB.prepare('SELECT name, telegram_username FROM users WHERE id = ?')
    .bind(task.responsible_user_id)
    .first<{ name: string; telegram_username: string | null }>();
  // @username действительно пингует в Telegram, простое имя в тексте -- нет.
  const who = resp ? (resp.telegram_username ? `@${resp.telegram_username} (${resp.name})` : resp.name) : '—';
  const lines = [`${n.emoji} ${n.label}: "${task.title}"`, `Ответственный: ${who}`];
  if (deadline) lines.push(`Дедлайн: ${deadline}`);
  if (n.extraLine) lines.push(n.extraLine);
  lines.push(`${APP_URL}/?task=${task.id}`);
  return lines.join('\n');
}

/**
 * Применяет переход одним db.batch(): строка tasks, строка events и (если есть
 * что слать) строка notifications -- атомарно. Отправка НЕ делается здесь.
 */
export async function applyTransition(env: Env, input: TransitionInput): Promise<void> {
  const { task, to, actorId, action, comment, overdueBy, set, notify } = input;
  const now = nowIso();

  // Собираем UPDATE только из тех колонок, которые переход реально просили
  // изменить: `set.done_at === undefined` и `set.done_at === null` -- разные
  // намерения, и COALESCE их бы склеил.
  const columns: string[] = ['status = ?', 'updated_at = ?'];
  const values: unknown[] = [to, now];
  for (const [key, value] of Object.entries(set ?? {}) as [keyof LifecycleFields, string | null][]) {
    if (value === undefined) continue;
    columns.push(`${key} = ?`);
    values.push(value);
  }

  const statements = [
    env.DB.prepare(`UPDATE tasks SET ${columns.join(', ')} WHERE id = ?`).bind(...values, task.id),
    // Порядок бинда -- как у logEvent (db.ts): одна форма на всю кодовую базу.
    // org_id берётся из САМОЙ ЗАДАЧИ, а не из сессии: автоархив по cron идёт без
    // сессии вообще, и событие всё равно обязано принадлежать арендатору.
    env.DB.prepare(
      `INSERT INTO events (id, actor_id, org_id, target_type, target_id, action, comment, overdue_by, created_at)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)`,
    ).bind(uuid(), actorId, task.org_id, 'task', task.id, action, comment ?? null, overdueBy ?? null, now),
  ];

  if (notify) {
    // Дедлайн берётся ПОСЛЕ перехода: reject сдвигает срок, и сообщение про
    // старый срок было бы прямой дезинформацией исполнителя.
    statements.push(await buildNotification(env, task, action, notify, set?.deadline !== undefined ? set.deadline : (task.deadline ?? null)));
  }

  await env.DB.batch(statements);
}

/**
 * Строит строку outbox для задачи. Экспортируется, потому что создание задачи --
 * не переход (прежнего состояния нет), но страдает ровно от той же болезни:
 * запись и отправка порознь. Два пути рассылки означали бы, что «ровно один раз»
 * доказано для одного из них.
 */
export async function buildNotification(
  env: Env,
  task: Task,
  kind: string,
  notify: NonNullable<TransitionInput['notify']>,
  deadline: string | null,
): Promise<D1PreparedStatement> {
  // ADR-4: ЗАГОЛОВОК ЗАДАЧИ УХОДИТ В ЛИЧКУ, а не в групповой чат. Группа --
  // общий канал доски, и содержание поручения там видят все участники, включая
  // тех, кого оно не касается. В группу остаются только сводки со счётчиками
  // (см. groupDigest ниже).
  //
  // ТЕКСТ замораживается здесь, АДРЕС -- нет.
  //
  // Текст обязан быть снимком: повторная отправка через сутки взяла бы уже
  // изменённые имя и срок, и человек получил бы сообщение о состоянии, которого
  // не было. Адрес -- наоборот: это маршрутизация, а не содержание. Если
  // заморозить и его, человек, подключивший бота ПОСЛЕ постановки задачи,
  // навсегда остался бы с пустым адресом и не получил бы накопленное -- ровно
  // то, что ADR-4 обещает доставить. Поэтому в payload едет recipient_user_id, а
  // telegram_user_id резолвится проходом отправки.
  const payload = {
    recipient_user_id: task.responsible_user_id,
    text: await composeText(env, task, notify, deadline),
    // Гасим прежнее отслеживаемое сообщение (например «🚀 В работе») тем же
    // проходом отправки, чтобы порядок «удалить старое, отправить новое» не
    // зависел от того, чем закончился запрос.
    delete_message_id: notify.deletePrevious ? (task.telegram_message_id ?? null) : null,
    track: notify.track === true,
    // Кнопки прикрепляются ТОЛЬКО с шага 4a: до появления входящего канала
    // нажатие крутило бы спиннер до таймаута. Предлагаем следующий шаг автомата,
    // а не все сразу -- «Принял» на уже принятой задаче ничего не значит.
    keyboard: notify.buttons ?? null,
  };
  return env.DB.prepare(
    `INSERT INTO notifications (id, task_id, assignee_id, org_id, kind, payload, scheduled_at)
     VALUES (?, ?, ?, ?, ?, ?, ?)`,
  ).bind(uuid(), task.id, task.responsible_user_id, task.org_id, kind, JSON.stringify(payload), nowIso());
}
