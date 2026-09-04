// Проход отправки для outbox (шаг 1 плана).
//
// Отделён от перехода намеренно: переход атомарен, отправка -- нет. Проход
// идемпотентен по sent_at, поэтому его можно звать и сразу после запроса
// (тогда задержка та же, что была до outbox), и из cron как страховку за то,
// что первый вызов не дошёл.
import type { Env } from './types';
import { nowIso } from './db';
import { deleteMessage, sendMessage } from './telegram';

type Payload = { chat_id: string; text: string; delete_message_id: string | null; track: boolean };

const BATCH = 50;

/**
 * Отправляет все неотправленные уведомления. Возвращает число доставленных.
 * Строка помечается sent_at ТОЛЬКО после успешной отправки: не дошло -- следующий
 * проход попробует снова, а дубля не будет, потому что первый заход не пометил.
 */
export async function drainOutbox(env: Env): Promise<number> {
  const { results } = await env.DB.prepare(
    'SELECT id, task_id, payload FROM notifications WHERE sent_at IS NULL ORDER BY scheduled_at LIMIT ?',
  )
    .bind(BATCH)
    .all<{ id: string; task_id: string; payload: string }>();

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

    if (p.delete_message_id) await deleteMessage(env, p.chat_id, p.delete_message_id);
    const messageId = await sendMessage(env, p.chat_id, p.text);
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
