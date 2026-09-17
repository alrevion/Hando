// Приём поручения: разобранный черновик -> задача в базе.
//
// ОДИН путь для бота и для приложения. Раньше этот код жил в bot.ts, и
// приложение просто не умело того, что умеет бот. Копия здесь была бы хуже
// отсутствия: две ветки создания задач разошлись бы в мелочах (источник,
// уведомления, вложение), и разошлись бы молча.
import type { Env, Task } from './types';
import { nowIso, uuid } from './db';
import { logEvent } from './db';
import { formatWhen, matchDeadline, matchPriority, type Draft } from './parse';
import { buildAssignees, clearReminders, initialStatus, type TaskKind, confirmWork, declineAssignee, lateAssignee, loadAssignees, myAssignee, startWork, transitionAssignee, type Assignee } from './assignees';
import { applyTransition, assigneeButtons, buildNotification } from './transition';
import { storeByFileId, type Media } from './media';
import { ensureDefaultProject } from './signup';

export async function createFromDraft(
  env: Env,
  who: { userId: string; orgId: string },
  draft: Draft,
  /** Вложения черновика. Голосовое тоже здесь -- оно остаётся доказательством. */
  media: Media[],
  rawPhrase: string,
  /** Содержание: подробности, которые человек дописал к теме в приложении. */
  description?: string | null,
): Promise<string | null> {
  const project = await env.DB.prepare(
    `SELECT p.id, p.telegram_chat_id FROM projects p
     LEFT JOIN project_memberships m ON m.project_id = p.id AND m.user_id = ?
     WHERE p.org_id = ? AND p.archived_at IS NULL AND (m.user_id IS NOT NULL OR p.created_by = ?)
     ORDER BY p.created_at LIMIT 1`,
  ).bind(who.userId, who.orgId, who.userId).first<{ id: string }>();
  // В только что созданной организации досок нет вовсе -- заводим первую, иначе
  // класть задачу физически некуда (tasks.project_id NOT NULL). Если доски
  // есть, а этой строки нет -- человека просто не добавили ни на одну, и это
  // другой разговор: молча заводить ему личную доску нельзя.
  const projectId = project?.id ?? (
    (await env.DB.prepare('SELECT id FROM projects WHERE org_id = ? AND archived_at IS NULL LIMIT 1').bind(who.orgId).first())
      ? null
      : await ensureDefaultProject(env, who.orgId, who.userId)
  );
  if (!projectId) return null;

  const taskId = uuid();
  const now = nowIso();
  const task = {
    id: taskId, org_id: who.orgId, project_id: projectId, title: draft.title,
    author_id: who.userId, kind: draft.kind, deadline: draft.deadline,
    telegram_message_id: null,
  } as Task;

  const writes = [
    env.DB.prepare(
      `INSERT INTO tasks (id, org_id, project_id, title, description, repeat_min, checklist, author_id, kind, source, status, priority, deadline, depends_on_task_id)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
    ).bind(taskId, who.orgId, projectId, draft.title, description ?? '',
      draft.repeatMin ?? null,
      draft.checklist?.length ? JSON.stringify(draft.checklist.map((t) => ({ t, d: null }))) : null,
      who.userId, draft.kind,
      // source различает разбор паттернами и моделью -- это и есть замер для
      // порога-гейта шага 4b: сколько фраз обошлось без обращения к сети.
      media.some((m) => m.hasAudio) ? 'voice' : draft.source === 'llm' ? 'bot_llm' : 'bot',
      initialStatus(draft.kind as TaskKind, draft.assigneeIds, who.userId), draft.priority, draft.deadline,
      // Предшественник проверен при подтверждении черновика; здесь только перенос.
      draft.dependsOn ?? null),
    env.DB.prepare(
      `INSERT INTO events (id, actor_id, org_id, target_type, target_id, action, comment, overdue_by, created_at)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)`,
    ).bind(uuid(), who.userId, who.orgId, 'task', taskId, 'created', rawPhrase.slice(0, 500), null, now),
    ...buildAssignees(env, task, draft.assigneeIds, draft.deadline, who.userId),
  ];

  // Уведомление каждому адресату, кроме самого автора: он только что это и
  // продиктовал.
  for (const uid of draft.assigneeIds) {
    if (uid === who.userId) continue;
    writes.push(await buildNotification(env, task, 'created', { emoji: '📌', label: 'Вам поручено', buttons: assigneeButtons(task, uid) }, draft.deadline, uid, who.userId));
  }
  await env.DB.batch(writes);

  // Файлы кладутся ПОСЛЕ задачи и отдельно: сеть может подвести, и терять
  // из-за этого разобранное поручение нельзя.
  for (const m of media) {
    const stored = await storeByFileId(env, m);
    if (!stored) continue;
    const attachmentId = uuid();
    await env.DB.prepare(
      `INSERT INTO attachments (id, org_id, task_id, telegram_file_id, telegram_message_id, filename, mime_type, size_bytes, uploaded_by)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)`,
    ).bind(attachmentId, who.orgId, taskId, stored.fileId, stored.messageId, m.filename, m.mimeType, m.sizeBytes, who.userId).run();
    // Голосовое остаётся доказательством: «покажи, что я тогда сказал».
    if (m.hasAudio) {
      await env.DB.prepare('UPDATE tasks SET origin_audio_id = COALESCE(origin_audio_id, ?) WHERE id = ?')
        .bind(attachmentId, taskId).run();
    }
  }
  return taskId;
}


/**
 * Ставит срок задаче и всем её адресатам.
 *
 * Срок живёт в ДВУХ местах: tasks.deadline -- то, что видно на доске, и
 * task_assignees.due_at -- то, по чему считает напоминание (см. scheduled.ts).
 * Писать только в одно значило бы «срок вижу, а напоминания нет».
 * Журнал напоминаний стирается: у нового срока свои «за час» и «в срок».
 */
export async function setTaskDeadline(env: Env, taskId: string, orgId: string, iso: string | null): Promise<void> {
  await env.DB.batch([
    env.DB.prepare('UPDATE tasks SET deadline = ?, updated_at = ? WHERE id = ? AND org_id = ?')
      .bind(iso, nowIso(), taskId, orgId),
    env.DB.prepare('UPDATE task_assignees SET due_at = ? WHERE task_id = ? AND org_id = ?')
      .bind(iso, taskId, orgId),
    clearReminders(env, taskId),
  ]);
}


// ------------------------------------- ГОЛОСОМ И ТЕКСТОМ по действующей задаче
//
// Одна фраза -- одно действие над УЖЕ созданной задачей: двинуть по этапам,
// принять работу, отпроситься, перенести срок, сменить важность, переименовать.
// До сих пор словами правился только черновик: стоило нажать «Создать», и всё
// остальное делалось руками в приложении. Диктовка ради этого и существует.
//
// ОБЩИЙ ПРЕДИКАТ у всех команд один и тот же и состоит из трёх условий:
//   (1) во фразе есть глагол команды;
//   (2) в ней ДОСЛОВНО названа тема задачи, к которой человек причастен;
//   (3) команда реально что-то меняет.
// Любое несовпадение -- и фраза идёт обычным путём, то есть становится новым
// черновиком. Так «Азизу подготовить отчёт» при существующей задаче
// «Подготовить отчёт» остаётся новым поручением, а не командой.

/**
 * Глагол ищется ТОЛЬКО с начала слова.
 *
 * \b для этого не годится: в JS граница слова считается по ASCII, и рядом с
 * кириллицей её просто нет. А без границы «готов» находится внутри
 * «подготовить» -- и фраза «взял в работу подготовить отчёт» читалась бы как
 * «готово», то есть задача прыгала бы сразу на проверку. Отрицательный
 * ретроспективный просмотр даёт ровно нужное: перед глаголом не буква.
 */
const startOfWord = (body: string) => new RegExp(`(?<![а-яёa-zA-Z])(?:${body})`, 'i');

/** Согласиться взять поручение. «Принял» -- это ещё не «делаю». */
const V_ACCEPT = startOfWord(String.raw`принима[ею]|принял|согласен|берусь|возьму`);
/** Сесть за работу: следующий шаг после согласия. */
const V_START = startOfWord(String.raw`в\s+работу|начал|начина[ею]|приступил|приступа[ею]|беру|взял|занялся|делаю`);
/** Сдать на проверку. */
const V_DONE = startOfWord(String.raw`готов[оа]?|сдела[нл]|выполн[иел]|законч|заверш|сда[лю]|отправил\s+на\s+проверку`);
/** «Не сделал», «ещё не готово» -- это НЕ сдача, хотя глагол тот же. */
const NOT_DONE = startOfWord(String.raw`не\s+(?:ещё\s+|еще\s+)?(?:готов|сдела|выполн|законч|заверш|сда[лю])`);
/** Принять работу -- это делает автор. */
const V_CONFIRM = startOfWord(String.raw`принима[ею]\s+работу|принял\s+работу|подтвержда[ею]|зач[её]т|проверил\s+и\s+принял`);
/**
 * Вернуть на доработку -- тоже автор. Проверяется РАНЬШЕ приёмки: «не принимаю
 * работу» содержит «принимаю работу», и при обратном порядке возврат читался бы
 * как приёмка, то есть задача закрывалась бы вместо возврата.
 */
const V_RETURN = startOfWord(String.raw`верн[уи]|возвраща|на\s+доработку|передела|не\s+принима[ею]|не\s+принял|отклоня[ею]|отклонил`);
/**
 * Отказаться от поручения -- исполнитель. Проверяется РАНЬШЕ «взять в работу»:
 * «не возьму» содержит «возьму».
 */
const V_DECLINE = startOfWord(String.raw`отказ|откаж|не\s+буду|не\s+возьму|не\s+мо[её]|снима[ею]\s+с\s+себя`);
/** Не успеваю: причина -- сама фраза. */
const V_LATE = startOfWord(String.raw`не\s+успева[ею]|не\s+успе[юл]|опазд|задержива[ею]сь`);
/**
 * Правка полей. «сделай» тут намеренно шире остальных: он же начинает
 * «сделай срочной», а пустая правка отсекается условием (3).
 */
const EDIT_VERB = startOfWord(String.raw`перенес|перенёс|перенеси|подвин|сдвин|поменя|измени|исправ|переименуй|обнови|продли|отлож|сдела[йи]`);

/**
 * Переименование -- ТОЛЬКО с явным указателем: «переименуй «X» в «Y»»,
 * «тема: Y», «поменяй тему по «X» на Y».
 *
 * Предлог обязателен, и берётся ПОСЛЕДНИЙ: во фразе «переименуй подготовить
 * отчёт в закрыть акты» первое «в» стоит внутри старой темы, и жадная звёздочка
 * нужна ровно затем, чтобы новой темой стало «закрыть акты», а не вся фраза.
 *
 * \b здесь НЕТ намеренно: в JS граница слова считается по ASCII, и после «й»
 * её не существует -- регулярка с \b не срабатывала ни на одной русской фразе.
 */
const RENAME = [
  /(?:переименуй|тем[ауы]|назван[а-яё]+|заголов[а-яё]+)[^:]*:\s*(.{3,200})$/i,
  /(?:переименуй|тем[ауы]|назван[а-яё]+|заголов[а-яё]+).*\s(?:в|на)\s+(.{3,200})$/i,
];

/**
 * Задача, названная во фразе дословно. Берётся САМАЯ ДЛИННАЯ совпавшая тема:
 * «отчёт» подойдёт трём задачам, «подготовить отчёт по продажам» -- одной.
 *
 * Ищем среди тех, к которым человек причастен -- свои поручения и то, что
 * поручили ему: команда этапа принадлежит исполнителю, команда правки -- автору,
 * и разделяет их уже вызывающий.
 */
async function taskInPhrase(
  env: Env, orgId: string, userId: string, phrase: string,
  /** Только незакрытые: предшественником может быть лишь та задача, которая
   *  ещё в «к выполнению», «принято» или «в работе». Сданную ждать незачем. */
  openOnly = false,
): Promise<Task | null> {
  const q = phrase.toLowerCase();
  const { results } = await env.DB.prepare(
    `SELECT DISTINCT t.* FROM tasks t
     LEFT JOIN task_assignees a ON a.task_id = t.id AND a.user_id = ?
     WHERE t.org_id = ? AND t.status IN (${openOnly ? "'todo','in_progress'" : "'todo','in_progress','done'"})
       AND (t.author_id = ? OR a.user_id IS NOT NULL)
     ORDER BY t.updated_at DESC LIMIT 40`,
  ).bind(userId, orgId, userId).all<Task>();
  return results
    .filter((t) => t.title.trim().length >= 4 && q.includes(t.title.toLowerCase()))
    .sort((a, b) => b.title.length - a.title.length)[0] ?? null;
}

const PRI_RU: Record<string, string> = { urgent: 'высокая', medium: 'средняя', low: 'низкая' };

/**
 * «Заверши её», «эту перенеси на пятницу» -- задача не названа, на неё указали.
 * И фраза из одного глагола -- «готово», «всё, сделал» -- тоже о той, что перед
 * глазами: другого предмета в ней нет.
 */
// «Это» сюда не входит: в речи оно везде («Азизу сделай это срочно» -- новое
// поручение, а не правка прошлого). Оно только не мешает голому глаголу.
const POINTER = /(?<![а-яё])(?:её|ее|его|неё|нее|эту|этой|задачу)(?![а-яё])/i;
const FILLER = new Set(['я', 'уже', 'всё', 'все', 'ну', 'да', 'вот', 'так', 'это', 'ок', 'окей', 'пожалуйста', 'спасибо']);
function pointsAtLast(phrase: string): boolean {
  if (POINTER.test(phrase)) return true;
  const words = phrase.toLowerCase().replace(/в\s+работу|на\s+проверку/g, ' ')
    .split(/[^а-яёa-z]+/).filter((w) => w && !FILLER.has(w));
  return words.length <= 1;
}

/**
 * Задача, о которой бот писал человеку последней: напоминание, уведомление или
 * только что созданная. Раньше «заверши её» сразу после «⚠️ Просрочено:
 * «Посмотреть оформление»» кончалось вопросом «о какой задаче речь?» --
 * хотя бот сам её только что назвал.
 *
 * Полчаса: дальше «её» уже не о том сообщении. Сводка не в счёт -- в ней
 * задач много, и первая из них ничем не выделена.
 */
async function lastMentioned(env: Env, orgId: string, userId: string, now: Date): Promise<Task | null> {
  const since = new Date(now.getTime() - 30 * 60 * 1000).toISOString();
  // Форматы времени разные (ISO у очереди, datetime('now') у задач) --
  // сравниваются через datetime(), иначе «T» и пробел путают порядок.
  const row = await env.DB.prepare(
    `SELECT t.* FROM (
       SELECT n.task_id AS id, n.sent_at AS at FROM notifications n
        WHERE n.assignee_id = ? AND n.org_id = ? AND n.kind <> 'digest' AND n.sent_at IS NOT NULL
          AND datetime(n.sent_at) >= datetime(?)
       UNION ALL
       SELECT id, created_at FROM tasks WHERE author_id = ? AND org_id = ? AND datetime(created_at) >= datetime(?)
     ) m JOIN tasks t ON t.id = m.id
     LEFT JOIN task_assignees a ON a.task_id = t.id AND a.user_id = ?
     WHERE t.status IN ('todo','in_progress','done') AND (t.author_id = ? OR a.user_id IS NOT NULL)
     ORDER BY datetime(m.at) DESC LIMIT 1`,
  ).bind(userId, orgId, since, userId, orgId, since, userId, userId).first<Task>();
  return row ?? null;
}

/**
 * Незакрытый предшественник -- или null, если путь свободен.
 *
 * Держит «ВЗЯТЬ В РАБОТУ», а не «принять». Принять -- это «увидел, берусь»;
 * запрещать человеку даже увидеть задачу до того, как закроют чужую, значит
 * прятать от него работу. Владелец так и сказал: «нельзя НАЧАТЬ».
 */
export async function blockingPredecessor(env: Env, task: Task, orgId: string): Promise<string | null> {
  if (!task.depends_on_task_id) return null;
  const dep = await env.DB.prepare('SELECT title, status FROM tasks WHERE id = ? AND org_id = ?')
    .bind(task.depends_on_task_id, orgId).first<{ title: string; status: string }>();
  return dep && dep.status !== 'done' && dep.status !== 'archived' ? dep.title : null;
}

/**
 * «Одно после другого» -- разбор ПО КЛЮЧЕВОМУ СЛОВУ, а не регуляркой.
 *
 * Регулярка вида `^(.{4,200}?)\s+после\s+(.{4,200})$` на фразе БЕЗ «после»
 * перебирает все разбиения и на длинном вопросе помощнику уходит в минуты
 * работы. Здесь два indexOf: находим слово-разделитель и режем строку.
 *
 * Порядок в двух формах РАЗНЫЙ: в «X после Y» предшественник назван вторым,
 * в «сначала Y, потом X» -- первым.
 */
function splitByOrder(phrase: string): { waiter: string; pred: string } | null {
  const low = phrase.toLowerCase();

  // «сначала Y, потом X»
  if (low.startsWith('сначала ')) {
    const m = /[\s,.]+(?:а\s+)?(?:потом|затем|после\s+этого)\s+/i.exec(phrase.slice(8));
    if (m) {
      const rest = phrase.slice(8);
      return { pred: rest.slice(0, m.index).trim(), waiter: rest.slice(m.index + m[0].length).trim() };
    }
    return null;
  }

  // «X после Y», «X только после того, как Y»
  const at = low.indexOf(' после ');
  if (at < 0) return null;
  let pred = phrase.slice(at + 7).trim();
  pred = pred.replace(/^того[,\s]+как\s+/i, '').trim();
  const waiter = phrase.slice(0, at).replace(/\s+только$/i, '').trim();
  return waiter.length >= 4 && pred.length >= 4 ? { waiter, pred } : null;
}
/**
 * «Одно после другого»: связывает две НАЗВАННЫЕ задачи. Возвращает null, если
 * фраза не о связи или одну из задач не удалось узнать, -- тогда она идёт
 * дальше обычным путём и в худшем случае станет черновиком.
 */
async function linkByPhrase(
  env: Env, who: { userId: string; orgId: string }, phrase: string,
): Promise<{ taskId: string; text: string } | null> {
  const parts = splitByOrder(phrase.trim());
  if (!parts) return null;
  const waiter = await taskInPhrase(env, who.orgId, who.userId, parts.waiter, true);
  const pred = await taskInPhrase(env, who.orgId, who.userId, parts.pred, true);
  if (!waiter || !pred || waiter.id === pred.id) return null;
  // Порядок работ -- решение того, кто поручил: исполнителю остаётся отказ и
  // «не успеваю», а не перекладывание очереди.
  if (waiter.author_id !== who.userId) return null;
  // Круг из двух звеньев: обе задачи ждали бы друг друга и не начались никогда.
  if (pred.depends_on_task_id === waiter.id) {
    return { taskId: waiter.id, text: `⚠️ «${pred.title}» уже ждёт «${waiter.title}» — так они запрут друг друга.` };
  }
  await env.DB.prepare('UPDATE tasks SET depends_on_task_id = ?, updated_at = ? WHERE id = ? AND org_id = ?')
    .bind(pred.id, nowIso(), waiter.id, who.orgId).run();
  await logEvent(env.DB, { actorId: who.userId, orgId: who.orgId, targetType: 'task', targetId: waiter.id, action: 'linked', comment: pred.title });
  return { taskId: waiter.id, text: `🔗 «${waiter.title}» — только после «${pred.title}».` };
}

/**
 * Команда по действующей задаче. Возвращает, что сделано, -- или null, если
 * фраза командой не оказалась и должна идти дальше обычным путём.
 */
export async function commandTaskByPhrase(
  env: Env,
  who: { userId: string; orgId: string },
  phrase: string,
  timeZone: string,
  packId?: string | null,
  dayEndHm?: string,
  /** Последний рабочий день недели организации (1=пн..7=вс). */
  weekEnd?: number,
  now: Date = new Date(),
): Promise<{ taskId: string; text: string } | null> {
  // СВЯЗЬ -- раньше глаголов этапа: «после» ни одним из них не является, и
  // проверка на глагол отсекла бы фразу целиком.
  const linked = await linkByPhrase(env, who, phrase);
  if (linked) return linked;

  const anyVerb = V_ACCEPT.test(phrase) || V_START.test(phrase) || V_DONE.test(phrase) || V_CONFIRM.test(phrase)
    || V_RETURN.test(phrase) || V_DECLINE.test(phrase) || V_LATE.test(phrase) || EDIT_VERB.test(phrase);
  if (!anyVerb) return null;
  const task = await taskInPhrase(env, who.orgId, who.userId, phrase)
    ?? (pointsAtLast(phrase) ? await lastMentioned(env, who.orgId, who.userId, now) : null);
  if (!task) return null;

  const mine = await myAssignee(env, task.id, who.userId, who.orgId);
  const author = task.author_id === who.userId;

  // ---- этапы. ПОРЯДОК ВЕТОК -- часть смысла, а не стиль: длинная формулировка
  // содержит короткую, и первой обязана идти длинная.
  //   «не принимаю работу» содержит «принимаю работу» -> возврат перед приёмкой;
  //   «не возьму»          содержит «возьму»          -> отказ перед началом;
  //   «принял работу»      содержит «принял»          -> приёмка перед началом.
  if (V_RETURN.test(phrase) && author) {
    if (task.status !== 'done') return null;
    // Кому вернуть: всем, кто сдал. У рассылки сдавших может быть несколько.
    const { results: submitted } = await env.DB.prepare(
      "SELECT * FROM task_assignees WHERE task_id = ? AND org_id = ? AND state = 'done'",
    ).bind(task.id, who.orgId).all<Assignee>();
    if (submitted.length === 0) return null;
    // Новый срок: названный во фразе, иначе завтрашний день. Молча оставлять
    // прежний нельзя -- он уже прошёл, раз работу сдавали, и задача вернулась бы
    // просроченной в ту же секунду.
    const when = matchDeadline(phrase, now, timeZone, dayEndHm, weekEnd);
    const newDeadline = when.iso ?? new Date(now.getTime() + 24 * 60 * 60 * 1000).toISOString();
    const comment = phrase.trim().slice(0, 500);
    for (const a of submitted) {
      await transitionAssignee(env, {
        task, assignee: a, to: 'rejected', actorId: who.userId, reason: comment, dueAt: newDeadline,
        notify: { emoji: '❌', label: 'Отклонено, возвращено в работу', extraLine: `Причина: ${comment}` },
      });
    }
    // Срок самой задачи тоже сдвигается: списки показывают его, а не персональные.
    await applyTransition(env, {
      task, to: 'in_progress', actorId: who.userId, action: 'rejected', comment,
      set: { done_at: null, confirmed_at: null, deadline: newDeadline },
    });
    return { taskId: task.id, text: `❌ «${task.title}» вернул в работу. Новый срок — ${formatWhen(newDeadline, timeZone)}.` };
  }
  if (V_CONFIRM.test(phrase) && author) {
    if (task.status !== 'done' || task.confirmed_at) return null;
    await confirmWork(env, task, who.userId);
    return { taskId: task.id, text: `✅ «${task.title}» принята. Задача закрыта.` };
  }
  if (mine && V_DECLINE.test(phrase)) {
    // Причина -- сама фраза, как и у «не успеваю». Автору уходит карточка с
    // кнопками «Переназначить» и «Отменить задачу»: отказ по ошибке
    // отыгрывается назад переназначением, а не правкой базы.
    const res = await declineAssignee(env, task, mine, who.userId, phrase);
    if (!res.ok) return null;
    return { taskId: task.id, text: `🚫 Отказ передан автору: «${task.title}».` };
  }
  if (mine && V_LATE.test(phrase)) {
    // Причина -- сама фраза: человек уже всё объяснил, второй раз спрашивать
    // незачем. Автор получит её вместе с кнопками «перенести срок» и прочими.
    if (!(await lateAssignee(env, task, mine, who.userId, phrase))) return null;
    return { taskId: task.id, text: `⏳ Передал автору: не успеваете по «${task.title}».` };
  }
  // «Начал» по уже принятой задаче -- отметка времени, а не переход.
  const done = V_DONE.test(phrase) && !NOT_DONE.test(phrase);
  if (mine && V_START.test(phrase) && !done && mine.state === 'accepted' && !mine.started_at) {
    const waits = await blockingPredecessor(env, task, who.orgId);
    if (waits) return { taskId: task.id, text: `⛔️ Сначала «${waits}» — «${task.title}» ждёт её.` };
    await startWork(env, task, mine, who.userId);
    return { taskId: task.id, text: `🚀 «${task.title}» — в работе.` };
  }
  if (mine && (V_ACCEPT.test(phrase) || V_START.test(phrase) || done)) {
    const to = done ? 'done' : 'accepted';
    // «Готово» из «не принял» -- две ступени сразу: человек не обязан сперва
    // нажимать «в работу», если он уже всё сделал.
    const steps = to === 'done' && mine.state === 'pending' ? (['accepted', 'done'] as const) : ([to] as const);
    let row = mine;
    for (const step of steps) {
      const res = await transitionAssignee(env, {
        task, assignee: row, to: step, actorId: who.userId,
        notify: step === to
          ? (to === 'accepted' ? { emoji: '🚀', label: 'Принято', track: true } : { emoji: '✅', label: 'Готово', deletePrevious: true })
          : undefined,
      });
      if (!res.ok) return null; // переход не разрешён -- значит это была не команда
      row = { ...row, state: step, accepted_at: row.accepted_at ?? nowIso() };
    }
    // ЗАДАЧА СЕБЕ закрывается сразу: спрашивать у себя же «примите работу» не у кого.
    const fresh = await env.DB.prepare('SELECT * FROM tasks WHERE id = ?').bind(task.id).first<Task>();
    let closed = false;
    if (to === 'done' && author && fresh && fresh.status === 'done' && !fresh.confirmed_at) {
      const live = await loadAssignees(env, task.id, who.orgId);
      if (live.filter((a) => a.state !== 'declined').every((a) => a.user_id === who.userId)) {
        await confirmWork(env, fresh, who.userId, false);
        closed = true;
      }
    }
    // «Взял в работу» на непринятой задаче делает оба шага сразу: согласие и
    // начало. Отдельного «примите сначала» человек не поймёт -- он уже сказал,
    // что делает.
    if (to === 'accepted' && V_START.test(phrase)) {
      // Принять успели выше -- это правильно: согласие зависимость не держит.
      // А вот начать нельзя, и человеку говорится чего ждать.
      const waits = await blockingPredecessor(env, task, who.orgId);
      if (waits) return { taskId: task.id, text: `👌 «${task.title}» принята. Начать можно после «${waits}».` };
      const fresh = await myAssignee(env, task.id, who.userId, who.orgId);
      if (fresh) await startWork(env, task, fresh, who.userId);
      return { taskId: task.id, text: `🚀 «${task.title}» — в работе.` };
    }
    return {
      taskId: task.id,
      // Свою задачу проверять некому -- она закрыта, и «сдана на проверку» было бы неправдой.
      text: to === 'accepted' ? `👌 «${task.title}» принята.` : closed ? `✅ «${task.title}» выполнена.` : `✅ «${task.title}» сдана на проверку.`,
    };
  }

  // ---- правка полей. Только АВТОР: срок и важность -- его решения, а
  // исполнителю для «не успеваю» есть ветка выше.
  if (!author || !EDIT_VERB.test(phrase)) return null;
  const when = matchDeadline(phrase, now, timeZone, dayEndHm, weekEnd);
  const pri = matchPriority(phrase, packId);
  const rename = RENAME.reduce<RegExpMatchArray | null>((hit, re) => hit ?? phrase.match(re), null);
  const newTitle = rename ? rename[1].trim().replace(/^[«"']|[»"'.]$/g, '') : null;

  const said: string[] = [];
  if (when.iso) {
    await setTaskDeadline(env, task.id, who.orgId, when.iso);
    said.push(`срок — ${formatWhen(when.iso, timeZone)}`);
  }
  if (pri.usedWords.size > 0 && pri.priority !== task.priority) {
    await env.DB.prepare('UPDATE tasks SET priority = ?, updated_at = ? WHERE id = ? AND org_id = ?')
      .bind(pri.priority, nowIso(), task.id, who.orgId).run();
    said.push(`важность — ${PRI_RU[pri.priority]}`);
  }
  if (newTitle && newTitle.length >= 3 && newTitle.toLowerCase() !== task.title.toLowerCase()) {
    await env.DB.prepare('UPDATE tasks SET title = ?, updated_at = ? WHERE id = ? AND org_id = ?')
      .bind(newTitle[0].toUpperCase() + newTitle.slice(1), nowIso(), task.id, who.orgId).run();
    said.push(`тема — «${newTitle}»`);
  }
  // Условие (3): глагол был, задача нашлась, а менять нечего -- не команда.
  if (said.length === 0) return null;

  await logEvent(env.DB, { actorId: who.userId, orgId: who.orgId, targetType: 'task', targetId: task.id, action: 'edited' });
  return { taskId: task.id, text: `✏️ «${task.title}»: ${said.join(', ')}.` };
}
