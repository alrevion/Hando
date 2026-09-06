// Thin Telegram Bot API wrapper. Best-effort: a down bot must not break task flow.
import type { Env } from './types';

// Инлайновая клавиатура Telegram. Тип объявлен здесь, потому что подпись
// sendMessage его принимает уже сейчас, а прикрепление кнопок -- шаг 4a.
export type InlineKeyboard = { inline_keyboard: { text: string; callback_data: string }[][] };

// chatId is per-project (each project posts to its own group), never global.
//
// replyMarkup -- ПОДПИСЬ БЕЗ ЕДИНОГО ВЫЗОВА В ПРОДЕ, и это осознанно (шаг 1 плана).
// Кнопку нельзя показывать раньше шага 4a по двум причинам: до 4a нет входящего
// канала (index.ts регистрирует только /api, /mcp и статику, обработчика
// callback_query нет), поэтому нажатие крутило бы спиннер до таймаута; и
// сообщения уходят в ГРУППОВОЙ чат, где нажать может любой участник, а
// сопоставления telegram_user_id -> user_id до 4a не существует.
export async function sendMessage(env: Env, chatId: string, text: string, replyMarkup?: InlineKeyboard): Promise<string | null> {
  try {
    const res = await fetch(`https://api.telegram.org/bot${env.TELEGRAM_BOT_TOKEN}/sendMessage`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(replyMarkup ? { chat_id: chatId, text, reply_markup: replyMarkup } : { chat_id: chatId, text }),
    });
    if (!res.ok) return null;
    const data = (await res.json()) as { result?: { message_id?: number } };
    return data.result?.message_id != null ? String(data.result.message_id) : null;
  } catch {
    return null;
  }
}

// Гасит клавиатуру у уже отправленного сообщения -- чтобы нажатую кнопку нельзя
// было нажать второй раз. Тоже МЁРТВЫЙ КОД до шага 4a: гасить пока нечего,
// кнопок никто не отправляет. Существует здесь, чтобы на 4a добавлялся
// обработчик, а не заодно и транспорт.
export async function editMessageReplyMarkup(env: Env, chatId: string, messageId: string, replyMarkup?: InlineKeyboard): Promise<void> {
  try {
    await fetch(`https://api.telegram.org/bot${env.TELEGRAM_BOT_TOKEN}/editMessageReplyMarkup`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ chat_id: chatId, message_id: Number(messageId), reply_markup: replyMarkup ?? { inline_keyboard: [] } }),
    });
  } catch {
    // Best-effort, как и всё остальное здесь: лежащий бот не должен ронять поток задач.
  }
}

// Гасит спиннер у нажавшего. Обязателен на КАЖДОЕ нажатие, включая отвергнутые:
// без ответа Telegram крутит его до таймаута, и человек считает бота сломанным.
export async function answerCallbackQuery(env: Env, callbackQueryId: string, text?: string): Promise<void> {
  try {
    await fetch(`https://api.telegram.org/bot${env.TELEGRAM_BOT_TOKEN}/answerCallbackQuery`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(text ? { callback_query_id: callbackQueryId, text } : { callback_query_id: callbackQueryId }),
    });
  } catch {
    /* best-effort */
  }
}

/**
 * Правит текст и клавиатуру уже отправленного сообщения.
 *
 * Меню правится НА МЕСТЕ, а не пересылается: иначе каждое нажатие оставляет в
 * чате ещё одно одинаковое меню, и через минуту переписка состоит из них.
 */
export async function editMessageText(
  env: Env,
  chatId: string,
  messageId: string,
  text: string,
  replyMarkup?: InlineKeyboard,
): Promise<boolean> {
  try {
    const res = await fetch(`https://api.telegram.org/bot${env.TELEGRAM_BOT_TOKEN}/editMessageText`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ chat_id: chatId, message_id: Number(messageId), text, reply_markup: replyMarkup ?? { inline_keyboard: [] } }),
    });
    return res.ok;
  } catch {
    return false;
  }
}

export async function deleteMessage(env: Env, chatId: string, messageId: string): Promise<void> {
  try {
    await fetch(`https://api.telegram.org/bot${env.TELEGRAM_BOT_TOKEN}/deleteMessage`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ chat_id: chatId, message_id: Number(messageId) }),
    });
  } catch {
    /* best-effort */
  }
}

// Attachment upload/download are NOT best-effort: unlike notifications, losing
// or failing to serve a file is real data loss/inaccessibility, so these throw
// on failure and let the route handler surface a real error.

// Uploads a file to the storage chat as a document (never sendPhoto -- that
// re-compresses images). Returns the Telegram file_id (for later download) and
// message_id (so the message can be deleted when the attachment is removed).
export async function sendDocument(env: Env, chatId: string, file: Blob, filename: string): Promise<{ fileId: string; messageId: string }> {
  const form = new FormData();
  form.append('chat_id', chatId);
  form.append('document', file, filename);
  const res = await fetch(`https://api.telegram.org/bot${env.TELEGRAM_BOT_TOKEN}/sendDocument`, { method: 'POST', body: form });
  const data = (await res.json().catch(() => ({}))) as { ok?: boolean; result?: { message_id?: number; document?: { file_id?: string } } };
  const fileId = data.result?.document?.file_id;
  const messageId = data.result?.message_id;
  if (!res.ok || !data.ok || !fileId || messageId == null) throw new Error('telegram sendDocument failed');
  return { fileId, messageId: String(messageId) };
}

// Resolves a stored file_id to a fully-qualified download URL. Telegram file
// paths expire, so resolve fresh on each download rather than storing the URL.
export async function getFileUrl(env: Env, fileId: string): Promise<string> {
  const res = await fetch(`https://api.telegram.org/bot${env.TELEGRAM_BOT_TOKEN}/getFile`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ file_id: fileId }),
  });
  const data = (await res.json().catch(() => ({}))) as { ok?: boolean; result?: { file_path?: string } };
  const filePath = data.result?.file_path;
  if (!res.ok || !data.ok || !filePath) throw new Error('telegram getFile failed');
  return `https://api.telegram.org/file/bot${env.TELEGRAM_BOT_TOKEN}/${filePath}`;
}

/**
 * Переустанавливает вебхук на каждом тике cron.
 *
 * Всегда переустанавливаем, а не «только если URL отличается»: при совпадении
 * URL пропуск шага оставлял бы у Telegram СТАРЫЙ secret_token, если секрет
 * ротировали, -- и бот молча замолкал бы с 403 на каждом апдейте. Тот же
 * дефект уже ловили в telegram-otp.
 *
 * Секрета нет -- не регистрируем вовсе: вебхук без проверки секрета это
 * открытая дверь для любого, кто знает адрес воркера.
 */
export async function reconcileWebhook(env: Env, publicBaseUrl: string): Promise<void> {
  if (!env.TELEGRAM_BOT_TOKEN || !env.TELEGRAM_WEBHOOK_SECRET) return;
  try {
    await fetch(`https://api.telegram.org/bot${env.TELEGRAM_BOT_TOKEN}/setWebhook`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        url: `${publicBaseUrl}/tg/webhook`,
        secret_token: env.TELEGRAM_WEBHOOK_SECRET,
        allowed_updates: ['message', 'callback_query'],
      }),
    });
  } catch {
    /* best-effort: лежащий Telegram не должен ронять тик cron */
  }
}

async function chatExists(env: Env, chatId: string): Promise<boolean> {
  const res = await fetch(`https://api.telegram.org/bot${env.TELEGRAM_BOT_TOKEN}/getChat`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ chat_id: chatId }),
  });
  const data = (await res.json().catch(() => ({}))) as { ok?: boolean };
  return res.ok && data.ok === true;
}

// A raw Telegram group id (as copied from an id bot) needs a DIFFERENT prefix
// depending on the group's actual type: supergroups use "-100<id>", plain
// "group"-type chats (the default for a freshly created small group, until it
// grows or gets certain features enabled) use a single "-<id>". There's no way
// to tell which from the digits alone, so ask Telegram directly via getChat and
// use whichever form it recognizes -- silently guessing wrong would create a
// project whose notifications/attachments fail invisibly forever.
export async function resolveChatId(env: Env, rawGroupId: string): Promise<string | null> {
  const digits = rawGroupId.replace(/\D/g, '');
  if (!digits) return null;
  const supergroupId = `-100${digits}`;
  if (await chatExists(env, supergroupId)) return supergroupId;
  const groupId = `-${digits}`;
  if (await chatExists(env, groupId)) return groupId;
  return null;
}
