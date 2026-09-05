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
  // Трёх таймеров (last_escalated_at / reminder_sent_at / review_reminded_at)
  // здесь БОЛЬШЕ НЕТ: они переехали на строки адресатов в шаге 3 и удалены из
  // tasks contract-релизом. У рассылки на 14 человек по-задачный таймер гасился
  // первой же отправкой, и тринадцать не получали ничего.
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
  // Про КОГО сообщение -- актор перехода, а не получатель письма. Это разные
  // люди: когда С0 берёт задачу, тринадцать остальных получают письмо ПРО С0.
  // Раньше подставлялось имя получателя, и каждый читал «Ответственный: <он
  // сам>» о действии, которого не совершал.
  subjectId: string,
  n: NonNullable<TransitionInput['notify']>,
  deadline: string | null,
): Promise<string> {
  const resp = await env.DB.prepare('SELECT name, telegram_username FROM users WHERE id = ?')
    .bind(subjectId)
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
    // КОГО касается переход.
    //
    // Раньше письмо уходило каждому живому адресату на каждое действие каждого
    // другого адресата: на рассылке из 14 это 14x14 = 196 сообщений за цикл
    // «принял/сдал», и Telegram упирался бы в rate limit раньше, чем пилот в
    // метрики. Правило теперь такое:
    //   -- действие ОДНОГО адресата (принял, сдал) касается автора: ему видеть
    //      ход работы, остальным исполнителям -- нет;
    //   -- переход ЗАДАЧИ целиком (закрыта, возвращена, архив) касается всех
    //      живых адресатов: он меняет их собственную работу.
    const deadline = set?.deadline !== undefined ? set.deadline : (task.deadline ?? null);
    const targets = new Set<string>();

    // (1) АКТОР, если он адресат. Его письмо -- якорь ветки: именно его
    // message_id сохраняется как telegram_message_id и позже заменяется
    // эскалацией. Убрать актора значило бы остаться без якоря.
    if (actorId) {
      const mine = await env.DB.prepare('SELECT 1 FROM task_assignees WHERE task_id = ? AND user_id = ?')
        .bind(task.id, actorId).first();
      if (mine) targets.add(actorId);
    }

    // (2) АВТОР -- ему видеть ход работы, которую он поручил. Себе о собственном
    // действии не пишем: человек только что нажал кнопку.
    if (task.author_id && task.author_id !== actorId) targets.add(task.author_id);

    // (3) ОСТАЛЬНЫЕ адресаты -- только когда переход меняет ИХ работу: задача
    // закрыта, ушла в архив или возвращена в работу. «Коллега взял свою часть»
    // их не касается, и раньше это письмо уходило каждому на каждое действие
    // каждого: на рассылке из 14 -- 196 сообщений за цикл, и Telegram упирался
    // бы в rate limit раньше, чем пилот в метрики.
    if (to === 'done' || to === 'archived' || action === 'rejected') {
      const { results } = await env.DB.prepare(
        "SELECT user_id FROM task_assignees WHERE task_id = ? AND state <> 'declined'",
      ).bind(task.id).all<{ user_id: string }>();
      for (const r of results) targets.add(r.user_id);
    }

    for (const uid of targets) {
      statements.push(await buildNotification(env, task, action, notify, deadline, uid, actorId ?? undefined));
    }
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
  // Кому именно. С contract-релиза «ответственного» у задачи нет -- есть
  // строки адресатов, и уведомление адресуется конкретной из них.
  recipientId: string,
  // Про кого. По умолчанию -- сам получатель (создание задачи: «вам поручено»).
  // На переходах это АКТОР: остальные адресаты читают про того, кто действовал.
  subjectId?: string,
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
    recipient_user_id: recipientId,
    text: await composeText(env, task, subjectId ?? recipientId, notify, deadline),
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
  ).bind(uuid(), task.id, recipientId, task.org_id, kind, JSON.stringify(payload), nowIso());
}
