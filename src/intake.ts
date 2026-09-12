// Приём поручения: разобранный черновик -> задача в базе.
//
// ОДИН путь для бота и для приложения. Раньше этот код жил в bot.ts, и
// приложение просто не умело того, что умеет бот. Копия здесь была бы хуже
// отсутствия: две ветки создания задач разошлись бы в мелочах (источник,
// уведомления, вложение), и разошлись бы молча.
import type { Env, Task } from './types';
import { nowIso, uuid } from './db';
import type { Draft } from './parse';
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

