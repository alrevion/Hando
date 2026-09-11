// Черновики поручений.
//
// Задача не создаётся с голоса сразу. Фраза становится ЧЕРНОВИКОМ -- темой,
// адресатами, сроком и важностью, -- и человек видит, как его поняли, ещё до
// того, как поручение ушло кому-то. Создаёт задачу только «Создать»: разбор
// ошибается, и подтверждение -- самая главная кнопка.
//
// Черновик живёт в чате одной карточкой, которая редактируется на месте:
// поправка, кнопка срока, присланное фото -- всё меняет ту же карточку, а не
// плодит новые сообщения. Он не пропадает по таймеру: пять неподтверждённых
// черновиков -- это пять черновиков в «Черновиках», а не пять потерянных мыслей.
import type { Env } from './types';
import { nowIso, uuid } from './db';
import { formatWhen, type Draft } from './parse';
import type { Media } from './media';
import { createFromDraft } from './intake';
import { canAssign } from './hierarchy';
import { membershipRole } from './auth';
import { editMessageText, sendMessage, type InlineKeyboard } from './telegram';

export type DraftRow = {
  id: string;
  org_id: string;
  author_id: string;
  title: string;
  assignee_ids: string; // JSON
  deadline: string | null;
  priority: 'urgent' | 'medium' | 'low';
  description: string | null;
  priority_explicit: number;
  kind: 'single' | 'each' | 'any' | 'ack';
  heard: string;
  media: string; // JSON
  source: string;
  telegram_chat_id: string | null;
  telegram_message_id: string | null;
  created_at: string;
  updated_at: string;
};

export const PRIORITY_RU: Record<DraftRow['priority'], string> = { urgent: 'высокая', medium: 'средняя', low: 'низкая' };

export function assigneesOf(row: DraftRow): string[] {
  try { return JSON.parse(row.assignee_ids) as string[]; } catch { return []; }
}
export function mediaOf(row: DraftRow): Media[] {
  try { return JSON.parse(row.media) as Media[]; } catch { return []; }
}

export async function saveDraft(
  env: Env,
  who: { userId: string; orgId: string },
  draft: Draft,
  heard: string,
  media: Media[],
): Promise<DraftRow> {
  const id = uuid();
  const now = nowIso();
  await env.DB.prepare(
    `INSERT INTO drafts (id, org_id, author_id, title, description, assignee_ids, deadline, priority, priority_explicit, kind, heard, media, source, created_at, updated_at)
     VALUES (?, ?, ?, ?, NULL, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
  ).bind(
    id, who.orgId, who.userId, draft.title, JSON.stringify(draft.assigneeIds), draft.deadline,
    draft.priority, draft.priorityExplicit ? 1 : 0, draft.kind, heard.slice(0, 1000),
    JSON.stringify(media), draft.source, now, now,
  ).run();
  // СЧЁТЧИК ПРОМАХОВ. Черновик исчезает после подтверждения, а вопрос «как
  // часто правил не хватает» живёт месяцами: эта доля и решает, нужен ли
  // векторный слой. Считаем, а не логируем: фраза никуда не пишется.
  await env.DB.prepare(
    `INSERT INTO parse_stats (org_id, day, source, n) VALUES (?, ?, ?, 1)
     ON CONFLICT(org_id, day, source) DO UPDATE SET n = n + 1`,
  ).bind(who.orgId, now.slice(0, 10), draft.source).run();
  return (await getDraft(env, id))!;
}

export async function getDraft(env: Env, id: string): Promise<DraftRow | null> {
  return env.DB.prepare('SELECT * FROM drafts WHERE id = ?').bind(id).first<DraftRow>();
}

/** Черновик по карточке в чате -- чтобы ответ на неё стал правкой. */
export async function draftByMessage(env: Env, chatId: string, messageId: string): Promise<DraftRow | null> {
  return env.DB.prepare('SELECT * FROM drafts WHERE telegram_chat_id = ? AND telegram_message_id = ?')
    .bind(chatId, messageId).first<DraftRow>();
}

export async function listDrafts(env: Env, authorId: string, orgId: string): Promise<DraftRow[]> {
  const { results } = await env.DB
    .prepare('SELECT * FROM drafts WHERE author_id = ? AND org_id = ? ORDER BY created_at DESC')
    .bind(authorId, orgId).all<DraftRow>();
  return results;
}

/** Последний черновик человека -- к нему липнет фото без подписи. */
export async function latestDraft(env: Env, authorId: string, orgId: string): Promise<DraftRow | null> {
  return env.DB.prepare('SELECT * FROM drafts WHERE author_id = ? AND org_id = ? ORDER BY created_at DESC LIMIT 1')
    .bind(authorId, orgId).first<DraftRow>();
}

export type DraftPatch = Partial<{
  title: string;
  description: string | null;
  assigneeIds: string[];
  deadline: string | null;
  priority: DraftRow['priority'];
  priorityExplicit: boolean;
  kind: DraftRow['kind'];
  media: Media[];
  telegramChatId: string;
  telegramMessageId: string;
}>;

export async function patchDraft(env: Env, id: string, patch: DraftPatch): Promise<DraftRow | null> {
  const sets: string[] = [];
  const vals: unknown[] = [];
  const put = (col: string, v: unknown) => { sets.push(`${col} = ?`); vals.push(v); };
  if (patch.title !== undefined) put('title', patch.title);
  if (patch.description !== undefined) put('description', patch.description);
  if (patch.assigneeIds !== undefined) put('assignee_ids', JSON.stringify(patch.assigneeIds));
  if (patch.deadline !== undefined) put('deadline', patch.deadline);
  if (patch.priority !== undefined) put('priority', patch.priority);
  if (patch.priorityExplicit !== undefined) put('priority_explicit', patch.priorityExplicit ? 1 : 0);
  if (patch.kind !== undefined) put('kind', patch.kind);
  if (patch.media !== undefined) put('media', JSON.stringify(patch.media));
  if (patch.telegramChatId !== undefined) put('telegram_chat_id', patch.telegramChatId);
  if (patch.telegramMessageId !== undefined) put('telegram_message_id', patch.telegramMessageId);
  if (sets.length === 0) return getDraft(env, id);
  put('updated_at', nowIso());
  await env.DB.prepare(`UPDATE drafts SET ${sets.join(', ')} WHERE id = ?`).bind(...vals, id).run();
  return getDraft(env, id);
}

export async function removeDraft(env: Env, id: string): Promise<void> {
  await env.DB.prepare('DELETE FROM drafts WHERE id = ?').bind(id).run();
}

/**
 * Подтверждение: черновик становится задачей тем же путём, что и раньше
 * (createFromDraft), и исчезает. Возвращает id задачи или null, если класть
 * её некуда (человек ни на одной доске).
 */
/**
 * Можно ли автору поручить всем адресатам черновика -- по дереву (раздел 19)
 * и без замороженных. Проверяется ПРИ ПОДТВЕРЖДЕНИИ, а не только при разборе:
 * между черновиком и «Создать» человека могли заморозить или отозвать.
 */
export async function draftAssignable(env: Env, row: DraftRow): Promise<boolean> {
  const others = assigneesOf(row).filter((id) => id !== row.author_id);
  if (others.length === 0) return true;
  const role = await membershipRole(env.DB, row.org_id, row.author_id);
  if (!role) return false;
  return canAssign(env, row.org_id, row.author_id, role, others);
}

export async function confirmDraft(env: Env, row: DraftRow): Promise<string | null> {
  const draft: Draft = {
    title: row.title,
    assigneeIds: assigneesOf(row),
    deadline: row.deadline,
    priority: row.priority,
    priorityExplicit: row.priority_explicit === 1,
    kind: row.kind === 'any' ? 'each' : row.kind,
    source: row.source === 'llm' || row.source === 'fallback' ? row.source : 'pattern',
    ambiguous: [],
  };
  const taskId = await createFromDraft(env, { userId: row.author_id, orgId: row.org_id }, draft, mediaOf(row), row.heard, row.description);
  if (taskId) await removeDraft(env, row.id);
  return taskId;
}

// ------------------------------------------------------------ карточка


export async function draftText(env: Env, row: DraftRow, timeZone: string): Promise<string> {
  const ids = assigneesOf(row);
  const names = ids.length === 0 ? [] : (await env.DB.prepare(
    `SELECT id, name FROM users WHERE id IN (${ids.map(() => '?').join(',')})`,
  ).bind(...ids).all<{ id: string; name: string }>()).results.map((r) => r.name);
  const self = ids.length === 1 && ids[0] === row.author_id;
  const media = mediaOf(row);
  const files = media.filter((m) => !m.hasAudio).length;
  const lines = [
    '📝 Черновик',
    // Пустая тема бывает у черновика, рождённого из файла без подписи: спрашиваем
    // прямо, а не показываем прочерк, который человек прочитает как поломку.
    row.title.trim() ? `Тема: ${row.title}` : 'Тема: чего это касается? Напишите или наговорите',
    `Кому: ${self ? 'вам' : names.join(', ') || '—'}`,
    `Срок: ${row.deadline ? formatWhen(row.deadline, timeZone) : 'не указан'}`,
    `Важность: ${PRIORITY_RU[row.priority]}${row.priority_explicit ? '' : ' (не сказана)'}`,
  ];
  if (row.kind === 'ack') lines.push('Вид: ознакомиться -- «прочитал» и есть выполнение');
  if (files > 0) lines.push(`Вложений: ${files}`);
  // Что именно услышано -- чтобы «Иве» вместо «Еве» было видно сразу.
  if (row.heard) lines.push('', `Услышал: «${row.heard.length > 120 ? row.heard.slice(0, 117) + '…' : row.heard}»`);
  lines.push('', 'Ответьте на это сообщение, чтобы поправить; пришлите файл -- приложу.');
  return lines.join('\n');
}

/**
 * Кнопки карточки. Срок и важность предлагаются ТОЛЬКО если не были сказаны:
 * иначе кнопки заслоняли бы главную -- «Создать».
 */
export function draftKeyboard(row: DraftRow): InlineKeyboard {
  const rows: { text: string; callback_data: string }[][] = [[{ text: '✅ Создать', callback_data: `dc:${row.id}` }]];
  if (!row.deadline) {
    rows.push(
      [{ text: 'Сегодня', callback_data: `dd:${row.id}:t0` }, { text: 'Завтра', callback_data: `dd:${row.id}:t1` }],
      [{ text: 'В конце недели', callback_data: `dd:${row.id}:we` }, { text: '📅 Дата', callback_data: `dcal:${row.id}:` }],
    );
  }
  if (!row.priority_explicit) {
    rows.push([
      { text: '↓ Низкая', callback_data: `dp:${row.id}:l` },
      { text: 'Средняя', callback_data: `dp:${row.id}:m` },
      { text: '❗️ Высокая', callback_data: `dp:${row.id}:u` },
    ]);
  }
  rows.push([{ text: '✏️ Изменить', callback_data: `de:${row.id}` }, { text: '✖ Отменить', callback_data: `dx:${row.id}` }]);
  return { inline_keyboard: rows };
}

/**
 * Показать карточку: отредактировать существующую, если она есть в этом чате,
 * иначе отправить новую и запомнить её. «Черновики» из меню шлют новую копию
 * -- старая могла уехать далеко вверх.
 */
export async function renderDraft(env: Env, row: DraftRow, chatId: string, timeZone: string, fresh = false): Promise<void> {
  const text = await draftText(env, row, timeZone);
  const kb = draftKeyboard(row);
  if (!fresh && row.telegram_chat_id === chatId && row.telegram_message_id) {
    const ok = await editMessageText(env, chatId, row.telegram_message_id, text, kb);
    if (ok) return;
  }
  const messageId = await sendMessage(env, chatId, text, kb);
  if (messageId) await patchDraft(env, row.id, { telegramChatId: chatId, telegramMessageId: messageId });
}

/** Карточка после подтверждения: та же, но уже без кнопок и с галочкой. */
export async function renderCreated(env: Env, row: DraftRow, chatId: string, timeZone: string): Promise<void> {
  const ids = assigneesOf(row);
  const names = ids.length === 0 ? [] : (await env.DB.prepare(
    `SELECT name FROM users WHERE id IN (${ids.map(() => '?').join(',')})`,
  ).bind(...ids).all<{ name: string }>()).results.map((r) => r.name);
  const self = ids.length === 1 && ids[0] === row.author_id;
  const text = [
    `✅ ${row.title}`,
    `Кому: ${self ? 'вам' : names.join(', ') || '—'}`,
    `Срок: ${row.deadline ? formatWhen(row.deadline, timeZone) : 'не указан'}`,
    `Важность: ${PRIORITY_RU[row.priority]}`,
    row.deadline ? 'Напомню заранее.' : 'Без срока напоминаний не будет -- его можно поставить в приложении.',
  ].join('\n');
  if (row.telegram_chat_id === chatId && row.telegram_message_id) {
    if (await editMessageText(env, chatId, row.telegram_message_id, text)) return;
  }
  await sendMessage(env, chatId, text);
}

/**
 * Промах разбора -- знаменатель метрики пилота «сколько раз система поняла не
 * так». Раньше его отмечал человек командой /промах, и это не работало: команду
 * никто не набирал. Теперь сигнал берётся из самого действия -- ПОПРАВКИ
 * черновика: если человек что-то исправил, значит разобрали неверно.
 */
export async function logMiss(env: Env, userId: string, orgId: string): Promise<void> {
  await env.DB.prepare(
    `INSERT INTO events (id, actor_id, org_id, target_type, target_id, action, comment, overdue_by, created_at)
     VALUES (?, ?, ?, 'user', ?, 'miss', NULL, NULL, ?)`,
  ).bind(uuid(), userId, orgId, userId, nowIso()).run();
}
