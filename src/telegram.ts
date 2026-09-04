// Thin Telegram Bot API wrapper. Best-effort: a down bot must not break task flow.
import type { Env } from './types';

// chatId is per-project (each project posts to its own group), never global.
export async function sendMessage(env: Env, chatId: string, text: string): Promise<string | null> {
  try {
    const res = await fetch(`https://api.telegram.org/bot${env.TELEGRAM_BOT_TOKEN}/sendMessage`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ chat_id: chatId, text }),
    });
    if (!res.ok) return null;
    const data = (await res.json()) as { result?: { message_id?: number } };
    return data.result?.message_id != null ? String(data.result.message_id) : null;
  } catch {
    return null;
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
