// Помощник (раздел 23): собеседник, а не справка. Кнопки «Вопрос» в боте нет --
// бот сам решает по смыслу фразы, вопрос это или поручение. Знает, как
// пользоваться Hando, и видит задачи человека -- отвечает и на «как отметить
// выполненную?», и на «за что взяться?», задавая уточняющие вопросы.
import type { Env, Role } from './types';
import { formatWhen } from './parse';
import { nowIso } from './db';
import { loadSchedule } from './schedule';
import { applyTransition } from './transition';
import { drainOutbox } from './outbox';
import { recallAnswer, rememberAnswer } from './semantic';
import type { Task } from './types';

const GROQ = 'https://api.groq.com/openai/v1';

/** Краткое руководство -- то же, что человек прочитал бы в /start и подсказках. */
export const MANUAL = `Hando -- поручения голосом в Telegram.
Бот: напишите или наговорите поручение («Азизу завтра до трёх подготовить отчёт») -- появится черновик: тема, кому, срок, важность. Поправьте ответом на карточку или кнопками и нажмите «Создать». Черновики не пропадают: кнопка «Черновики».
Адресат получает карточку с кнопками: Принять · Не успею (с причиной) · Отказать (с причиной) · Открыть. «Готово» -- только в приложении.
Спрашивать можно прямо в боте, без всяких кнопок: вопрос -- отвечу, поручение -- заведу черновик, просьбу («удали …», «напомни …») -- выполню.
Удалить или отменить задачу: попросите меня («удали …») -- удаляю то, что вы поручили сами; или в приложении Поручения → задача → Удалить.
Приложение (кнопка меню слева от строки ввода): вкладки Поручения (что я поручил: стрелкой двигаю этап за исполнителя, принять/вернуть сданное, переназначить, удалить), Задачи (что поручили мне: «Взять в работу», «Готово», «Не успею», «Отказать»), Календарь, Ещё (Профиль, Люди с аналитикой, Организация: график, сводка, ссылка-приглашение; Черновики; Все задания; Уведомления; Вопрос).
Напоминания: не принято -- через час после постановки, а при сроке сегодня каждый час; за час до срока, за N минут (настройка человека) и в момент срока -- всегда; просрочено -- каждый час в рабочее время; сводка на день -- в начало рабочего дня.
Роли: владелец (всё), руководитель отдела (свои доски и те, кого пригласил), участник (свои доски). Приглашение -- личной ссылкой из Организации.`;

export type AskWho = { userId: string; orgId: string; role: Role; name: string };
export type AskTurn = { role: 'user' | 'assistant'; text: string };

type TaskLine = { id: string; title: string; due: string | null; priority: string; state: string; who: string; mine: boolean; authorMe: boolean };

/** Задачи человека: его собственные и те, что он поручил. Не больше сорока -- контекст не резиновый. */
async function myTasks(env: Env, who: AskWho): Promise<TaskLine[]> {
  const s = await loadSchedule(env, who.orgId);
  const { results } = await env.DB.prepare(
    `SELECT t.id, t.title, t.priority, t.author_id, a.state, a.due_at, a.user_id, u.name AS user_name
     FROM tasks t JOIN task_assignees a ON a.task_id = t.id JOIN users u ON u.id = a.user_id
     WHERE t.org_id = ? AND t.status IN ('todo','in_progress','done') AND (a.user_id = ? OR t.author_id = ?)
     ORDER BY a.due_at IS NULL, a.due_at LIMIT 40`,
  ).bind(who.orgId, who.userId, who.userId).all<{ id: string; title: string; priority: string; author_id: string | null; state: string; due_at: string | null; user_id: string; user_name: string }>();
  return results.map((r) => ({
    id: r.id,
    authorMe: r.author_id === who.userId,
    title: r.title,
    due: r.due_at ? formatWhen(r.due_at, s.timezone) : null,
    priority: r.priority === 'urgent' ? 'высокая' : r.priority === 'low' ? 'низкая' : 'средняя',
    state: r.state,
    who: r.user_id === who.userId ? 'я' : r.user_name,
    mine: r.user_id === who.userId,
  }));
}

/**
 * Удаляет по просьбе человека -- ТОЛЬКО то, что он вправе удалить: свои
 * поручения (автор) или любые, если он владелец. Тем же переходом, что кнопка
 * «Отменить» в боте и «Удалить» в приложении.
 */
async function deleteTasks(env: Env, who: AskWho, tasks: TaskLine[], ids: string[]): Promise<string[]> {
  const boss = who.role === 'creator' || who.role === 'super_admin';
  const allowed = new Set(tasks.filter((t) => t.authorMe || boss).map((t) => t.id));
  const titles: string[] = [];
  for (const id of new Set(ids)) {
    if (!allowed.has(id)) continue;
    const task = await env.DB.prepare('SELECT * FROM tasks WHERE id = ? AND org_id = ? AND status <> ?').bind(id, who.orgId, 'archived').first<Task>();
    if (!task) continue;
    await applyTransition(env, {
      task, to: 'archived', actorId: who.userId, action: 'deleted',
      set: { telegram_message_id: null },
      notify: { emoji: '🗑', label: 'Поручение отменено', deletePrevious: true },
    });
    titles.push(task.title);
  }
  if (titles.length) await drainOutbox(env);
  return titles;
}

/**
 * Толкнуть исполнителя: журнал напоминаний по задаче стирается, и ближайший
 * проход cron напомнит заново -- ровно то же, что кнопка «🔔 Напомнить» под
 * поводом. Отдельной рассылки в обход графика тут нет намеренно.
 */
async function remindTasks(env: Env, who: AskWho, tasks: TaskLine[], ids: string[]): Promise<string[]> {
  const mine = new Map(tasks.filter((t) => t.authorMe).map((t) => [t.id, t.title]));
  const titles: string[] = [];
  for (const id of new Set(ids)) {
    const title = mine.get(id);
    if (!title) continue;
    await env.DB.prepare(
      `DELETE FROM reminders WHERE kind IN ('not_accepted','overdue')
         AND assignee_row_id IN (SELECT id FROM task_assignees WHERE task_id = ? AND org_id = ?)`,
    ).bind(id, who.orgId).run();
    titles.push(title);
  }
  return titles;
}

/** Что именно просят -- по совпадению темы с текстом просьбы (путь без модели). */
function byTitle(tasks: TaskLine[], q: string): string[] {
  return tasks.filter((t) => t.title.length >= 4 && q.includes(t.title.toLowerCase())).map((t) => t.id);
}

const DELETE_ASK = /(удали|убери|отмени|снеси|сотри)/i;
const REMIND_ASK = /(напомни|поторопи|подтолкни)/i;

/** Без модели: честный ответ по руководству и список того, что ближе по сроку. */
async function fallback(env: Env, who: AskWho, question: string, tasks: TaskLine[]): Promise<string> {
  const q = question.toLowerCase();
  if (DELETE_ASK.test(q)) {
    const done = await deleteTasks(env, who, tasks, byTitle(tasks, q));
    if (done.length) return `Удалено: ${done.map((t) => `«${t}»`).join(', ')}.`;
    return 'Что именно удалить? Назовите тему задачи так, как она записана, — удалю то, что вы поручили сами.';
  }
  if (REMIND_ASK.test(q)) {
    const done = await remindTasks(env, who, tasks, byTitle(tasks, q));
    if (done.length) return `Напомню исполнителям: ${done.map((t) => `«${t}»`).join(', ')}.`;
    return 'По какой задаче напомнить? Назовите тему так, как она записана.';
  }
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

/** Просьба сделать, а не объяснить: такое из памяти отдавать нельзя -- надо выполнять. */
const ACTION_ASK = /(удали|убери|отмени|снеси|сотри|напомни|поторопи|подтолкни)/i;

/**
 * Не просочилось ли личное в ответ, который модель назвала общим. Вторая
 * проверка после самой модели: в общую память идут только ответы про
 * устройство Hando, и цена ошибки тут -- чужие задачи у постороннего.
 */
function isGeneral(answer: string, tasks: TaskLine[]): boolean {
  const low = answer.toLowerCase();
  for (const t of tasks) {
    if (t.title.length >= 4 && low.includes(t.title.toLowerCase())) return false;
    const firstName = t.who.split(/\s+/)[0]?.toLowerCase() ?? '';
    if (firstName.length >= 3 && low.includes(firstName)) return false;
  }
  return true;
}

export async function askAssistant(env: Env, who: AskWho, question: string, history: AskTurn[] = []): Promise<string> {
  const tasks = await myTasks(env, who);

  // ПАМЯТЬ ПО СМЫСЛУ. Вопрос про устройство Hando один и тот же у всех, сколько
  // бы разными словами его ни задавали: «как отметить выполненную» и «где
  // нажать что задача готова» -- 0.93 по замеру. Просьбы сделать (удали,
  // напомни) сюда не заходят: их надо выполнять, а не пересказывать.
  //
  // Продолжение диалога тоже мимо: «а если он откажется?» без предыдущей
  // реплики значит другое.
  const reusable = history.length === 0 && !ACTION_ASK.test(question);
  if (reusable) {
    const known = await recallAnswer(env, question);
    if (known) return known;
  }

  if (!env.GROQ_API_KEY) return fallback(env, who, question, tasks);
  const roleRu = who.role === 'creator' ? 'владелец' : who.role === 'member' ? 'участник' : 'руководитель отдела';
  const context = tasks.length
    ? tasks.map((t) => `- id=${t.id} · «${t.title}» · кому: ${t.who} · срок: ${t.due ?? 'нет'} · важность: ${t.priority} · состояние: ${t.state} · автор: ${t.authorMe ? 'я' : 'не я'}`).join('\n')
    : '(задач нет)';
  const system = [
    'Ты -- помощник в Hando, отвечаешь по-русски, коротко и по делу, как коллега.',
    'ФОРМАТ ОТВЕТА: строго JSON {"reply": "...", "delete": ["id", ...], "remind": ["id", ...], "general": true|false}. reply -- обычный текст для Telegram без разметки: ни звёздочек, ни подчёркиваний, ни решёток, ни обратных кавычек; списки -- строками с «•». delete -- id задач, которые человек ПРЯМО попросил удалить/убрать/отменить; remind -- id, по которым просят напомнить или поторопить исполнителя; оба поля иначе пустые. general -- true, если ответ объясняет устройство Hando и годится ЛЮБОМУ пользователю; false, если он опирается на задачи этого человека, называет их или его коллег. Трогать можно только задачи с «автор: я»; если просьба неоднозначна -- уточни в reply и оставь массивы пустыми. Не описывай, как сделать руками то, что можешь сделать сам.',
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
      // Размышление по объёму просьбы: короткое «за что взяться» ответа не
      // требует долгого, а разбор из десяти задач -- требует. Выше среднего не
      // поднимаем: ответ в чате ждут, а не читают через минуту.
      body: JSON.stringify({
        model: env.GROQ_LLM_MODEL || 'openai/gpt-oss-120b',
        messages, temperature: 0.3, max_tokens: 700,
        reasoning_effort: question.length > 120 || tasks.length > 8 ? 'medium' : 'low',
        response_format: { type: 'json_object' },
      }),
    });
    if (!res.ok) return fallback(env, who, question, tasks);
    const data = (await res.json()) as { choices?: { message?: { content?: string } }[] };
    const raw = data.choices?.[0]?.message?.content ?? '';
    let reply = '';
    let ids: string[] = [];
    let nudge: string[] = [];
    let general = false;
    try {
      const parsed = JSON.parse(raw) as { reply?: string; delete?: unknown; remind?: unknown; general?: unknown };
      general = parsed.general === true;
      reply = typeof parsed.reply === 'string' ? parsed.reply : '';
      const list = (v: unknown) => (Array.isArray(v) ? v.filter((x): x is string => typeof x === 'string') : []);
      ids = list(parsed.delete);
      nudge = list(parsed.remind);
    } catch {
      reply = raw; // модель ответила текстом -- тоже годится
    }
    const done = await deleteTasks(env, who, tasks, ids);
    const pushed = await remindTasks(env, who, tasks, nudge);
    const text = plain(reply);
    const lines = [text];
    if (done.length) lines.push(`Удалено: ${done.map((t) => `«${t}»`).join(', ')}.`);
    if (pushed.length) lines.push(`Напомню исполнителям: ${pushed.map((t) => `«${t}»`).join(', ')}.`);
    if (lines.length > 1) return lines.filter(Boolean).join('\n\n');
    if (!text) return fallback(env, who, question, tasks);
    // В общую память -- только объяснения устройства: модель пометила ответ
    // общим, и код отдельно убедился, что ни одной задачи и ни одного имени в
    // нём нет.
    if (reusable && general && isGeneral(text, tasks)) await rememberAnswer(env, question, text);
    return text;
  } catch {
    return fallback(env, who, question, tasks);
  }
}


// ------------------------------------------------------------ что это было
//
// Кнопки «Вопрос» в боте нет: одна и та же строка ввода принимает и поручение,
// и вопрос, и просьбу к боту. Решает намерение -- сначала дешёвые признаки, а
// спорное уходит модели. Ошибка не стоит ничего: под ответом висит «Это
// поручение», а под черновиком -- «Отменить».

export type Intent = 'ask' | 'task';

// Начинается с вопросительного слова -- вопрос. Заканчивается «?» -- тоже,
// если в фразе не назван человек: «Азизу подготовить отчёт?» -- поручение.
// \b здесь бесполезен: в JS он определён по [A-Za-z0-9_], и между кириллицей и
// пробелом границы слова НЕТ -- «напомни про отчёт» не совпадало вовсе. Границу
// задаёт «дальше не буква».
const EDGE = '(?![а-яёa-zA-Z])';
const QUESTION = new RegExp(`^(как|что|чего|чем|почему|зачем|где|куда|когда|сколько|какая|какие|какой|какое|кто|кому|можно|могу|можешь|умеешь|правда|а\\s+(?:что|как|кто|где|когда|почему))${EDGE}`, 'i');
// Просьба К БОТУ: он это делает сам, а не заводит поручение человеку.
const TO_BOT = new RegExp(`^(удали|удалить|убери|убрать|отмени|отменить|сотри|напомни|напомните|поторопи|подтолкни|покажи|показать|найди|перечисли|список)${EDGE}`, 'i');

/**
 * Отпечаток фразы: по нему ищется прежний разбор. Хранить сам текст нельзя --
 * таблица общая на всех арендаторов (см. миграцию 0023), и заголовок чужого
 * поручения в ней делать нечего.
 */
async function fingerprint(text: string): Promise<string> {
  const normal = text.toLowerCase().replace(/ё/g, 'е').replace(/[^а-яa-z0-9?]+/gi, ' ').trim();
  const bytes = new TextEncoder().encode(normal);
  const hash = await crypto.subtle.digest('SHA-256', bytes);
  return [...new Uint8Array(hash)].slice(0, 16).map((b) => b.toString(16).padStart(2, '0')).join('');
}

export async function classifyIntent(env: Env, text: string, hasName: boolean): Promise<Intent> {
  const t = text.trim();
  if (!t) return 'task';
  if (TO_BOT.test(t)) return 'ask';
  if (QUESTION.test(t)) return 'ask';
  if (t.endsWith('?') && !hasName) return 'ask';
  // Названный человек плюс глагол -- поручение, спрашивать модель не о чем.
  if (hasName) return 'task';
  if (!env.GROQ_API_KEY) return 'task';

  // ПАМЯТЬ: ту же фразу второй раз модели не носим. Первый случай -- новый,
  // дальше ответ берётся отсюда, и это единственное место, где слой окупается:
  // «спасибо», «ок», «что у меня сегодня» повторяются каждый день.
  const key = await fingerprint(text);
  const known = await env.DB.prepare('SELECT intent FROM intent_cache WHERE phrase = ?').bind(key)
    .first<{ intent: Intent }>().catch(() => null);
  if (known) {
    await env.DB.prepare('UPDATE intent_cache SET hits = hits + 1 WHERE phrase = ?').bind(key).run().catch(() => undefined);
    return known.intent;
  }

  try {
    const res = await fetch(`${GROQ}/chat/completions`, {
      method: 'POST',
      headers: { Authorization: `Bearer ${env.GROQ_API_KEY}`, 'Content-Type': 'application/json' },
      body: JSON.stringify({
        model: env.GROQ_LLM_MODEL || 'openai/gpt-oss-120b',
        temperature: 0,
        max_tokens: 20,
        response_format: { type: 'json_object' },
        messages: [
          {
            role: 'system',
            content: 'Определи, чего хочет человек в рабочем боте для поручений. Ответь строго JSON {"intent":"task"} или {"intent":"ask"}. task -- он ставит дело себе или кому-то: «купить бумагу до пятницы», «подготовить отчёт». ask -- вопрос о работе бота или о своих задачах, просьба к самому боту (удалить, напомнить, показать), рассуждение, уточнение, благодарность.',
          },
          { role: 'user', content: t.slice(0, 500) },
        ],
      }),
    });
    if (!res.ok) return 'task';
    const data = (await res.json()) as { choices?: { message?: { content?: string } }[] };
    const parsed = JSON.parse(data.choices?.[0]?.message?.content ?? '{}') as { intent?: string };
    const intent: Intent = parsed.intent === 'ask' ? 'ask' : 'task';
    await env.DB.prepare('INSERT INTO intent_cache (phrase, intent, created_at) VALUES (?, ?, ?) ON CONFLICT(phrase) DO NOTHING')
      .bind(key, intent, nowIso()).run().catch(() => undefined);
    return intent;
  } catch {
    // Не разобрали -- считаем поручением: черновик человек отменит одним
    // нажатием, а потерянная задача не восстановится никак.
    return 'task';
  }
}
