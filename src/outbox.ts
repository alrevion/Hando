// Проход отправки для outbox (шаг 1 плана).
//
// Отделён от перехода намеренно: переход атомарен, отправка -- нет. Проход
// идемпотентен по sent_at, поэтому его можно звать и сразу после запроса
// (тогда задержка та же, что была до outbox), и из cron как страховку за то,
// что первый вызов не дошёл.
import type { Env } from './types';
import { nowIso } from './db';
import { deleteMessage, sendMessage } from './telegram';
import { isQuiet } from './quiet';

type Payload = {
  // Кому, а не куда: адрес резолвится при отправке -- см. transition.ts.
  recipient_user_id: string;
  text: string;
  delete_message_id: string | null;
  track: boolean;
  // Пробивает тихие часы: срок, наступающий ночью, важнее тишины.
  urgent?: boolean;
  keyboard?: { text: string; callback_data: string }[][] | null;
};

const BATCH = 50;

/**
 * Отправляет все неотправленные уведомления. Возвращает число доставленных.
 * Строка помечается sent_at ТОЛЬКО после успешной отправки: не дошло -- следующий
 * проход попробует снова, а дубля не будет, потому что первый заход не пометил.
 */
export async function drainOutbox(env: Env): Promise<number> {
  const { results } = await env.DB.prepare(
    `SELECT n.id, n.task_id, n.payload, COALESCE(o.timezone, 'Asia/Tashkent') AS timezone,
            COALESCE(o.quiet_hours, 1) AS quiet_hours
     FROM notifications n
     LEFT JOIN orgs o ON o.id = n.org_id
     WHERE n.sent_at IS NULL ORDER BY n.scheduled_at LIMIT ?`,
  )
    .bind(BATCH)
    .all<{ id: string; task_id: string; payload: string; timezone: string; quiet_hours: number }>();

  const now = new Date();

  let sent = 0;
  for (const row of results) {
    let p: Payload;
    try {
      p = JSON.parse(row.payload) as Payload;
    } catch {
      // Нечитаемый payload не починится ретраем -- гасим строку, чтобы она не
      // блокировала очередь навсегда, но следа не теряем.
      await env.DB.prepare("UPDATE notifications SET sent_at = ?, attempts = attempts + 1 WHERE id = ?").bind(nowIso(), row.id).run();
      continue;
    }

    // ЕДИНСТВЕННАЯ точка, где действуют тихие часы. Строка остаётся
    // неотправленной и уедет следующим проходом после 08:00 -- не теряется, а
    // ждёт. Пояс берётся у организации сообщения, а не сервера.
    if (row.quiet_hours === 1 && isQuiet(now, row.timezone, p.urgent === true)) continue;

    // Адрес резолвится СЕЙЧАС, а не при постановке: человек мог подключить бота
    // уже после неё. Не подключил -- строка ЖДЁТ (ADR-4: личка или ничего;
    // падать назад в групповой чат нельзя, это и есть закрываемая утечка).
    const to = await env.DB.prepare('SELECT telegram_user_id FROM users WHERE id = ?')
      .bind(p.recipient_user_id)
      .first<{ telegram_user_id: string | null }>();
    const chatId = to?.telegram_user_id;
    if (!chatId) continue;

    if (p.delete_message_id) await deleteMessage(env, chatId, p.delete_message_id);
    const messageId = await sendMessage(env, chatId, p.text, p.keyboard ? { inline_keyboard: p.keyboard } : undefined);
    if (messageId === null) {
      // sendMessage глотает ошибки и возвращает null -- различить «бот лежит» и
      // «чат не тот» здесь нельзя, поэтому просто считаем попытку.
      await env.DB.prepare('UPDATE notifications SET attempts = attempts + 1 WHERE id = ?').bind(row.id).run();
      continue;
    }

    const writes = [
      env.DB.prepare('UPDATE notifications SET sent_at = ?, attempts = attempts + 1 WHERE id = ?').bind(nowIso(), row.id),
    ];
    if (p.track) {
      // Единственная запись в tasks вне transition.ts, и она не про status:
      // id сообщения существует только после отправки, поэтому попасть в batch
      // перехода он физически не мог.
      writes.push(env.DB.prepare('UPDATE tasks SET telegram_message_id = ? WHERE id = ?').bind(messageId, row.task_id));
    }
    await env.DB.batch(writes);
    sent++;
  }
  return sent;
}
