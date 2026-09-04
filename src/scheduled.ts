// Cron (*/5 * * * *): auto-archive stale Done tasks, then escalate overdue ones.
import type { Env, Task } from './types';
import { logEvent, nowIso } from './db';
import { deleteMessage, sendMessage } from './telegram';

const SEVEN_DAYS_MS = 7 * 24 * 60 * 60 * 1000;
const ONE_DAY_MS = 24 * 60 * 60 * 1000;
const REVIEW_WINDOW_MS = 2 * 24 * 60 * 60 * 1000;

export async function scheduled(_controller: ScheduledController, env: Env, _ctx: ExecutionContext): Promise<void> {
  await autoArchive(env);
  await escalateOverdue(env);
  await remindApproachingDeadline(env);
  await remindStaleReview(env);
}

// (a) status='done' + done_at older than 7 days -> archived (system-generated event).
async function autoArchive(env: Env): Promise<void> {
  const { results } = await env.DB.prepare("SELECT id, done_at FROM tasks WHERE status = 'done' AND done_at IS NOT NULL").all<{
    id: string;
    done_at: string;
  }>();
  const cutoff = Date.now() - SEVEN_DAYS_MS;
  for (const t of results) {
    if (Date.parse(t.done_at) > cutoff) continue;
    await env.DB.prepare("UPDATE tasks SET status = 'archived', updated_at = ? WHERE id = ?").bind(nowIso(), t.id).run();
    await logEvent(env.DB, { actorId: null, targetType: 'task', targetId: t.id, action: 'archived' });
  }
}

// (b) todo/in_progress + passed deadline + not yet escalated + project NOT soft-deleted
// -> send once. last_escalated_at IS NULL is the "not sent yet" gate, so a task is only
// ever notified a single time (no repeat every Cron tick).
async function escalateOverdue(env: Env): Promise<void> {
  const { results } = await env.DB.prepare(
    `SELECT t.*, u.name AS responsible_name, p.telegram_chat_id AS project_chat_id FROM tasks t
     JOIN users u ON u.id = t.responsible_user_id
     JOIN projects p ON p.id = t.project_id
     WHERE t.status IN ('todo', 'in_progress') AND t.deadline IS NOT NULL AND t.last_escalated_at IS NULL AND p.archived_at IS NULL`,
  ).all<Task & { responsible_name: string; project_chat_id: string }>();

  const now = Date.now();
  for (const t of results) {
    const deadlineMs = Date.parse(t.deadline as string);
    if (!(deadlineMs < now)) continue; // not overdue yet

    const text = `⚠️ ВЫ ПРОСРОЧИЛИ ДЕДЛАЙН\n${t.responsible_name}, задача "${t.title}" просрочена на ${formatOverdue(now - deadlineMs)}.`;
    const newId = await sendMessage(env, t.project_chat_id, text);
    if (!newId) continue; // send failed: last_escalated_at stays null, retry next tick

    // Drop the previous tracked message (e.g. the "🚀 В работе" notice), then track this one.
    if (t.telegram_message_id) await deleteMessage(env, t.project_chat_id, t.telegram_message_id);
    await env.DB.prepare('UPDATE tasks SET telegram_message_id = ?, last_escalated_at = ? WHERE id = ?')
      .bind(newId, nowIso(), t.id)
      .run();
  }
}

// (c) todo/in_progress + deadline within the next 24h + not yet overdue + not
// yet reminded -> a single heads-up (separate from the overdue escalation,
// which only fires once the deadline has actually passed).
async function remindApproachingDeadline(env: Env): Promise<void> {
  const { results } = await env.DB.prepare(
    `SELECT t.*, u.name AS responsible_name, p.telegram_chat_id AS project_chat_id FROM tasks t
     JOIN users u ON u.id = t.responsible_user_id
     JOIN projects p ON p.id = t.project_id
     WHERE t.status IN ('todo', 'in_progress') AND t.deadline IS NOT NULL AND t.reminder_sent_at IS NULL AND p.archived_at IS NULL`,
  ).all<Task & { responsible_name: string; project_chat_id: string }>();

  const now = Date.now();
  for (const t of results) {
    const deadlineMs = Date.parse(t.deadline as string);
    if (deadlineMs < now || deadlineMs - now > ONE_DAY_MS) continue; // already overdue, or more than a day away

    const text = `⏰ Дедлайн приближается\nЗадача "${t.title}" (${t.responsible_name}) должна быть готова менее чем через день.`;
    const sent = await sendMessage(env, t.project_chat_id, text);
    if (!sent) continue; // send failed: reminder_sent_at stays null, retry next tick
    await env.DB.prepare('UPDATE tasks SET reminder_sent_at = ? WHERE id = ?').bind(nowIso(), t.id).run();
  }
}

// (d) done + unconfirmed + sitting for 2+ days -> a single nudge that review is
// overdue. This is on the reviewer, not the worker -- the worker's own lateness
// is already judged against done_at vs deadline (see POST /tasks/:id/confirm).
async function remindStaleReview(env: Env): Promise<void> {
  const { results } = await env.DB.prepare(
    `SELECT t.*, u.name AS responsible_name, p.telegram_chat_id AS project_chat_id FROM tasks t
     JOIN users u ON u.id = t.responsible_user_id
     JOIN projects p ON p.id = t.project_id
     WHERE t.status = 'done' AND t.confirmed_at IS NULL AND t.done_at IS NOT NULL
       AND t.review_reminded_at IS NULL AND p.archived_at IS NULL`,
  ).all<Task & { responsible_name: string; project_chat_id: string }>();

  const now = Date.now();
  for (const t of results) {
    if (now - Date.parse(t.done_at as string) < REVIEW_WINDOW_MS) continue; // not yet 2 days

    const text = `🔔 Пора проверить задачу\n"${t.title}" (${t.responsible_name}) выполнена более 2 дней назад и всё ещё не проверена.`;
    const sent = await sendMessage(env, t.project_chat_id, text);
    if (!sent) continue; // send failed: review_reminded_at stays null, retry next tick
    await env.DB.prepare('UPDATE tasks SET review_reminded_at = ? WHERE id = ?').bind(nowIso(), t.id).run();
  }
}

function formatOverdue(ms: number): string {
  const mins = Math.floor(ms / 60000);
  const h = Math.floor(mins / 60);
  const m = mins % 60;
  if (h >= 24) return `${Math.floor(h / 24)}д ${h % 24}ч`;
  if (h > 0) return `${h}ч ${m}м`;
  return `${m}м`;
}
