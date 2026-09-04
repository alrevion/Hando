// Cron (*/5 * * * *): auto-archive stale Done tasks, then escalate overdue ones.
import type { Env, Task } from './types';
import { nowIso } from './db';
import { deleteMessage, sendMessage } from './telegram';
import { applyTransition } from './transition';
import { drainOutbox } from './outbox';

const SEVEN_DAYS_MS = 7 * 24 * 60 * 60 * 1000;
const ONE_DAY_MS = 24 * 60 * 60 * 1000;
const REVIEW_WINDOW_MS = 2 * 24 * 60 * 60 * 1000;

export async function scheduled(_controller: ScheduledController, env: Env, _ctx: ExecutionContext): Promise<void> {
  await autoArchive(env);
  await escalateOverdue(env);
  await remindApproachingDeadline(env);
  await remindStaleReview(env);
  // Страховка за отправку: роуты сливают outbox сразу после ответа, но если тот
  // вызов не дошёл, строка так и лежит с sent_at IS NULL -- здесь она уедет.
  await drainOutbox(env);
}

// (a) status='done' + done_at older than 7 days -> archived (system-generated event).
// Единственная ветка cron, которая пишет status, -- и потому единственная, что
// идёт через applyTransition. Три остальных прохода ниже пишут только таймеры;
// они переезжают на task_assignees на шаге 3.
async function autoArchive(env: Env): Promise<void> {
  const { results } = await env.DB.prepare("SELECT * FROM tasks WHERE status = 'done' AND done_at IS NOT NULL").all<Task>();
  const cutoff = Date.now() - SEVEN_DAYS_MS;
  for (const t of results) {
    if (Date.parse(t.done_at as string) > cutoff) continue;
    // actorId null -- отметка «сделала система»: по ней архив отличают от ручного.
    // Уведомления нет намеренно: автоархив семидневной давности никого не касается,
    // и так было до шага 1 -- вводить рассылку здесь значило бы менять поведение.
    await applyTransition(env, { task: t, to: 'archived', actorId: null, action: 'archived' });
  }
}

// (b) У КАЖДОГО адресата свой срок и свой флаг эскалации.
//
// До шага 3 это были по-задачные флаги, и при рассылке на 14 человек первая же
// отправка гасила флаг -- остальные 13 не получали ничего никогда. Именно поэтому
// таймеры переехали на строку адресата, а не «заодно с состояниями».
//
// last_escalated_at IS NULL -- гейт «ещё не слали»: каждая строка получает ровно
// одно предупреждение о просрочке, а не по одному на каждый тик cron.
async function escalateOverdue(env: Env): Promise<void> {
  const { results } = await env.DB.prepare(
    `SELECT a.id, a.due_at, a.user_id, t.id AS task_id, t.title, t.telegram_message_id, t.org_id,
            u.name AS responsible_name, p.telegram_chat_id AS project_chat_id
     FROM task_assignees a
     JOIN tasks t ON t.id = a.task_id
     JOIN users u ON u.id = a.user_id
     JOIN projects p ON p.id = t.project_id
     WHERE a.state IN ('pending','accepted','rejected') AND a.due_at IS NOT NULL
       AND a.last_escalated_at IS NULL AND p.archived_at IS NULL
       -- Статус задачи гасит её строки: архивную задачу никто не делает, и
       -- напоминать по ней -- шум. Проверка по t.status, а не только по
       -- состоянию строки: архив ставит автор, состояния адресатов он не трогает.
       AND t.status <> 'archived'`,
  ).all<{ id: string; due_at: string; task_id: string; title: string; telegram_message_id: string | null; org_id: string; responsible_name: string; project_chat_id: string }>();

  const now = Date.now();
  for (const r of results) {
    const deadlineMs = Date.parse(r.due_at);
    if (!(deadlineMs < now)) continue; // ещё не просрочено

    const text = `⚠️ ВЫ ПРОСРОЧИЛИ ДЕДЛАЙН\n${r.responsible_name}, задача "${r.title}" просрочена на ${formatOverdue(now - deadlineMs)}.`;
    const newId = await sendMessage(env, r.project_chat_id, text);
    if (!newId) continue; // не ушло: флаг не ставим, следующий тик попробует снова

    // Прежнее отслеживаемое сообщение гасим только у single: у рассылки оно
    // общее на задачу, и удалять его на первой же эскалации значило бы стирать
    // след для остальных тринадцати.
    if (r.telegram_message_id) await deleteMessage(env, r.project_chat_id, r.telegram_message_id);
    await env.DB.prepare('UPDATE task_assignees SET last_escalated_at = ? WHERE id = ?').bind(nowIso(), r.id).run();
  }
}

// (c) Срок наступает в ближайшие сутки и ещё не наступил -- разовое
// предупреждение, отдельно от эскалации (та стреляет уже ПОСЛЕ срока).
async function remindApproachingDeadline(env: Env): Promise<void> {
  const { results } = await env.DB.prepare(
    `SELECT a.id, a.due_at, t.title, u.name AS responsible_name, p.telegram_chat_id AS project_chat_id
     FROM task_assignees a
     JOIN tasks t ON t.id = a.task_id
     JOIN users u ON u.id = a.user_id
     JOIN projects p ON p.id = t.project_id
     WHERE a.state IN ('pending','accepted','rejected') AND a.due_at IS NOT NULL
       AND a.reminder_sent_at IS NULL AND p.archived_at IS NULL
       AND t.status <> 'archived'`,
  ).all<{ id: string; due_at: string; title: string; responsible_name: string; project_chat_id: string }>();

  const now = Date.now();
  for (const r of results) {
    const deadlineMs = Date.parse(r.due_at);
    if (deadlineMs < now || deadlineMs - now > ONE_DAY_MS) continue;
    const text = `⏰ Дедлайн приближается\nЗадача "${r.title}" (${r.responsible_name}) должна быть готова менее чем через день.`;
    if (!(await sendMessage(env, r.project_chat_id, text))) continue;
    await env.DB.prepare('UPDATE task_assignees SET reminder_sent_at = ? WHERE id = ?').bind(nowIso(), r.id).run();
  }
}

// (d) Сделано, но не проверено 2+ дня. Это упрёк ПРОВЕРЯЮЩЕМУ, не исполнителю:
// опоздание исполнителя судится по done_at против срока при подтверждении.
async function remindStaleReview(env: Env): Promise<void> {
  const { results } = await env.DB.prepare(
    `SELECT a.id, a.done_at, t.title, u.name AS responsible_name, p.telegram_chat_id AS project_chat_id
     FROM task_assignees a
     JOIN tasks t ON t.id = a.task_id
     JOIN users u ON u.id = a.user_id
     JOIN projects p ON p.id = t.project_id
     WHERE a.state = 'done' AND a.done_at IS NOT NULL
       AND a.review_reminded_at IS NULL AND p.archived_at IS NULL
       AND t.status <> 'archived'`,
  ).all<{ id: string; done_at: string; title: string; responsible_name: string; project_chat_id: string }>();

  const now = Date.now();
  for (const r of results) {
    if (now - Date.parse(r.done_at) < REVIEW_WINDOW_MS) continue;
    const text = `🔔 Пора проверить задачу\n"${r.title}" (${r.responsible_name}) выполнена более 2 дней назад и всё ещё не проверена.`;
    if (!(await sendMessage(env, r.project_chat_id, text))) continue;
    await env.DB.prepare('UPDATE task_assignees SET review_reminded_at = ? WHERE id = ?').bind(nowIso(), r.id).run();
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
