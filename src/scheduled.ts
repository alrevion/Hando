// Cron (раз в час): архив залежавшихся Done, эскалация просроченных,
// напоминания о подходящем сроке и страховка за очередь отправки.
import type { Env, Task } from './types';
import { nowIso, uuid } from './db';
import { reconcileWebhook } from './telegram';
import { applyTransition } from './transition';
import { drainOutbox } from './outbox';
import { enqueueNudges } from './nudges';

// Тот же домен, что в transition.ts: адрес воркера один.
const APP_URL = 'https://hando.alrevion.com';

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
  // Поводы ставятся ДО слива очереди: иначе выданный сейчас повод ждал бы
  // следующего тика.
  await enqueueNudges(env);
  await drainOutbox(env);
  // Самопочинка вебхука: без неё регистрация была бы ручным шагом с токеном
  // бота, а сбившийся вебхук пришлось бы замечать по молчанию бота.
  await reconcileWebhook(env, APP_URL);
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

// Общая постановка напоминания в ОЧЕРЕДЬ, а не прямая отправка.
//
// До ревью три прохода ниже звали sendMessage напрямую и слали В ГРУППОВОЙ ЧАТ
// текст с заголовком задачи. Это нарушало сразу два решения: ADR-4 (заголовок
// только в личку) и шаг 4d (тихие часы в ЕДИНСТВЕННОЙ точке отправки -- прямой
// вызов её обходил, и напоминание уходило в три часа ночи). Оба утверждения
// проверялись тестами только на пути создания задачи, поэтому дефект дожил до
// прода. Теперь у cron нет своего пути отправки вообще.
function queueReminder(
  env: Env,
  row: { task_id: string; org_id: string; user_id: string },
  text: string,
  kind: string,
  urgent: boolean,
): D1PreparedStatement {
  return env.DB.prepare(
    `INSERT INTO notifications (id, task_id, assignee_id, org_id, kind, payload, scheduled_at)
     VALUES (?, ?, ?, ?, ?, ?, ?)`,
  ).bind(uuid(), row.task_id, row.user_id, row.org_id, kind, JSON.stringify({
    recipient_user_id: row.user_id,
    text,
    delete_message_id: null,
    track: false,
    // Просрочка пробивает тихие часы: предупреждение после провала бесполезно.
    // Напоминание «за сутки» и «пора проверить» -- нет, они подождут до утра.
    urgent,
  }), nowIso());
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
    `SELECT a.id, a.due_at, a.user_id, t.id AS task_id, t.title, t.org_id, u.name AS responsible_name
     FROM task_assignees a
     JOIN tasks t ON t.id = a.task_id
     JOIN users u ON u.id = a.user_id
     JOIN projects p ON p.id = t.project_id
     WHERE a.state IN ('pending','accepted','rejected') AND a.due_at IS NOT NULL
       AND a.last_escalated_at IS NULL AND p.archived_at IS NULL
       -- Не только archived: при kind='any' задача закрывается ПЕРВЫМ сдавшим, а
       -- строки остальных остаются 'pending'. Без t.status <> 'done' им уходило
       -- бы «ВЫ ПРОСРОЧИЛИ» по работе, которую делать уже не надо.
       AND t.status NOT IN ('archived','done')`,
  ).all<{ id: string; due_at: string; user_id: string; task_id: string; title: string; org_id: string; responsible_name: string }>();

  const now = Date.now();
  const writes: D1PreparedStatement[] = [];
  for (const r of results) {
    const deadlineMs = Date.parse(r.due_at);
    if (!(deadlineMs < now)) continue; // ещё не просрочено
    writes.push(queueReminder(env, r,
      `⚠️ ВЫ ПРОСРОЧИЛИ ДЕДЛАЙН\n${r.responsible_name}, задача "${r.title}" просрочена на ${formatOverdue(now - deadlineMs)}.`,
      'overdue', true));
    // Флаг ставится вместе с постановкой в очередь, одним batch: очередь сама
    // отвечает за доставку и ретраи, поэтому «поставили, но не пометили» здесь
    // означало бы дубль на следующем тике.
    writes.push(env.DB.prepare('UPDATE task_assignees SET last_escalated_at = ? WHERE id = ?').bind(nowIso(), r.id));
  }
  if (writes.length) await env.DB.batch(writes);
}

// (c) Срок наступает в ближайшие сутки и ещё не наступил -- разовое
// предупреждение, отдельно от эскалации (та стреляет уже ПОСЛЕ срока).
async function remindApproachingDeadline(env: Env): Promise<void> {
  const { results } = await env.DB.prepare(
    `SELECT a.id, a.due_at, a.user_id, t.id AS task_id, t.title, t.org_id, u.name AS responsible_name
     FROM task_assignees a
     JOIN tasks t ON t.id = a.task_id
     JOIN users u ON u.id = a.user_id
     JOIN projects p ON p.id = t.project_id
     WHERE a.state IN ('pending','accepted','rejected') AND a.due_at IS NOT NULL
       AND a.reminder_sent_at IS NULL AND p.archived_at IS NULL
       AND t.status NOT IN ('archived','done')`,
  ).all<{ id: string; due_at: string; user_id: string; task_id: string; title: string; org_id: string; responsible_name: string }>();

  const now = Date.now();
  const writes: D1PreparedStatement[] = [];
  for (const r of results) {
    const deadlineMs = Date.parse(r.due_at);
    if (deadlineMs < now || deadlineMs - now > ONE_DAY_MS) continue;
    writes.push(queueReminder(env, r,
      `⏰ Дедлайн приближается\nЗадача "${r.title}" (${r.responsible_name}) должна быть готова менее чем через день.`,
      'due_soon', false));
    writes.push(env.DB.prepare('UPDATE task_assignees SET reminder_sent_at = ? WHERE id = ?').bind(nowIso(), r.id));
  }
  if (writes.length) await env.DB.batch(writes);
}

// (d) Сделано, но не проверено 2+ дня. Это упрёк ПРОВЕРЯЮЩЕМУ, не исполнителю:
// опоздание исполнителя судится по done_at против срока при подтверждении.
// Поэтому и адресат напоминания -- АВТОР задачи, а не тот, кто её сделал.
async function remindStaleReview(env: Env): Promise<void> {
  const { results } = await env.DB.prepare(
    `SELECT a.id, a.done_at, t.id AS task_id, t.title, t.org_id, t.author_id, u.name AS responsible_name
     FROM task_assignees a
     JOIN tasks t ON t.id = a.task_id
     JOIN users u ON u.id = a.user_id
     JOIN projects p ON p.id = t.project_id
     WHERE a.state = 'done' AND a.done_at IS NOT NULL
       AND a.review_reminded_at IS NULL AND p.archived_at IS NULL
       AND t.status <> 'archived' AND t.author_id IS NOT NULL
       -- confirmed_at IS NULL было в дофорковом коде и потерялось при переезде
       -- таймеров на строки: строки остаются 'done' и после приёмки, поэтому
       -- фильтр по состоянию строки подтверждение НЕ видит. Без этого условия
       -- директор получает «пора проверить» по задаче, которую сам принял --
       -- пре-мортем №2 дословно.
       AND t.confirmed_at IS NULL`,
  ).all<{ id: string; done_at: string; task_id: string; title: string; org_id: string; author_id: string; responsible_name: string }>();

  const now = Date.now();
  const writes: D1PreparedStatement[] = [];
  for (const r of results) {
    if (now - Date.parse(r.done_at) < REVIEW_WINDOW_MS) continue;
    writes.push(queueReminder(env, { task_id: r.task_id, org_id: r.org_id, user_id: r.author_id },
      `🔔 Пора проверить задачу\n"${r.title}" (${r.responsible_name}) выполнена более 2 дней назад и всё ещё не проверена.`,
      'stale_review', false));
    writes.push(env.DB.prepare('UPDATE task_assignees SET review_reminded_at = ? WHERE id = ?').bind(nowIso(), r.id));
  }
  if (writes.length) await env.DB.batch(writes);
}

function formatOverdue(ms: number): string {
  const mins = Math.floor(ms / 60000);
  const h = Math.floor(mins / 60);
  const m = mins % 60;
  if (h >= 24) return `${Math.floor(h / 24)}д ${h % 24}ч`;
  if (h > 0) return `${h}ч ${m}м`;
  return `${m}м`;
}
