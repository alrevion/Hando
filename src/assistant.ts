// Помощник «Вопрос» (раздел 23): собеседник, а не справка. Знает, как
// пользоваться Hando, и видит задачи человека -- отвечает и на «как отметить
// выполненную?», и на «за что взяться?», задавая уточняющие вопросы.
import type { Env, Role } from './types';
import { formatWhen } from './parse';
import { loadSchedule } from './schedule';

const GROQ = 'https://api.groq.com/openai/v1';

/** Краткое руководство -- то же, что человек прочитал бы в /start и подсказках. */
export const MANUAL = `Hando -- поручения голосом в Telegram.
Бот: напишите или наговорите поручение («Азизу завтра до трёх подготовить отчёт») -- появится черновик: тема, кому, срок, важность. Поправьте ответом на карточку или кнопками и нажмите «Создать». Черновики не пропадают: кнопка «Черновики».
Адресат получает карточку с кнопками: Принять · Не успею (с причиной) · Отказать (с причиной) · Открыть. «Готово» -- только в приложении.
Приложение (кнопка меню слева от строки ввода): вкладки Поручения (что я поручил: этапы, принять/вернуть сданное, переназначить, удалить), Задачи (что поручили мне: «Взять в работу», «Готово», «Не успею», «Отказать»), Календарь, Ещё (Профиль, Люди с аналитикой, Организация: график, сводка, ссылка-приглашение; Черновики; Все задания; Уведомления; Вопрос).
Напоминания: не принято -- через час после постановки, а при сроке сегодня каждый час; за час до срока, за N минут (настройка человека) и в момент срока -- всегда; просрочено -- каждый час в рабочее время; сводка на день -- в начало рабочего дня.
Роли: владелец (всё), руководитель отдела (свои доски и те, кого пригласил), участник (свои доски). Приглашение -- личной ссылкой из Организации.`;

export type AskWho = { userId: string; orgId: string; role: Role; name: string };
export type AskTurn = { role: 'user' | 'assistant'; text: string };

type TaskLine = { title: string; due: string | null; priority: string; state: string; who: string; mine: boolean };

/** Задачи человека: его собственные и те, что он поручил. Не больше сорока -- контекст не резиновый. */
async function myTasks(env: Env, who: AskWho): Promise<TaskLine[]> {
  const s = await loadSchedule(env, who.orgId);
  const { results } = await env.DB.prepare(
    `SELECT t.title, t.priority, t.author_id, a.state, a.due_at, a.user_id, u.name AS user_name
     FROM tasks t JOIN task_assignees a ON a.task_id = t.id JOIN users u ON u.id = a.user_id
     WHERE t.org_id = ? AND t.status IN ('todo','in_progress','done') AND (a.user_id = ? OR t.author_id = ?)
     ORDER BY a.due_at IS NULL, a.due_at LIMIT 40`,
  ).bind(who.orgId, who.userId, who.userId).all<{ title: string; priority: string; author_id: string | null; state: string; due_at: string | null; user_id: string; user_name: string }>();
  return results.map((r) => ({
    title: r.title,
    due: r.due_at ? formatWhen(r.due_at, s.timezone) : null,
    priority: r.priority === 'urgent' ? 'высокая' : r.priority === 'low' ? 'низкая' : 'средняя',
    state: r.state,
    who: r.user_id === who.userId ? 'я' : r.user_name,
    mine: r.user_id === who.userId,
  }));
}

/** Без модели: честный ответ по руководству и список того, что ближе по сроку. */
function fallback(question: string, tasks: TaskLine[]): string {
  const q = question.toLowerCase();
  const mine = tasks.filter((t) => t.mine && t.state !== 'done' && t.state !== 'confirmed');
  if (/взять|начать|сначала|порядок|приоритет|горит/.test(q)) {
    if (mine.length === 0) return 'У вас нет открытых задач. Когда появятся, я предложу порядок по срокам и важности.';
    const lines = mine.slice(0, 5).map((t, i) => `${i + 1}. «${t.title}»${t.due ? ` — ${t.due}` : ''}${t.priority !== 'средняя' ? ` · ${t.priority}` : ''}`);
    return ['Начните с ближайшего по сроку и самого важного:', ...lines, '', 'Сколько времени займёт каждая? Скажите — уточню порядок.'].join('\n');
  }
  return `${MANUAL}\n\nСпросите подробнее: например, «как отметить выполненную?» или «за что взяться?».`;
}

/**
 * Снимает markdown, который модель ставит вопреки инструкции: Telegram без
 * parse_mode показывает **звёздочки** как есть, и ответ выглядит криво.
 */
export function plain(text: string): string {
  return text
    .replace(/\*\*(.+?)\*\*/g, '$1')
    .replace(/__(.+?)__/g, '$1')
    .replace(/(^|\s)\*(?!\s)(.+?)\*(?=\s|[.,;:!?)]|$)/g, '$1$2')
    .replace(/`([^`]*)`/g, '$1')
    .replace(/^\s{0,3}#{1,6}\s+/gm, '')
    .replace(/^\s*[-*]\s+/gm, '• ')
    .replace(/\n{3,}/g, '\n\n')
    .trim();
}

export async function askAssistant(env: Env, who: AskWho, question: string, history: AskTurn[] = []): Promise<string> {
  const tasks = await myTasks(env, who);
  if (!env.GROQ_API_KEY) return fallback(question, tasks);
  const roleRu = who.role === 'creator' ? 'владелец' : who.role === 'member' ? 'участник' : 'руководитель отдела';
  const context = tasks.length
    ? tasks.map((t) => `- «${t.title}» · кому: ${t.who} · срок: ${t.due ?? 'нет'} · важность: ${t.priority} · состояние: ${t.state}`).join('\n')
    : '(задач нет)';
  const system = [
    'Ты -- помощник в Hando, отвечаешь по-русски, коротко и по делу, как коллега.',
    'ФОРМАТ: обычный текст для Telegram. Никакой разметки: ни звёздочек, ни подчёркиваний, ни решёток, ни обратных кавычек. Списки -- строками, каждая начинается с «•».',
    'Два дела: (1) объяснить, как пользоваться Hando -- строго по руководству ниже, не выдумывай кнопок; (2) помочь спланировать -- по задачам человека ниже. Если для плана не хватает данных (сколько займёт, что важнее), задай ОДИН уточняющий вопрос, а не гадай.',
    `Человек: ${who.name}, роль: ${roleRu}.`,
    'РУКОВОДСТВО:\n' + MANUAL,
    'ЗАДАЧИ ЧЕЛОВЕКА (его и те, что он поручил):\n' + context,
  ].join('\n\n');
  const messages = [
    { role: 'system', content: system },
    ...history.slice(-6).map((h) => ({ role: h.role, content: h.text })),
    { role: 'user', content: question },
  ];
  try {
    const res = await fetch(`${GROQ}/chat/completions`, {
      method: 'POST',
      headers: { Authorization: `Bearer ${env.GROQ_API_KEY}`, 'Content-Type': 'application/json' },
      body: JSON.stringify({ model: env.GROQ_LLM_MODEL || 'openai/gpt-oss-120b', messages, temperature: 0.3, max_tokens: 600 }),
    });
    if (!res.ok) return fallback(question, tasks);
    const data = (await res.json()) as { choices?: { message?: { content?: string } }[] };
    const text = plain(data.choices?.[0]?.message?.content ?? '');
    return text || fallback(question, tasks);
  } catch {
    return fallback(question, tasks);
  }
}
