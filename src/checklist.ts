// Список пунктов внутри задачи: «купить свёклу, морковь, молоко».
//
// Одна задача, а не три: закрывается она целиком, но идти к этому можно по
// одному пункту. Хранится JSON-массивом в самой строке задачи -- отдельная
// таблица стоила бы ещё одного запроса на каждую карточку ради данных, которые
// всегда читаются вместе с задачей и всегда целиком.
//
// В боте список живёт ОТДЕЛЬНЫМ сообщением, а не кнопками под карточкой:
// пунктов бывает десяток, и карточка поручения превратилась бы в простыню, где
// «Принять» теряется среди морковок.
import type { Env, Task } from './types';
import { nowIso } from './db';
import { editMessageText, esc, sendMessage, type InlineButton } from './telegram';

export type Item = { t: string; d: string | null };

/** Пункты задачи. Битый JSON -- пустой список, а не падение карточки. */
export function itemsOf(task: { checklist?: string | null }): Item[] {
  if (!task.checklist) return [];
  try {
    const v = JSON.parse(task.checklist) as unknown;
    return Array.isArray(v)
      ? v.filter((x): x is Item => !!x && typeof (x as Item).t === 'string')
        .map((x) => ({ t: x.t, d: typeof x.d === 'string' ? x.d : null }))
      : [];
  } catch { return []; }
}

export const doneCount = (items: Item[]): number => items.filter((i) => i.d).length;

/**
 * Переключает пункт. Возвращает новый список или null, если индекс не тот:
 * сообщение со списком живёт в чате сколько угодно, а задачу за это время
 * могли поправить.
 */
export async function toggleItem(env: Env, task: Task, index: number, now = nowIso()): Promise<Item[] | null> {
  const items = itemsOf(task);
  if (index < 0 || index >= items.length) return null;
  items[index] = { t: items[index].t, d: items[index].d ? null : now };
  await env.DB.prepare('UPDATE tasks SET checklist = ?, updated_at = ? WHERE id = ? AND org_id = ?')
    .bind(JSON.stringify(items), now, task.id, task.org_id).run();
  return items;
}

/** Текст и кнопки списка. Кнопка на пункт -- нажал и он отмечен. */
export function render(task: { id: string; title: string }, items: Item[]): { text: string; keyboard: InlineButton[][] } {
  const text = [
    `🧾 <b>${esc(task.title)}</b>`,
    `Отмечено ${doneCount(items)} из ${items.length}`,
    '',
    ...items.map((i) => `${i.d ? '✅' : '⬜️'} ${esc(i.t)}`),
  ].join('\n');
  // По две в ряд: длинные названия в один ряд Telegram сжимает до нечитаемого,
  // а в столбик десяток пунктов занимает пол-экрана.
  const keyboard: InlineButton[][] = [];
  for (let i = 0; i < items.length; i += 2) {
    keyboard.push(items.slice(i, i + 2).map((item, j) => ({
      text: `${item.d ? '✅' : '⬜️'} ${item.t}`.slice(0, 40),
      callback_data: `ci:${task.id}:${i + j}`,
    })));
  }
  return { text, keyboard };
}

/** Показать список: правим прежнее сообщение, если оно то же самое. */
export async function show(env: Env, task: Task, chatId: string, messageId?: string | null): Promise<void> {
  const items = itemsOf(task);
  if (items.length === 0) return;
  const { text, keyboard } = render(task, items);
  if (messageId && await editMessageText(env, chatId, messageId, text, { inline_keyboard: keyboard }, true)) return;
  await sendMessage(env, chatId, text, { inline_keyboard: keyboard }, true);
}
