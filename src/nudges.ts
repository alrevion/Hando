// Личный слой: поводы (шаг 4c плана).
//
// Повод -- это инициатива системы, а не реакция на действие человека. Спека
// ограничивает её жёстко, и ограничения тут важнее самих поводов:
//   -- инициатива ТОЛЬКО про поручения другим, не про личные дела заказчика.
//      «Как продвигается ваш отпуск?» -- ровно то, чего он просил не делать;
//   -- не больше ДВУХ поводов в календарный день (в поясе организации);
//   -- каждый повод пишется в nudges, иначе три из пяти принятых метрик не
//      имеют знаменателя: они считаются по строкам, а не по сообщениям.
import type { Env } from './types';
import { openButton } from './transition';
import type { InlineButton } from './telegram';
import { nowIso, uuid } from './db';
import { localParts } from './quiet';

const DAILY_CAP = 2;

type Candidate = {
  orgId: string;
  userId: string;
  kind: 'stale_task' | 'unconfirmed';
  taskId: string;
  text: string;
  actionable: boolean;
  buttons?: InlineButton[][];
};

/** Сколько поводов человек уже получил СЕГОДНЯ в поясе своей организации. */
async function sentToday(env: Env, userId: string, timezone: string): Promise<number> {
  const { results } = await env.DB.prepare(
    'SELECT sent_at FROM nudges WHERE user_id = ? ORDER BY sent_at DESC LIMIT 20',
  ).bind(userId).all<{ sent_at: string }>();
  // «День» -- календарный в поясе организации, а не последние 24 часа: потолок
  // «2 в день» человек понимает именно так, и сутками скользящего окна он был бы
  // нарушен на глазах у пользователя.
  const today = localParts(new Date(), timezone);
  void today;
  const dayKey = (iso: string) => new Intl.DateTimeFormat('en-CA', { timeZone: timezone }).format(new Date(iso));
  const todayKey = new Intl.DateTimeFormat('en-CA', { timeZone: timezone }).format(new Date());
  return results.filter((r) => dayKey(r.sent_at) === todayKey).length;
}

/**
 * Поводы для АВТОРА поручения: что-то, что он поручил другим, требует его
 * внимания. Про личные дела человека система молчит -- это прямое требование
 * заказчика, а не осторожность.
 */
async function candidates(env: Env): Promise<Candidate[]> {
  const out: Candidate[] = [];

  // (1) Поручил -- никто не взял. Кнопка содержательная: «напомнить».
  const { results: stale } = await env.DB.prepare(
    `SELECT t.id, t.title, t.author_id, t.org_id, COUNT(a.id) AS pending
     FROM tasks t
     JOIN task_assignees a ON a.task_id = t.id AND a.state = 'pending'
     WHERE t.status = 'todo' AND t.author_id IS NOT NULL
       AND t.created_at < datetime('now', '-1 day')
     GROUP BY t.id`,
  ).all<{ id: string; title: string; author_id: string; org_id: string; pending: number }>();
  for (const r of stale) {
    out.push({
      orgId: r.org_id, userId: r.author_id, kind: 'stale_task', taskId: r.id,
      text: `⏳ Поручение «${r.title}» никто не взял (${r.pending} без ответа).`,
      actionable: true,
      buttons: [[{ text: '🔔 Напомнить', callback_data: `nudge_remind:${r.id}` }]],
    });
  }

  // (2) Сделано, но автор не проверил. Тоже про чужую работу, не про его дела.
  const { results: unconfirmed } = await env.DB.prepare(
    `SELECT t.id, t.title, t.author_id, t.org_id
     FROM tasks t
     WHERE t.status = 'done' AND t.confirmed_at IS NULL AND t.author_id IS NOT NULL
       AND t.done_at < datetime('now', '-2 day')`,
  ).all<{ id: string; title: string; author_id: string; org_id: string }>();
  for (const r of unconfirmed) {
    out.push({
      orgId: r.org_id, userId: r.author_id, kind: 'unconfirmed', taskId: r.id,
      text: `✅ «${r.title}» ждёт вашей проверки уже третий день.`,
      actionable: true,
      buttons: [[{ text: '✔️ Принять', callback_data: `nudge_confirm:${r.id}` }]],
    });
  }

  return out;
}

/**
 * Кладёт поводы в outbox и в nudges. Отправкой занимается drainOutbox -- значит
 * тихие часы действуют и на поводы, без отдельной проверки здесь.
 */
export async function enqueueNudges(env: Env): Promise<number> {
  const list = await candidates(env);
  let queued = 0;

  for (const c of list) {
    const tz = await env.DB.prepare("SELECT COALESCE(timezone,'Asia/Tashkent') AS tz FROM orgs WHERE id = ?")
      .bind(c.orgId).first<{ tz: string }>();
    const timezone = tz?.tz ?? 'Asia/Tashkent';

    // Потолок читается из БД на КАЖДОЙ итерации, а не из счётчика в памяти:
    // строки пишутся тут же, синхронно, поэтому запрос уже видит поставленные в
    // этом же проходе. Отдельный счётчик поверх этого давал бы двойной учёт --
    // и человек получал бы один повод вместо двух.
    if ((await sentToday(env, c.userId, timezone)) >= DAILY_CAP) continue;

    const now = nowIso();
    await env.DB.batch([
      env.DB.prepare(
        `INSERT INTO notifications (id, task_id, assignee_id, org_id, kind, payload, scheduled_at)
         VALUES (?, ?, ?, ?, ?, ?, ?)`,
      ).bind(uuid(), c.taskId, c.userId, c.orgId, `nudge_${c.kind}`, JSON.stringify({
        recipient_user_id: c.userId, text: c.text, delete_message_id: null, track: false,
        // Кнопка в саму задачу -- к каждому поводу: повод называет задачу, и
        // открыть её надо отсюда, а не поиском в приложении.
        keyboard: [...(c.buttons ?? []), [openButton(c.taskId)]],
      }), now),
      env.DB.prepare(
        'INSERT INTO nudges (id, org_id, user_id, kind, actionable, task_id, sent_at) VALUES (?, ?, ?, ?, ?, ?, ?)',
      ).bind(uuid(), c.orgId, c.userId, c.kind, c.actionable ? 1 : 0, c.taskId, now),
    ]);
    queued++;
  }
  return queued;
}
