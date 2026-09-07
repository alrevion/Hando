// Входящий канал Telegram (шаг 4a плана) -- ТРЕТЬЯ дверь в систему.
//
// Первые две закрыты: /api сидит под requireAuth, /mcp -- под constant-time
// bearer. Эта дверь публичная и безкуковая, поэтому у неё собственная защита:
//   1) X-Telegram-Bot-Api-Secret-Token -- Telegram шлёт его на каждом апдейте;
//   2) резолв telegram_user_id -> user_id + org_id по БД.
//
// Монтируется в index.ts рядом с /mcp, а НЕ внутри apiRoutes. Причина не
// стилистическая: `apiRoutes.use('*', requireAuth)` накрывает всё, что
// зарегистрировано ниже, и вебхук получал бы 401. Telegram на 401 ретраит, а
// затем отключает вебхук -- отказ был бы тихим и обнаружился бы через сутки
// молчания бота.
//
// Неизвестный отправитель получает МОЛЧАНИЕ, а не «вы не зарегистрированы»:
// последнее -- оракул существования, ровно то, что запрещено для проектов.
import { Hono } from 'hono';
import type { Env, Role } from './types';
import { nowIso, uuid } from './db';
import { myAssignee, transitionAssignee } from './assignees';
import { answerCallbackQuery, editMessageReplyMarkup, sendMessage, type InlineKeyboard, editMessageText } from './telegram';
import { drainOutbox } from './outbox';
import { approveJoin, createOrg, ensureUser, joinByCode, pendingOrgFor, pendingRequests, rejectJoin } from './signup';
import { createFromDraft, setTaskDeadline } from './intake';
import {
  askNameScreen, BTN, confirmDeleteScreen, deleteOrg, getState, isOnboarded, leaveOrg,
  billingScreen, mainScreen, myOrgs, orgScreen, orgsScreen, profileScreen, renameOrg, setDisplayName,
  setState, switchOrg, type OrgRow, type Screen,
} from './menu';
import { download, extractMedia } from './media';
import { parseTask, transcribe, localIso, localToday } from './parse';
import { membershipRole, resolveOrgId } from './auth';
import { safeEqual } from './auth';

const enc = new TextEncoder();

export const botApp = new Hono<{ Bindings: Env }>();

type TgUser = { id: number; username?: string; first_name?: string; last_name?: string };
type Update = {
  // Медиа-поля описаны в media.ts; здесь они приходят как есть и передаются
  // туда через extractMedia -- дублировать их формы в двух местах незачем.
  message?: { chat: { id: number; type?: string }; from?: TgUser; text?: string; caption?: string };
  callback_query?: { id: string; from: TgUser; data?: string; message?: { chat: { id: number }; message_id: number } };
};

/** Кто это. null -- неизвестный, и тогда мы молчим. */
async function whoIs(env: Env, tg: TgUser): Promise<{ userId: string; orgId: string; role: Role } | null> {
  const row = await env.DB.prepare('SELECT id FROM users WHERE telegram_user_id = ?')
    .bind(String(tg.id))
    .first<{ id: string }>();
  if (!row) return null;
  const orgId = await resolveOrgId(env.DB, row.id);
  if (!orgId) return null;
  const role = await membershipRole(env.DB, orgId, row.id);
  if (!role) return null;
  return { userId: row.id, orgId, role };
}

/**
 * Подключение по одноразовой ссылке ?start=inv_xxxx.
 * Токен гасится сразу: ссылка одноразовая, иначе переслать её -- значит отдать
 * чужой доступ.
 */
async function connectByInvite(env: Env, tg: TgUser, token: string): Promise<string | null> {
  const row = await env.DB.prepare('SELECT id, name FROM users WHERE invite_token = ? AND telegram_user_id IS NULL')
    .bind(token)
    .first<{ id: string; name: string }>();
  if (!row) return null;
  await env.DB.prepare('UPDATE users SET telegram_user_id = ?, telegram_username = COALESCE(?, telegram_username), invite_token = NULL, connected_at = ? WHERE id = ?')
    .bind(String(tg.id), tg.username ?? null, nowIso(), row.id)
    .run();
  return row.name;
}

/**
 * Создаёт задачу из разобранной фразы и прикладывает медиа, если оно было.
 *
 * Доска выбирается ПЕРВОЙ из тех, где состоит автор: у бота нет экрана выбора
 * проекта, а поручение без доски существовать не может. Это осознанное
 * упрощение -- человек поправит на доске, если промахнулись.
 *
 * Всё пишется одним batch: задача, событие, адресаты и уведомления. Если файл
 * не сохранится, задача всё равно останется -- вложение это дополнение к
 * поручению, а не его условие.
 */
// ------------------------------------------------------------ срок кнопками
//
// У задачи без срока нет ни напоминания, ни просрочки -- она просто лежит.
// Просить человека переписать фразу целиком ради одного слова -- плохой обмен,
// поэтому срок ставится кнопками прямо под подтверждением.
//
// callback_data: «due:<taskId>:<что>» и «cal:<taskId>:<YYYY-MM>». Обе укладываются
// в предел Telegram в 64 байта -- 51 и 48 (см. test/callback-data.test.ts).
const DUE_HOUR = 18;
const MONTH_TITLE = ['Январь', 'Февраль', 'Март', 'Апрель', 'Май', 'Июнь', 'Июль', 'Август', 'Сентябрь', 'Октябрь', 'Ноябрь', 'Декабрь'];

/**
 * Быстрые сроки и срочность под подтверждением. «Свой срок» открывает календарь.
 *
 * Срочность здесь по той же причине, что и срок: она берётся из слов фразы, а
 * если слов не было -- остаётся средней, и поднять её было негде. В приложении
 * такие кнопки есть; правило «что можно там, можно и тут» требует их и здесь.
 */
function dueKeyboard(taskId: string): InlineKeyboard {
  return {
    inline_keyboard: [
      [
        { text: 'Сегодня', callback_data: `due:${taskId}:t0` },
        { text: 'Завтра', callback_data: `due:${taskId}:t1` },
      ],
      [
        { text: 'В конце недели', callback_data: `due:${taskId}:we` },
        { text: '📅 Свой срок', callback_data: `cal:${taskId}:` },
      ],
      [
        { text: '❗️ Срочно', callback_data: `pri:${taskId}:u` },
        { text: '↓ Не срочно', callback_data: `pri:${taskId}:l` },
      ],
    ],
  };
}

/**
 * Календарь месяца инлайновыми кнопками.
 *
 * Своя сетка, а не системный выбор даты: у ботов Telegram системного выбора нет
 * вовсе -- он есть только в мини-приложении, а ради одной даты гонять человека
 * в приложение и обратно дороже, чем нажать день прямо в переписке.
 */
function calendarKeyboard(taskId: string, y: number, m: number, today: { y: number; m: number; d: number }): InlineKeyboard {
  const first = new Date(Date.UTC(y, m - 1, 1));
  // Понедельник -- первый столбец: getUTCDay() считает от воскресенья.
  const lead = (first.getUTCDay() + 6) % 7;
  const days = new Date(Date.UTC(y, m, 0)).getUTCDate();

  const pad = (n: number) => String(n).padStart(2, '0');
  // Месяц и дата собираются В ПЕРЕМЕННУЮ до подстановки: в callback_data
  // помещается 64 байта, и правило «один идентификатор плюс одна короткая
  // строка» -- то, что проверяет test/callback-data.test.ts. Три подстановки в
  // одной строке это правило нарушают, даже если по факту коротки.
  const prevYm = m === 1 ? `${y - 1}-12` : `${y}-${pad(m - 1)}`;
  const nextYm = m === 12 ? `${y + 1}-01` : `${y}-${pad(m + 1)}`;

  const rows: { text: string; callback_data: string }[][] = [
    [
      { text: '‹', callback_data: `cal:${taskId}:${prevYm}` },
      { text: `${MONTH_TITLE[m - 1]} ${y}`, callback_data: `noop:${taskId}:` },
      { text: '›', callback_data: `cal:${taskId}:${nextYm}` },
    ],
    ['Пн', 'Вт', 'Ср', 'Чт', 'Пт', 'Сб', 'Вс'].map((w) => ({ text: w, callback_data: `noop:${taskId}:` })),
  ];

  let row: { text: string; callback_data: string }[] = Array.from({ length: lead }, () => ({ text: ' ', callback_data: `noop:${taskId}:` }));
  for (let d = 1; d <= days; d++) {
    const isToday = y === today.y && m === today.m && d === today.d;
    const ymd = `${y}-${pad(m)}-${pad(d)}`;
    row.push({ text: isToday ? `·${d}·` : String(d), callback_data: `due:${taskId}:${ymd}` });
    if (row.length === 7) { rows.push(row); row = []; }
  }
  if (row.length > 0) {
    while (row.length < 7) row.push({ text: ' ', callback_data: `noop:${taskId}:` });
    rows.push(row);
  }
  rows.push([{ text: '‹ Назад', callback_data: `cal:${taskId}:back` }]);
  return { inline_keyboard: rows };
}

/** «12 сентября, 18:00» -- срок словами в поясе организации. */
function formatWhen(iso: string, timeZone: string): string {
  const d = new Date(iso);
  if (Number.isNaN(d.getTime())) return iso;
  const day = new Intl.DateTimeFormat('ru-RU', { timeZone, weekday: 'long', day: 'numeric', month: 'long' }).format(d);
  const time = new Intl.DateTimeFormat('ru-RU', { timeZone, hour: '2-digit', minute: '2-digit', hour12: false }).format(d);
  return `${day}, ${time}`;
}

/**
 * «Мои поручения» -- то, что человек раздал другим, с состоянием каждого.
 *
 * Отдельно от «Моих задач» по смыслу: директор смотрит сюда, чтобы узнать, кто
 * на каком этапе, а не что делать самому. Свои же задачи (адресат = автор) сюда
 * не попадают -- они и так в «Моих задачах».
 */
async function assignedByMeText(env: Env, userId: string): Promise<string> {
  const { results } = await env.DB.prepare(
    `SELECT t.title, u.name AS who, a.state, a.due_at
     FROM tasks t
     JOIN task_assignees a ON a.task_id = t.id
     JOIN users u ON u.id = a.user_id
     JOIN org_memberships m ON m.org_id = a.org_id AND m.user_id = a.user_id AND m.left_at IS NULL
     WHERE t.author_id = ? AND a.user_id <> ? AND t.status <> 'archived'
     ORDER BY a.due_at IS NULL, a.due_at`,
  ).bind(userId, userId).all<{ title: string; who: string; state: string; due_at: string | null }>();

  if (!results.length) return 'Вы пока ничего не поручали.';
  const mark: Record<string, string> = {
    pending: '⏳ не принял', accepted: '🚀 в работе', done: '✅ сдал',
    confirmed: '✔️ принято', rejected: '❌ вернули', declined: '🚫 отказался',
  };
  return ['Ваши поручения:', ...results.map((r) =>
    `• ${r.title} — ${r.who}, ${mark[r.state] ?? r.state}${r.due_at ? ` (до ${r.due_at.slice(0, 10)})` : ''}`)].join('\n');
}

/**
 * «Моё» -- ОДИН список на человека, а не по одному на организацию: у него один
 * Telegram-аккаунт, и разделять список по арендаторам значило бы заставлять
 * переключаться, чтобы увидеть свой день целиком.
 */
async function myTasksText(env: Env, userId: string): Promise<string> {
  const { results } = await env.DB.prepare(
    `SELECT t.title, o.name AS org_name, a.due_at
     FROM task_assignees a
     JOIN tasks t ON t.id = a.task_id
     JOIN orgs o ON o.id = a.org_id
     -- Действующее членство обязательно: уволенный не должен видеть задачи
     -- бывшего работодателя. Строка task_assignees отзыв не переживает по
     -- смыслу, но физически остаётся -- задачи и события на неё ссылаются.
     JOIN org_memberships m ON m.org_id = a.org_id AND m.user_id = a.user_id AND m.left_at IS NULL
     WHERE a.user_id = ? AND a.state IN ('pending','accepted','rejected') AND t.status <> 'archived'
     ORDER BY a.due_at IS NULL, a.due_at`,
  ).bind(userId).all<{ title: string; org_name: string; due_at: string | null }>();

  return results.length
    ? ['Ваши задачи:', ...results.map((r) => `• ${r.title} — ${r.org_name}${r.due_at ? ` (до ${r.due_at.slice(0, 10)})` : ''}`)].join('\n')
    : 'Активных задач нет.';
}

/**
 * Показывает экран: текст плюс постоянная клавиатура внизу.
 *
 * Прежняя редакция правила сообщение на месте -- это было нужно инлайновой
 * клавиатуре, которая живёт ВНУТРИ сообщения. Постоянная клавиатура к сообщению
 * не привязана: она остаётся внизу экрана и переживает любой поток уведомлений.
 * Поэтому правки нет -- есть обычный ответ.
 */
async function show(env: Env, chatId: string, userId: string, screen: Screen): Promise<void> {
  await setState(env, userId, screen.state);
  await sendMessage(env, chatId, screen.text, screen.keyboard);
}

botApp.post('/webhook', async (c) => {
  // Секрет проверяется constant-time и ПЕРВЫМ: без него роут -- открытая дверь
  // для кого угодно, кто знает адрес воркера.
  const secret = c.env.TELEGRAM_WEBHOOK_SECRET;
  const got = c.req.header('x-telegram-bot-api-secret-token') ?? '';
  if (!secret || !safeEqual(enc.encode(got), enc.encode(secret))) {
    return c.json({ error: 'forbidden' }, 403);
  }

  const update = await c.req.json<Update>().catch(() => ({}) as Update);

  // ------------------------------------------------------------ нажатие кнопки
  if (update.callback_query) {
    const cq = update.callback_query;
    // answerCallbackQuery отправляется НА КАЖДОЕ нажатие, включая отвергнутые:
    // без него у нажавшего крутится спиннер до таймаута.
    const who = await whoIs(c.env, cq.from);
    if (!who) {
      await answerCallbackQuery(c.env, cq.id);
      return c.json({ ok: true });
    }

    const parts = (cq.data ?? '').split(':');
    const [action] = parts;

    // Заявки на вступление разбираются ОТДЕЛЬНО и раньше: у них второй сегмент
    // -- организация, а не задача, и загрузчик задачи их бы отверг.
    if (action === 'join_ok' || action === 'join_no') {
      // В кнопке только заявитель: «join_ok:» с ДВУМЯ UUID -- 81 байт, а предел
      // callback_data у Telegram 64, и он отвергал всё сообщение целиком.
      // Организация ищется по заявителю среди тех, где нажавший распоряжается.
      const applicantId = parts[1] ?? '';
      const orgId = applicantId ? await pendingOrgFor(c.env, who.userId, applicantId) : null;
      const done = !orgId ? false : action === 'join_ok'
        ? await approveJoin(c.env, who.userId, orgId, applicantId)
        : await rejectJoin(c.env, who.userId, orgId, applicantId);
      // Право подтверждать проверяется ВНУТРИ approveJoin/rejectJoin, а не
      // здесь: сообщение с кнопкой живёт в Telegram и может быть переслано
      // кому угодно.
      await answerCallbackQuery(c.env, cq.id, done ? (action === 'join_ok' ? 'Принят' : 'Отклонён') : 'Заявка недоступна');
      if (done && cq.message) await editMessageReplyMarkup(c.env, String(cq.message.chat.id), String(cq.message.message_id));
      if (done && action === 'join_ok') {
        const tg = await c.env.DB.prepare('SELECT telegram_user_id FROM users WHERE id = ?').bind(applicantId).first<{ telegram_user_id: string | null }>();
        if (tg?.telegram_user_id) await sendMessage(c.env, tg.telegram_user_id, 'Вас приняли. /moe -- ваши задачи.');
      }
      return c.json({ ok: true });
    }

    const taskId = parts[1];
    const task = taskId
      ? await c.env.DB.prepare('SELECT * FROM tasks WHERE id = ? AND org_id = ?').bind(taskId, who.orgId).first<import('./types').Task>()
      : null;
    if (!task) {
      await answerCallbackQuery(c.env, cq.id, 'Задача недоступна');
      return c.json({ ok: true });
    }

    // Ветка поводов идёт ДО проверки «ты адресат» намеренно: повод адресован
    // АВТОРУ поручения, а он обычно не входит в список исполнителей. Проверка
    // адресата выше отбивала бы собственные кнопки автора.
    // Нажатие отмечается в nudges: без acted_at метрика «доля
    // поводов без нажатия за сутки» не имеет числителя.
    if (action === 'nudge_remind' || action === 'nudge_confirm') {
      await c.env.DB.prepare(
        'UPDATE nudges SET acted_at = ? WHERE user_id = ? AND task_id = ? AND acted_at IS NULL',
      ).bind(nowIso(), who.userId, task.id).run();

      // Гейт -- на ОБЕ кнопки, а не только на «принять». Повод адресован автору,
      // но кнопку можно переслать или подделать callback_data. Без гейта любой
      // член организации сбрасывал бы флаг эскалации по любой задаче, и
      // исполнители получали бы повторные «ВЫ ПРОСРОЧИЛИ» -- причём срочные, то
      // есть сквозь тихие часы, и сколько угодно раз.
      if (task.author_id !== who.userId) {
        await answerCallbackQuery(c.env, cq.id, 'Это не ваше поручение');
        return c.json({ ok: true });
      }

      if (action === 'nudge_confirm') {
        // Те же гейты, что у POST /tasks/:id/confirm: иначе с кнопки можно
        // подтвердить недоделанную или уже подтверждённую задачу.
        if (task.status !== 'done' || task.confirmed_at) {
          await answerCallbackQuery(c.env, cq.id, 'Задача ещё не сдана');
          return c.json({ ok: true });
        }
        await c.env.DB.prepare('UPDATE tasks SET confirmed_at = ? WHERE id = ? AND org_id = ?')
          .bind(nowIso(), task.id, who.orgId).run();
        await answerCallbackQuery(c.env, cq.id, 'Принято');
      } else {
        await answerCallbackQuery(c.env, cq.id, 'Напомним исполнителям');
        // Сброс флага эскалации -- повторное напоминание пойдёт штатным проходом
        // cron, а не отдельной рассылкой в обход тихих часов.
        await c.env.DB.prepare(
          "UPDATE task_assignees SET last_escalated_at = NULL WHERE task_id = ? AND org_id = ? AND state = 'pending'",
        ).bind(task.id, who.orgId).run();
      }
      if (cq.message) await editMessageReplyMarkup(c.env, String(cq.message.chat.id), String(cq.message.message_id));
      await drainOutbox(c.env);
      return c.json({ ok: true });
    }

    // --------------------------------------------------------- срочность
    if (action === 'pri') {
      if (task.author_id !== who.userId) {
        await answerCallbackQuery(c.env, cq.id, 'Это не ваше поручение');
        return c.json({ ok: true });
      }
      const map: Record<string, string> = { u: 'urgent', m: 'medium', l: 'low' };
      const priority = map[parts[2] ?? ''];
      if (!priority) {
        await answerCallbackQuery(c.env, cq.id);
        return c.json({ ok: true });
      }
      await c.env.DB.prepare('UPDATE tasks SET priority = ?, updated_at = ? WHERE id = ? AND org_id = ?')
        .bind(priority, nowIso(), task.id, who.orgId).run();
      await answerCallbackQuery(c.env, cq.id, priority === 'urgent' ? 'Срочная' : 'Не срочная');
      return c.json({ ok: true });
    }

    // ------------------------------------------------------------ срок
    if (action === 'due' || action === 'cal' || action === 'noop') {
      if (action === 'noop') {
        // Подпись месяца и дни недели -- не кнопки; без ответа у нажавшего
        // крутится спиннер до таймаута.
        await answerCallbackQuery(c.env, cq.id);
        return c.json({ ok: true });
      }
      // Срок ставит АВТОР: это его поручение и его требование к дате.
      if (task.author_id !== who.userId) {
        await answerCallbackQuery(c.env, cq.id, 'Это не ваше поручение');
        return c.json({ ok: true });
      }
      const org = await c.env.DB.prepare('SELECT timezone FROM orgs WHERE id = ?').bind(who.orgId).first<{ timezone: string }>();
      const tz = org?.timezone ?? 'Asia/Tashkent';
      const today = localToday(new Date(), tz);
      const chatId = cq.message ? String(cq.message.chat.id) : null;
      const messageId = cq.message ? String(cq.message.message_id) : null;

      if (action === 'cal') {
        const arg = parts[2] ?? '';
        // «Назад» возвращает быстрые кнопки, пустое значение открывает текущий
        // месяц, «YYYY-MM» -- листание.
        const kb = arg === 'back'
          ? dueKeyboard(task.id)
          : (() => {
              const [y, m] = arg ? arg.split('-').map(Number) : [today.y, today.m];
              return calendarKeyboard(task.id, y || today.y, m || today.m, today);
            })();
        await answerCallbackQuery(c.env, cq.id);
        if (chatId && messageId) await editMessageReplyMarkup(c.env, chatId, messageId, kb);
        return c.json({ ok: true });
      }

      const arg = parts[2] ?? '';
      const iso = arg === 't0' ? localIso(today.y, today.m, today.d, DUE_HOUR, tz)
        : arg === 't1' ? (() => { const d = new Date(Date.UTC(today.y, today.m - 1, today.d + 1)); return localIso(d.getUTCFullYear(), d.getUTCMonth() + 1, d.getUTCDate(), DUE_HOUR, tz); })()
        : arg === 'we' ? (() => {
            // «Конец недели» -- ближайшая пятница, включая сегодняшнюю: сказанное
            // в пятницу «к концу недели» означает этот же день, а не следующий.
            const base = new Date(Date.UTC(today.y, today.m - 1, today.d));
            const delta = (5 - ((base.getUTCDay() + 6) % 7) + 7) % 7;
            const d = new Date(base.getTime() + delta * 864e5);
            return localIso(d.getUTCFullYear(), d.getUTCMonth() + 1, d.getUTCDate(), DUE_HOUR, tz);
          })()
        : /^\d{4}-\d{2}-\d{2}$/.test(arg) ? (() => { const [y, m, d] = arg.split('-').map(Number); return localIso(y, m, d, DUE_HOUR, tz); })()
        : null;

      if (!iso) {
        await answerCallbackQuery(c.env, cq.id);
        return c.json({ ok: true });
      }

      await setTaskDeadline(c.env, task.id, who.orgId, iso);
      await answerCallbackQuery(c.env, cq.id, 'Срок поставлен');
      if (chatId && messageId) {
        await editMessageText(c.env, chatId, messageId, [
          `✅ ${task.title}`,
          `Срок: ${formatWhen(iso, tz)}`,
          'Напомню за день до срока.',
        ].join('\n'));
      }
      await drainOutbox(c.env);
      return c.json({ ok: true });
    }

    // Сообщение уходит в ЛИЧКУ адресата (ADR-4), но нажать всё равно может
    // только тот, у кого есть своя строка: пересланное сообщение кнопку не
    // делает чужой.
    const mine = await myAssignee(c.env, task.id, who.userId, who.orgId);
    if (!mine) {
      await answerCallbackQuery(c.env, cq.id, 'Это не ваше поручение');
      return c.json({ ok: true });
    }

    const target = action === 'accept' ? 'accepted' : action === 'done' ? 'done' : null;
    if (!target) {
      await answerCallbackQuery(c.env, cq.id);
      return c.json({ ok: true });
    }

    const res = await transitionAssignee(c.env, {
      task, assignee: mine, to: target, actorId: who.userId,
      notify: target === 'accepted'
        ? { emoji: '🚀', label: 'В работе', track: true }
        : { emoji: '✅', label: 'Готово', deletePrevious: true },
    });
    await answerCallbackQuery(c.env, cq.id, res.ok ? (target === 'accepted' ? 'Принято' : 'Отмечено готовым') : 'Уже нельзя');

    // Клавиатура гасится РОВНО ОДИН РАЗ на переход: иначе ту же кнопку можно
    // нажать второй раз, и человек увидит «уже нельзя» на собственное действие.
    if (res.ok && cq.message) {
      await editMessageReplyMarkup(c.env, String(cq.message.chat.id), String(cq.message.message_id));
    }
    await drainOutbox(c.env);
    return c.json({ ok: true });
  }

  // ------------------------------------------------------------ текст
  const msg = update.message;
  if (!msg?.from) return c.json({ ok: true });

  // ЛИЧНЫЙ СЛОЙ -- ТОЛЬКО В ЛИЧКЕ.
  //
  // Бот состоит в групповых чатах проектов, а Telegram доставляет ему сообщения
  // со слэша даже при включённом privacy mode. Ответ шёл по адресу входящего
  // сообщения, поэтому «/moe», набранное в группе школы, печатало туда задачи
  // человека ИЗ ВСЕХ его организаций -- вместе с их названиями. Это ровно та
  // утечка, ради закрытия которой ADR-4 убрал заголовки из групп, и она
  // обходила закрытие: bot.ts -- второй путь отправки, мимо outbox.
  //
  // В группе бот просто молчит: объяснять, почему он не отвечает, значило бы
  // подтверждать, что человек в системе есть.
  if (msg.chat.type !== 'private' && msg.chat.id !== msg.from.id) return c.json({ ok: true });

  const start = msg.text?.match(/^\/start\s+(\S+)/);
  if (start) {
    const name = await connectByInvite(c.env, msg.from, start[1]);
    if (name) {
      await sendMessage(c.env, String(msg.chat.id), `Здравствуйте, ${name}. Бот подключён.`);
      // Накопленное за время до подключения уедет сразу: строки ждали в очереди
      // именно этого (ADR-4 запрещает падать назад в групповой чат).
      await drainOutbox(c.env);
    }
    // Неверный токен -- молчание: подтверждение «такой ссылки нет» позволило бы
    // перебирать токены и узнавать, какие существуют.
    return c.json({ ok: true });
  }

  // ------------------------------------------------------- авторегистрация
  //
  // ВАЖНО: эта ветка идёт ДО whoIs, потому что регистрируется как раз тот, кого
  // whoIs не находит. Прежнее правило «неизвестному -- молчание» защищало от
  // оракула существования и здесь СНЯТО осознанно: без ответа незнакомцу
  // регистрация невозможна в принципе. Оракула не возникает -- предложение
  // зарегистрироваться одинаково для всех и не подтверждает ничьего наличия.
  const text = (msg.text ?? '').trim();
  const tgName = [msg.from.first_name, msg.from.last_name].filter(Boolean).join(' ') || msg.from.username || 'Без имени';

  const userId = await ensureUser(c.env, String(msg.from.id), tgName, msg.from.username ?? null);
  const chatId = String(msg.chat.id);
  const st = await getState(c.env, userId);
  const orgs = await myOrgs(c.env, userId);
  const me = await c.env.DB.prepare('SELECT name FROM users WHERE id = ?').bind(userId).first<{ name: string }>();
  const myName = me?.name ?? tgName;

  // ------------------------------------------------------------- знакомство
  //
  // Имя из Telegram для обращения не годится: там латиница, никнейм или пусто.
  // А имя видят коллеги в поручениях. Спрашиваем один раз.
  if (text === '/start' || text === '/начать' || text === '/menu' || text === '/меню') {
    await show(c.env, chatId, userId, (await isOnboarded(c.env, userId))
      ? mainScreen(myName, orgs)
      : askNameScreen());
    return c.json({ ok: true });
  }
  if (!(await isOnboarded(c.env, userId))) {
    if (!text) return c.json({ ok: true });
    if (!(await setDisplayName(c.env, userId, text))) {
      await show(c.env, chatId, userId, askNameScreen());
      return c.json({ ok: true });
    }
    await sendMessage(c.env, chatId, `Приятно познакомиться, ${text.trim()}.`);
    await show(c.env, chatId, userId, mainScreen(text.trim(), await myOrgs(c.env, userId)));
    return c.json({ ok: true });
  }

  // ------------------------------------------------- ответ на вопрос бота
  //
  // Печатать приходится только то, чего бот знать не может: имя, название
  // организации или код. Всё остальное -- кнопки.
  if (st.await && text) {
    if (st.await === 'name') {
      const ok = await setDisplayName(c.env, userId, text);
      await sendMessage(c.env, chatId, ok ? 'Имя обновлено.' : 'Слишком короткое имя.');
      await show(c.env, chatId, userId, profileScreen(ok ? text.trim() : myName, orgs));
      return c.json({ ok: true });
    }
    if (st.await === 'new') {
      const { code } = await createOrg(c.env, userId, text.slice(0, 60));
      await sendMessage(c.env, chatId, [
        `Организация «${text.slice(0, 60)}» создана. Вы её владелец.`,
        '',
        `Код для сотрудников: ${code}`,
        'Каждого вступившего Вы подтверждаете кнопкой.',
      ].join('\n'));
      await show(c.env, chatId, userId, mainScreen(myName, await myOrgs(c.env, userId)));
      return c.json({ ok: true });
    }
    if (st.await === 'rename' && st.org) {
      const ok = await renameOrg(c.env, userId, st.org, text);
      await sendMessage(c.env, chatId, ok ? 'Переименовано.' : 'Переименовать не удалось.');
      await show(c.env, chatId, userId, orgsScreen(await myOrgs(c.env, userId)));
      return c.json({ ok: true });
    }
    // st.await === 'join'
    const res = await joinByCode(c.env, userId, text);
    if (!res.ok) {
      await sendMessage(c.env, chatId,
        res.reason === 'unknown_code' ? 'Код не подошёл. Проверьте у того, кто его дал.'
        : res.reason === 'already_member' ? 'Вы уже в этой организации.'
        : 'Заявка уже подана, ждём подтверждения.');
      await show(c.env, chatId, userId, mainScreen(myName, orgs));
      return c.json({ ok: true });
    }
    await sendMessage(c.env, chatId, `Заявка в «${res.orgName}» отправлена. Ждём подтверждения.`);
    if (res.ownerTgId) {
      // Заявка -- инлайновой клавиатурой НАМЕРЕННО: кнопка привязана к этому
      // человеку и к этой заявке, а не к навигации.
      await sendMessage(c.env, res.ownerTgId, `К Вам просится: ${res.applicantName}`, {
        inline_keyboard: [[
          { text: '✅ Принять', callback_data: `join_ok:${userId}` },
          { text: '✖️ Отклонить', callback_data: `join_no:${userId}` },
        ]],
      });
    }
    return c.json({ ok: true });
  }

  // ------------------------------------------------------- нажатия клавиатуры
  //
  // Reply-кнопка присылает свой текст, поэтому нажатие -- это совпадение с
  // подписью. Экран учитывается: «‹ Назад» на разных экранах ведёт в разное.
  const openOrg = async (org: OrgRow) =>
    show(c.env, chatId, userId, orgScreen(org, userId, (await pendingRequests(c.env, org.id)).length));
  const current = st.org ? orgs.find((o) => o.id === st.org) : undefined;

  switch (text) {
    case BTN.tasks:
      await sendMessage(c.env, chatId, await myTasksText(c.env, userId));
      return c.json({ ok: true });
    case BTN.assigned:
      await sendMessage(c.env, chatId, await assignedByMeText(c.env, userId));
      return c.json({ ok: true });
    case BTN.billing:
      await show(c.env, chatId, userId, billingScreen(orgs, userId));
      return c.json({ ok: true });
    case BTN.orgs:
      await show(c.env, chatId, userId, orgsScreen(orgs));
      return c.json({ ok: true });
    case BTN.profile:
      await show(c.env, chatId, userId, profileScreen(myName, orgs));
      return c.json({ ok: true });
    case BTN.editName:
      await setState(c.env, userId, { await: 'name', screen: 'profile' });
      await sendMessage(c.env, chatId, 'Как к Вам обращаться? Напишите имя и фамилию.');
      return c.json({ ok: true });
    case BTN.create:
    case BTN.createShort:
      await setState(c.env, userId, { await: 'new', screen: st.screen });
      await sendMessage(c.env, chatId, 'Как назвать организацию?');
      return c.json({ ok: true });
    case BTN.join:
    case BTN.joinShort:
      await setState(c.env, userId, { await: 'join', screen: st.screen });
      await sendMessage(c.env, chatId, 'Пришлите код организации.');
      return c.json({ ok: true });
    case BTN.back:
      // «Назад» зависит от экрана: из карточки -- в список, иначе на главный.
      await show(c.env, chatId, userId, st.screen === 'org' || st.screen === 'confirm_delete'
        ? orgsScreen(orgs)
        : mainScreen(myName, orgs));
      return c.json({ ok: true });
    case BTN.switch:
      if (current && (await switchOrg(c.env, userId, current.id))) {
        await show(c.env, chatId, userId, mainScreen(myName, await myOrgs(c.env, userId)));
      }
      return c.json({ ok: true });
    case BTN.requests: {
      if (!current) return c.json({ ok: true });
      const list = await pendingRequests(c.env, current.id);
      if (list.length === 0) {
        await sendMessage(c.env, chatId, 'Заявок нет.');
        return c.json({ ok: true });
      }
      // По сообщению на заявку: кнопка привязана к человеку, а не к экрану, и
      // должна жить при своём сообщении -- как и кнопки на задаче.
      for (const r of list) {
        await sendMessage(c.env, chatId, `Просится: ${r.name}${r.telegram_username ? ` (@${r.telegram_username})` : ''}`, {
          inline_keyboard: [[
            { text: '✅ Принять', callback_data: `join_ok:${r.user_id}` },
            { text: '✖️ Отклонить', callback_data: `join_no:${r.user_id}` },
          ]],
        });
      }
      return c.json({ ok: true });
    }
    case BTN.rename:
      if (current) {
        await setState(c.env, userId, { await: 'rename', screen: 'org', org: current.id });
        await sendMessage(c.env, chatId, `Новое название для «${current.name}»?`);
      }
      return c.json({ ok: true });
    case BTN.remove:
      if (current) await show(c.env, chatId, userId, confirmDeleteScreen(current));
      return c.json({ ok: true });
    case BTN.yes:
      if (st.screen === 'confirm_delete' && st.org && (await deleteOrg(c.env, userId, st.org))) {
        await sendMessage(c.env, chatId, 'Организация удалена.');
        await show(c.env, chatId, userId, mainScreen(myName, await myOrgs(c.env, userId)));
      }
      return c.json({ ok: true });
    case BTN.leave:
      if (current && (await leaveOrg(c.env, userId, current.id))) {
        await sendMessage(c.env, chatId, 'Вы вышли из организации.');
        await show(c.env, chatId, userId, mainScreen(myName, await myOrgs(c.env, userId)));
      }
      return c.json({ ok: true });
  }

  // Выбор организации из списка: подпись -- это её название с маркером.
  if (st.screen === 'orgs' && text) {
    const picked = orgs.find((o) => `${o.is_current ? '● ' : '○ '}${o.name}` === text);
    if (picked) {
      await openOrg(picked);
      return c.json({ ok: true });
    }
  }

  const who = await whoIs(c.env, msg.from);
  if (!who) {
    // Подключился, но организации ещё нет -- показываем меню с кнопками, а не
    // молчим и не диктуем команды.
    await show(c.env, chatId, userId, mainScreen(myName, []));
    return c.json({ ok: true });
  }

  if (msg.text === '/moe' || msg.text === '/мое' || msg.text === '/моё') {
    await sendMessage(c.env, String(msg.chat.id), await myTasksText(c.env, who.userId));
    return c.json({ ok: true });
  }

  if (msg.text === '/promah' || msg.text === '/промах') {
    // Счётчик промахов личного слоя: по нему считается метрика «≤2 за 14 дней»
    // и требование «по убыванию».
    await c.env.DB.prepare(
      `INSERT INTO events (id, actor_id, org_id, target_type, target_id, action, comment, overdue_by, created_at)
       VALUES (?, ?, ?, 'user', ?, 'miss', NULL, NULL, ?)`,
    ).bind(uuid(), who.userId, who.orgId, who.userId, nowIso()).run();
    await sendMessage(c.env, String(msg.chat.id), 'Отмечено. Спасибо, что сказали.');
    return c.json({ ok: true });
  }

  // ------------------------------------------------------- поручение из фразы
  //
  // Сюда попадает всё, что не команда: текст, голосовое, кружочек, видео, фото,
  // документ. Порядок -- медиа сначала, потому что подпись к фото это тоже
  // текст, но файл при этом обязан сохраниться.
  const media = extractMedia(msg as never);
  let phrase = (msg.text ?? msg.caption ?? '').trim();

  if (media?.hasAudio) {
    const blob = await download(c.env, media);
    if (!blob) {
      // 20 МБ -- потолок getFile у Telegram, не наш выбор (ADR-4). Говорим
      // прямо, что делать: короче или файлом.
      await sendMessage(c.env, String(msg.chat.id), 'Файл больше 20 МБ — Telegram не отдаёт такие боту. Пришлите короче.');
      return c.json({ ok: true });
    }
    const text = await transcribe(c.env, blob, media.filename);
    if (!text) {
      await sendMessage(c.env, String(msg.chat.id), 'Не удалось разобрать запись. Напишите текстом, пожалуйста.');
      return c.json({ ok: true });
    }
    // Подпись к видео тоже учитывается: человек мог дописать то, чего не сказал.
    phrase = [text, phrase].filter(Boolean).join('. ');
  }

  if (!phrase && !media) return c.json({ ok: true });
  if (!phrase) {
    await sendMessage(c.env, String(msg.chat.id), 'Что с этим сделать? Напишите подпись — я поставлю задачу и приложу файл.');
    return c.json({ ok: true });
  }

  // Справочник людей ТЕКУЩЕЙ организации: разбор не должен видеть чужих.
  const { results: people } = await c.env.DB.prepare(
    `SELECT u.id, u.name, u.aliases FROM users u
     JOIN org_memberships m ON m.user_id = u.id AND m.org_id = ? AND m.left_at IS NULL AND m.confirmed_at IS NOT NULL
     ORDER BY u.name`,
  ).bind(who.orgId).all<{ id: string; name: string; aliases: string | null }>();
  const roster = people.map((p) => ({
    id: p.id, name: p.name,
    aliases: p.aliases ? (JSON.parse(p.aliases) as string[]) : undefined,
  }));

  const org = await c.env.DB.prepare('SELECT timezone FROM orgs WHERE id = ?').bind(who.orgId).first<{ timezone: string }>();
  const draft = await parseTask(c.env, phrase, roster, who.userId, org?.timezone ?? 'Asia/Tashkent');

  // Неоднозначное имя -- ПЕРЕСПРОС, а не догадка. Поручение, ушедшее не тому,
  // дороже одного вопроса.
  if (draft.ambiguous.length > 0) {
    await sendMessage(c.env, String(msg.chat.id), `Кого именно вы имели в виду: «${draft.ambiguous.join('», «')}»? Уточните фамилию.`);
    return c.json({ ok: true });
  }

  const created = await createFromDraft(c.env, who, draft, media, phrase);
  if (created) {
    // ПОДТВЕРЖДЕНИЕ АВТОРУ -- обязательное, а не украшение.
    //
    // Раньше на успех бот не отвечал ничего: уведомления уходят адресатам, а
    // автор из рассылки исключён (он это и продиктовал). Поручение самому себе
    // не порождало вообще ни одного сообщения, и человек видел молчание --
    // неотличимое от «бот сломался». Здесь же видно, КАК фраза понята: кому и
    // на когда. Не тому понятый адресат ловится сразу, а не через неделю.
    const names = draft.assigneeIds.length === 0 ? [] : (await c.env.DB.prepare(
      `SELECT name FROM users WHERE id IN (${draft.assigneeIds.map(() => '?').join(',')})`,
    ).bind(...draft.assigneeIds).all<{ name: string }>()).results.map((r) => r.name);
    const self = draft.assigneeIds.length === 1 && draft.assigneeIds[0] === who.userId;
    await sendMessage(c.env, String(msg.chat.id), [
      `✅ ${draft.title}`,
      `Кому: ${self ? 'вам' : names.join(', ') || '—'}`,
      `Срочность: ${draft.priority === 'urgent' ? 'срочно' : draft.priority === 'low' ? 'низкая' : 'средняя'}`,
      `Срок: ${draft.deadline ? formatWhen(draft.deadline, org?.timezone ?? 'Asia/Tashkent') : 'не указан'}`,
      draft.deadline ? 'Напомню за день до срока.' : 'Поставьте срок кнопкой — и я напомню.',
    ].join('\n'),
      // Без срока нет ни напоминания, ни просрочки. Кнопки дешевле, чем просить
      // переписать всю фразу ради одного слова.
      draft.deadline ? undefined : dueKeyboard(created));
  }
  if (!created) {
    // Единственная оставшаяся причина отказа: доски в организации есть, а
    // человека не добавили ни на одну. Говорим прямо, что делать.
    await sendMessage(c.env, String(msg.chat.id), 'Вас пока не добавили ни на одну доску — попросите руководителя.');
    return c.json({ ok: true });
  }
  await drainOutbox(c.env);
  return c.json({ ok: true });
});
