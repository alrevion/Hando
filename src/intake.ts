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
import { buildAssignees, clearReminders } from './assignees';
import { assigneeButtons, buildNotification } from './transition';
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
      `INSERT INTO tasks (id, org_id, project_id, title, description, author_id, kind, source, status, priority, deadline)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, 'todo', ?, ?)`,
    ).bind(taskId, who.orgId, projectId, draft.title, description ?? '', who.userId, draft.kind,
      // source различает разбор паттернами и моделью -- это и есть замер для
      // порога-гейта шага 4b: сколько фраз обошлось без обращения к сети.
      media.some((m) => m.hasAudio) ? 'voice' : draft.source === 'llm' ? 'bot_llm' : 'bot', draft.priority, draft.deadline),
    env.DB.prepare(
      `INSERT INTO events (id, actor_id, org_id, target_type, target_id, action, comment, overdue_by, created_at)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)`,
    ).bind(uuid(), who.userId, who.orgId, 'task', taskId, 'created', rawPhrase.slice(0, 500), null, now),
    ...buildAssignees(env, task, draft.assigneeIds, draft.deadline),
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

// --------------------------------------------- правка ДЕЙСТВУЮЩЕЙ задачи словами

/**
 * Глаголы правки. Признак срабатывания -- ТРИ условия сразу: глагол, дословно
 * названная тема своего поручения и хотя бы одно поле, которое реально
 * меняется. Одного глагола мало («сделай отчёт» -- это новая задача), одной
 * темы тоже: «Азизу подготовить отчёт» при существующем «Подготовить отчёт» --
 * новое поручение. Третье условие ловит остаток: глагол и тема совпали, а
 * менять нечего -- значит это не правка, и фраза идёт обычным путём.
 */
const EDIT_VERB = /(перенес|перенёс|перенеси|подвин|сдвин|поменя|измени|исправ|переименуй|обнови|продли|отлож|сдела[йи])/i;

/**
 * Переименование -- ТОЛЬКО с явным указателем: «переименуй «X» в «Y»»,
 * «тема: Y», «поменяй тему по «X» на Y».
 *
 * Предлог обязателен, и берётся ПОСЛЕДНИЙ: во фразе «переименуй подготовить
 * отчёт в закрыть акты» первое «в» стоит внутри старой темы, и жадная звёздочка
 * нужна ровно затем, чтобы новой темой стало «закрыть акты», а не вся фраза.
 */
// \b здесь НЕТ намеренно: в JS граница слова считается по ASCII, и после «й»
// её не существует -- регулярка с \b не срабатывала ни на одной русской фразе.
const RENAME = [
  /(?:переименуй|тем[ауы]|назван[а-яё]+|заголов[а-яё]+)[^:]*:\s*(.{3,200})$/i,
  /(?:переименуй|тем[ауы]|назван[а-яё]+|заголов[а-яё]+).*\s(?:в|на)\s+(.{3,200})$/i,
];

/**
 * Правка уже созданной задачи одной фразой: «перенеси срок по «сдать отчёт» на
 * пятницу», «сделай «закрыть акты» срочной».
 *
 * Зачем: до сих пор словами правился ТОЛЬКО черновик, а стоило нажать
 * «Создать» -- и менять приходилось руками в приложении. Диктовка ради этого и
 * существует, поэтому она обязана доставать и до начатой задачи.
 *
 * Правит АВТОР и только свои поручения: срок и важность -- его решения.
 * Исполнителю для «не успеваю» есть своя кнопка с причиной.
 *
 * Модель здесь НЕ зовётся: срок и важность узнаются теми же словарями, что при
 * разборе, а переименование требует явного указателя. Гадать на действующей
 * задаче дороже, чем на черновике: черновик человек видит перед собой, а
 * задача уже ушла исполнителю.
 */
export async function editTaskByPhrase(
  env: Env,
  who: { userId: string; orgId: string },
  phrase: string,
  timeZone: string,
  packId?: string | null,
  dayEndHm?: string,
  now: Date = new Date(),
): Promise<{ taskId: string; text: string } | null> {
  if (!EDIT_VERB.test(phrase)) return null;
  const q = phrase.toLowerCase();
  const { results } = await env.DB.prepare(
    `SELECT id, title, deadline, priority FROM tasks
     WHERE org_id = ? AND author_id = ? AND status IN ('todo','in_progress','done')
     ORDER BY updated_at DESC LIMIT 40`,
  ).bind(who.orgId, who.userId).all<{ id: string; title: string; deadline: string | null; priority: string }>();

  // Самая ДЛИННАЯ совпавшая тема: «отчёт» подойдёт трём задачам, «подготовить
  // отчёт по продажам» -- одной. Берём ту, о которой сказали подробнее.
  const hit = results
    .filter((t) => t.title.trim().length >= 4 && q.includes(t.title.toLowerCase()))
    .sort((a, b) => b.title.length - a.title.length)[0];
  if (!hit) return null;

  const when = matchDeadline(phrase, now, timeZone, dayEndHm);
  const pri = matchPriority(phrase, packId);
  const rename = RENAME.reduce<RegExpMatchArray | null>((hit, re) => hit ?? phrase.match(re), null);
  const newTitle = rename ? rename[1].trim().replace(/^[«"']|[»"'.]$/g, '') : null;

  const said: string[] = [];
  if (when.iso) {
    await setTaskDeadline(env, hit.id, who.orgId, when.iso);
    said.push(`срок — ${formatWhen(when.iso, timeZone)}`);
  }
  if (pri.usedWords.size > 0 && pri.priority !== hit.priority) {
    await env.DB.prepare('UPDATE tasks SET priority = ?, updated_at = ? WHERE id = ? AND org_id = ?')
      .bind(pri.priority, nowIso(), hit.id, who.orgId).run();
    said.push(`важность — ${pri.priority === 'urgent' ? 'высокая' : pri.priority === 'low' ? 'низкая' : 'средняя'}`);
  }
  if (newTitle && newTitle.length >= 3 && newTitle.toLowerCase() !== hit.title.toLowerCase()) {
    await env.DB.prepare('UPDATE tasks SET title = ?, updated_at = ? WHERE id = ? AND org_id = ?')
      .bind(newTitle[0].toUpperCase() + newTitle.slice(1), nowIso(), hit.id, who.orgId).run();
    said.push(`тема — «${newTitle}»`);
  }
  // Глагол был, задача нашлась, а менять нечего: молчим и пропускаем фразу
  // дальше по обычному пути. Иначе «поменяй отчёт местами» съедалось бы здесь.
  if (said.length === 0) return null;

  await logEvent(env.DB, { actorId: who.userId, orgId: who.orgId, targetType: 'task', targetId: hit.id, action: 'edited' });
  return { taskId: hit.id, text: `✏️ «${hit.title}»: ${said.join(', ')}.` };
}
