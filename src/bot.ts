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
import type { Env, Role, Task } from './types';
import { nowIso, uuid } from './db';
import { myAssignee, transitionAssignee, declineAssignee, lateAssignee, reassignCandidates, reassignTask } from './assignees';
import { answerCallbackQuery, editMessageReplyMarkup, sendMessage, type InlineKeyboard, editMessageText } from './telegram';
import { drainOutbox } from './outbox';
import { applyTransition, openButton } from './transition';
import { approveJoin, createOrg, ensureUser, joinByCode, orgDepartments, pendingOrgFor, pendingRequests, rejectJoin } from './signup';
import { setTaskDeadline } from './intake';
import {
  assigneesOf, confirmDraft, draftByMessage, getDraft, latestDraft, listDrafts, mediaOf,
  patchDraft, removeDraft, renderCreated, renderDraft, saveDraft, type DraftPatch,
} from './drafts';
import { categoryByButton, packByButton } from './packs';
import {
  askNameScreen, BTN, confirmDeleteScreen, deleteOrg, getState, isOnboarded, leaveOrg,
  billingScreen, categoryScreen, industryScreen, mainScreen, myOrgs, orgScreen, orgsScreen, profileScreen, renameOrg, setDisplayName,
  setState, switchOrg, type OrgRow, type Screen,
} from './menu';
import { download, extractMedia } from './media';
import { formatWhen, parseTask, refineDraft, transcribe, localIso, localToday } from './parse';
import { membershipRole, resolveOrgId } from './auth';
import { safeEqual } from './auth';

const enc = new TextEncoder();

export const botApp = new Hono<{ Bindings: Env }>();

type TgUser = { id: number; username?: string; first_name?: string; last_name?: string };
type Update = {
  // Медиа-поля описаны в media.ts; здесь они приходят как есть и передаются
  // туда через extractMedia -- дублировать их формы в двух местах незачем.
  message?: {
    chat: { id: number; type?: string }; from?: TgUser; text?: string; caption?: string;
    /** На что отвечают. Ответ на карточку черновика -- это поправка к нему. */
    reply_to_message?: { message_id: number };
  };
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

// ---------------------------------------------------- приём в организацию
//
// Роль спрашивается ПРИ ПОДТВЕРЖДЕНИИ, а не «потом в настройках»: раньше
// каждый вступивший молча становился рядовым, и поменять это можно было только
// с компьютера. Владельца с кнопки не выдают -- он один, и передача владения не
// должна быть выбором под уведомлением.
//
// Код роли в кнопке однобуквенный, а отдел -- НОМЕР в списке организации, а не
// его идентификатор: два UUID в callback_data не помещаются (предел 64 байта).
const ROLE_CODE: Record<string, Role> = { m: 'member', a: 'admin', s: 'super_admin' };
const ROLE_TITLE: Record<Role, string> = {
  creator: 'Владелец', super_admin: 'Руководитель', admin: 'Руководитель отдела', member: 'Сотрудник',
};

function roleKeyboard(applicantId: string): InlineKeyboard {
  return {
    inline_keyboard: [
      [{ text: '👤 Сотрудник', callback_data: `jr:${applicantId}:m` }],
      [{ text: '📋 Руководитель отдела', callback_data: `jr:${applicantId}:a` }],
      [{ text: '⭐️ Руководитель', callback_data: `jr:${applicantId}:s` }],
      [{ text: '✖️ Отклонить', callback_data: `join_no:${applicantId}` }],
    ],
  };
}

function deptKeyboard(applicantId: string, roleCode: string, depts: { name: string }[]): InlineKeyboard {
  return {
    // Роль и номер отдела одним коротким токеном («a3»): двумя подстановками
    // кнопка не уложилась бы в предел.
    inline_keyboard: depts.map((d, i) => {
      const slot = `${roleCode}${i}`;
      return [{ text: d.name, callback_data: `jd:${applicantId}:${slot}` }];
    }),
  };
}

/**
 * Быстрые сроки и срочность под подтверждением. «Свой срок» открывает календарь.
 *
 * Срочность здесь по той же причине, что и срок: она берётся из слов фразы, а
 * если слов не было -- остаётся средней, и поднять её было негде. В приложении
 * такие кнопки есть; правило «что можно там, можно и тут» требует их и здесь.
 */
/**
 * Срок из короткого кода кнопки: t0 -- сегодня, t1 -- завтра, we -- ближайшая
 * пятница (включая сегодняшнюю), YYYY-MM-DD -- день из календаря. Один расчёт
 * на задачи и на черновики.
 */
function resolveDue(arg: string, today: { y: number; m: number; d: number }, tz: string): string | null {
  const day = (offset: number) => {
    const d = new Date(Date.UTC(today.y, today.m - 1, today.d + offset));
    return localIso(d.getUTCFullYear(), d.getUTCMonth() + 1, d.getUTCDate(), DUE_HOUR, tz);
  };
  if (arg === 't0') return day(0);
  if (arg === 't1') return day(1);
  if (arg === 'we') {
    const base = new Date(Date.UTC(today.y, today.m - 1, today.d));
    return day((5 - ((base.getUTCDay() + 6) % 7) + 7) % 7);
  }
  if (/^\d{4}-\d{2}-\d{2}$/.test(arg)) {
    const [y, m, d] = arg.split('-').map(Number);
    return localIso(y, m, d, DUE_HOUR, tz);
  }
  return null;
}

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
        { text: '❗️ Высокая', callback_data: `pri:${taskId}:u` },
        { text: '↓ Низкая', callback_data: `pri:${taskId}:l` },
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
function calendarKeyboard(
  taskId: string, y: number, m: number, today: { y: number; m: number; d: number },
  /** Чей срок выбираем: задачи (due/cal) или черновика (dd/dcal). */
  scope: 'task' | 'draft' = 'task',
): InlineKeyboard {
  const P = scope === 'task' ? { due: 'due', cal: 'cal' } : { due: 'dd', cal: 'dcal' };
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
      { text: '‹', callback_data: `${P.cal}:${taskId}:${prevYm}` },
      { text: `${MONTH_TITLE[m - 1]} ${y}`, callback_data: `noop:${taskId}:` },
      { text: '›', callback_data: `${P.cal}:${taskId}:${nextYm}` },
    ],
    ['Пн', 'Вт', 'Ср', 'Чт', 'Пт', 'Сб', 'Вс'].map((w) => ({ text: w, callback_data: `noop:${taskId}:` })),
  ];

  let row: { text: string; callback_data: string }[] = Array.from({ length: lead }, () => ({ text: ' ', callback_data: `noop:${taskId}:` }));
  for (let d = 1; d <= days; d++) {
    const isToday = y === today.y && m === today.m && d === today.d;
    const ymd = `${y}-${pad(m)}-${pad(d)}`;
    row.push({ text: isToday ? `·${d}·` : String(d), callback_data: `${P.due}:${taskId}:${ymd}` });
    if (row.length === 7) { rows.push(row); row = []; }
  }
  if (row.length > 0) {
    while (row.length < 7) row.push({ text: ' ', callback_data: `noop:${taskId}:` });
    rows.push(row);
  }
  rows.push([{ text: '‹ Назад', callback_data: `${P.cal}:${taskId}:back` }]);
  return { inline_keyboard: rows };
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
    // Приём: «Принять» -> роль -> отдел (если их несколько) -> готово.
    if (action === 'join_ok' || action === 'jr' || action === 'jd') {
      const applicantId = parts[1] ?? '';
      const orgId = applicantId ? await pendingOrgFor(c.env, who.userId, applicantId) : null;
      if (!orgId) {
        await answerCallbackQuery(c.env, cq.id, 'Заявка недоступна');
        return c.json({ ok: true });
      }
      const applicant = await c.env.DB.prepare('SELECT name, telegram_user_id FROM users WHERE id = ?')
        .bind(applicantId).first<{ name: string; telegram_user_id: string | null }>();
      const chat = cq.message ? String(cq.message.chat.id) : null;
      const msgId = cq.message ? String(cq.message.message_id) : null;

      // Шаг 1: кем принять.
      if (action === 'join_ok') {
        await answerCallbackQuery(c.env, cq.id);
        if (chat && msgId) {
          await editMessageText(c.env, chat, msgId, `Кем принять ${applicant?.name ?? 'сотрудника'}?`, roleKeyboard(applicantId));
        }
        return c.json({ ok: true });
      }

      const depts = await orgDepartments(c.env, orgId);

      // Шаг 2: в какой отдел. Если отдел один, вопроса нет.
      if (action === 'jr') {
        const roleCode = parts[2] ?? 'm';
        if (depts.length > 1) {
          await answerCallbackQuery(c.env, cq.id);
          if (chat && msgId) {
            await editMessageText(c.env, chat, msgId,
              `${applicant?.name ?? 'Сотрудник'} -- ${ROLE_TITLE[ROLE_CODE[roleCode] ?? 'member']}. В какой отдел?`,
              deptKeyboard(applicantId, roleCode, depts));
          }
          return c.json({ ok: true });
        }
        const ok = await approveJoin(c.env, who.userId, orgId, applicantId, ROLE_CODE[roleCode] ?? 'member', depts[0]?.id);
        await answerCallbackQuery(c.env, cq.id, ok ? 'Принят' : 'Заявка недоступна');
        if (ok && chat && msgId) {
          await editMessageText(c.env, chat, msgId,
            `✅ ${applicant?.name ?? 'Сотрудник'} принят -- ${ROLE_TITLE[ROLE_CODE[roleCode] ?? 'member']}.`);
        }
        if (ok && applicant?.telegram_user_id) {
          await sendMessage(c.env, applicant.telegram_user_id, 'Вас приняли. /moe -- ваши задачи.');
        }
        return c.json({ ok: true });
      }

      // Шаг 3: роль и отдел выбраны.
      const slot = parts[2] ?? 'm0';
      const role = ROLE_CODE[slot[0]] ?? 'member';
      const dept = depts[Number(slot.slice(1))] ?? depts[0];
      const ok = await approveJoin(c.env, who.userId, orgId, applicantId, role, dept?.id);
      await answerCallbackQuery(c.env, cq.id, ok ? 'Принят' : 'Заявка недоступна');
      if (ok && chat && msgId) {
        await editMessageText(c.env, chat, msgId,
          `✅ ${applicant?.name ?? 'Сотрудник'} принят -- ${ROLE_TITLE[role]}, отдел «${dept?.name ?? '-'}».`);
      }
      if (ok && applicant?.telegram_user_id) {
        await sendMessage(c.env, applicant.telegram_user_id, `Вас приняли в отдел «${dept?.name ?? '-'}». /moe -- ваши задачи.`);
      }
      return c.json({ ok: true });
    }

    // ------------------------------------------------------------ черновик
    if (action === 'dc' || action === 'dx' || action === 'de' || action === 'dd' || action === 'dp' || action === 'dcal') {
      const row = await getDraft(c.env, parts[1] ?? '');
      // Черновик -- личное: кнопку на чужом (пересланном) сообщении не слушаем.
      if (!row || row.author_id !== who.userId) {
        await answerCallbackQuery(c.env, cq.id, 'Черновик недоступен');
        return c.json({ ok: true });
      }
      const orgRow = await c.env.DB.prepare('SELECT timezone FROM orgs WHERE id = ?').bind(row.org_id).first<{ timezone: string }>();
      const tz = orgRow?.timezone ?? 'Asia/Tashkent';
      const chat = cq.message ? String(cq.message.chat.id) : null;
      const msgId = cq.message ? String(cq.message.message_id) : null;

      if (action === 'dc') {
        // Самая главная кнопка: только она превращает черновик в поручение.
        const taskId = await confirmDraft(c.env, row);
        await answerCallbackQuery(c.env, cq.id, taskId ? 'Создано' : 'Некуда положить');
        if (chat) {
          if (taskId) await renderCreated(c.env, row, chat, tz);
          else await sendMessage(c.env, chat, 'Вас пока не добавили ни на одну доску — попросите руководителя.');
        }
        await drainOutbox(c.env);
        return c.json({ ok: true });
      }
      if (action === 'dx') {
        await removeDraft(c.env, row.id);
        await answerCallbackQuery(c.env, cq.id, 'Отменено');
        if (chat && msgId) await editMessageText(c.env, chat, msgId, '✖ Черновик удалён.');
        return c.json({ ok: true });
      }
      if (action === 'de') {
        // Следующее сообщение -- поправка к этому черновику. Ответ на карточку
        // работает и без этой кнопки; она для тех, кто про reply не знает.
        const st = await getState(c.env, who.userId);
        await setState(c.env, who.userId, { ...st, await: 'fix', fix: row.id });
        await answerCallbackQuery(c.env, cq.id);
        if (chat) {
          await sendMessage(c.env, chat, 'Что поправить? Напишите или наговорите: «не Артуру, а Еве», «срок вторник», «тема — сдать отчёт». Или пришлите всю фразу заново.');
        }
        return c.json({ ok: true });
      }
      const today = localToday(new Date(), tz);
      if (action === 'dcal') {
        const arg = parts[2] ?? '';
        if (arg === 'back') {
          await answerCallbackQuery(c.env, cq.id);
          if (chat) await renderDraft(c.env, row, chat, tz);
          return c.json({ ok: true });
        }
        const [y, m] = arg ? arg.split('-').map(Number) : [today.y, today.m];
        await answerCallbackQuery(c.env, cq.id);
        if (chat && msgId) await editMessageReplyMarkup(c.env, chat, msgId, calendarKeyboard(row.id, y || today.y, m || today.m, today, 'draft'));
        return c.json({ ok: true });
      }
      if (action === 'dd') {
        const iso = resolveDue(parts[2] ?? '', today, tz);
        if (!iso) { await answerCallbackQuery(c.env, cq.id); return c.json({ ok: true }); }
        const updated = await patchDraft(c.env, row.id, { deadline: iso });
        await answerCallbackQuery(c.env, cq.id, 'Срок поставлен');
        if (chat && updated) await renderDraft(c.env, updated, chat, tz);
        return c.json({ ok: true });
      }
      // dp -- важность
      const lvl = parts[2] === 'u' ? 'urgent' : parts[2] === 'l' ? 'low' : 'medium';
      const updated = await patchDraft(c.env, row.id, { priority: lvl, priorityExplicit: true });
      await answerCallbackQuery(c.env, cq.id, 'Важность поставлена');
      if (chat && updated) await renderDraft(c.env, updated, chat, tz);
      return c.json({ ok: true });
    }

    if (action === 'join_no') {
      // В кнопке только заявитель: «join_no:» с ДВУМЯ UUID -- 81 байт, а предел
      // callback_data у Telegram 64, и он отвергал всё сообщение целиком.
      // Организация ищется по заявителю среди тех, где нажавший распоряжается.
      const applicantId = parts[1] ?? '';
      const orgId = applicantId ? await pendingOrgFor(c.env, who.userId, applicantId) : null;
      const done = !orgId ? false : await rejectJoin(c.env, who.userId, orgId, applicantId);
      // Право подтверждать проверяется ВНУТРИ approveJoin/rejectJoin, а не
      // здесь: сообщение с кнопкой живёт в Telegram и может быть переслано
      // кому угодно.
      await answerCallbackQuery(c.env, cq.id, done ? 'Отклонён' : 'Заявка недоступна');
      if (done && cq.message) await editMessageReplyMarkup(c.env, String(cq.message.chat.id), String(cq.message.message_id));
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

      const iso = resolveDue(parts[2] ?? '', today, tz);
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

    // --------------------------------------------- ответы автора на карточку
    //
    // «Оставить как есть», «Переназначить», «Отменить задачу» нажимает АВТОР, а
    // строки адресата у него обычно нет -- поэтому ветка стоит ДО проверки
    // «ты адресат», как и поводы выше.
    if (action === 'keep' || action === 'ra' || action === 'cancel') {
      if (task.author_id !== who.userId) {
        await answerCallbackQuery(c.env, cq.id, 'Это не ваше поручение');
        return c.json({ ok: true });
      }
      const chat = cq.message ? String(cq.message.chat.id) : null;
      const msgId = cq.message ? String(cq.message.message_id) : null;
      if (action === 'keep') {
        await answerCallbackQuery(c.env, cq.id, 'Хорошо');
        if (chat && msgId) await editMessageReplyMarkup(c.env, chat, msgId, { inline_keyboard: [[openButton(task.id)]] });
        return c.json({ ok: true });
      }
      if (action === 'cancel') {
        if (task.status === 'archived') {
          await answerCallbackQuery(c.env, cq.id, 'Уже отменена');
          return c.json({ ok: true });
        }
        // Гейт -- авторство, как у подтверждения: своё поручение отменяет тот, кто его дал.
        await applyTransition(c.env, {
          task, to: 'archived', actorId: who.userId, action: 'deleted',
          set: { telegram_message_id: null },
          notify: { emoji: '🗑', label: 'Поручение отменено', deletePrevious: true },
        });
        await answerCallbackQuery(c.env, cq.id, 'Отменено');
        if (chat && msgId) await editMessageReplyMarkup(c.env, chat, msgId);
        await drainOutbox(c.env);
        return c.json({ ok: true });
      }
      // ra: без индекса -- показать список, с индексом -- переназначить.
      const people = await reassignCandidates(c.env, who.orgId, task.author_id);
      const pick = parts[2] ?? '';
      if (pick === '') {
        if (people.length === 0) {
          await answerCallbackQuery(c.env, cq.id, 'Некому переназначить');
          return c.json({ ok: true });
        }
        // ponytail: первые десять по алфавиту; поиск по имени -- когда организации перерастут экран.
        // Индекс + хвост id: между показом и нажатием кто-то мог вступить, и
        // позиция сдвинулась бы на другого человека.
        const rows = people.slice(0, 10).map((p, i) => {
          const tag = p.id.slice(0, 8);
          return [{ text: p.name, callback_data: `ra:${task.id}:${i}:${tag}` }];
        });
        rows.push([{ text: '‹ Отмена', callback_data: `keep:${task.id}` }]);
        await answerCallbackQuery(c.env, cq.id);
        if (chat && msgId) await editMessageReplyMarkup(c.env, chat, msgId, { inline_keyboard: rows });
        return c.json({ ok: true });
      }
      const chosen = people.slice(0, 10)[Number(pick)];
      if (!chosen || chosen.id.slice(0, 8) !== (parts[3] ?? '')) {
        await answerCallbackQuery(c.env, cq.id, 'Список изменился, откройте заново');
        return c.json({ ok: true });
      }
      await reassignTask(c.env, task, chosen.id, who.userId);
      await answerCallbackQuery(c.env, cq.id, `Переназначено: ${chosen.name}`);
      if (chat && msgId) await editMessageReplyMarkup(c.env, chat, msgId, { inline_keyboard: [[openButton(task.id)]] });
      await sendMessage(c.env, String(cq.from.id), `↪ «${task.title}» — теперь у ${chosen.name}. Карточка ушла.`);
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

    const chat = cq.message ? String(cq.message.chat.id) : null;
    const msgId = cq.message ? String(cq.message.message_id) : null;

    // «Не успею» и «Отказать» просят причину: следующее сообщение -- она.
    if (action === 'late' || action === 'decline') {
      if (mine.state !== 'pending' && mine.state !== 'accepted') {
        await answerCallbackQuery(c.env, cq.id, 'Уже нельзя');
        return c.json({ ok: true });
      }
      const st = await getState(c.env, who.userId);
      await setState(c.env, who.userId, { ...st, await: action, task: task.id });
      await answerCallbackQuery(c.env, cq.id);
      // В ЛИЧКУ нажавшего, а не в чат с кнопкой: карточку можно переслать в
      // группу, а заголовок туда уходить не должен (ADR-4).
      await sendMessage(c.env, String(cq.from.id), action === 'late'
        ? `Почему не успеваете «${task.title}»? Напишите или наговорите одной фразой — передам автору.`
        : `Почему отказываетесь от «${task.title}»? Напишите или наговорите причину — передам автору.`);
      return c.json({ ok: true });
    }

    if (action !== 'accept' && action !== 'ack') {
      await answerCallbackQuery(c.env, cq.id);
      return c.json({ ok: true });
    }
    // «Готово» из бота нет: сдают в приложении (решение владельца). Здесь --
    // принять и «ознакомился»; для рассылки «прочитать» accepted и есть закрытие.
    const res = await transitionAssignee(c.env, {
      task, assignee: mine, to: 'accepted', actorId: who.userId,
      notify: action === 'ack'
        ? { emoji: '👁', label: 'Ознакомился' }
        : { emoji: '🚀', label: 'Принято в работу', track: true },
    });
    await answerCallbackQuery(c.env, cq.id, res.ok ? (action === 'ack' ? 'Отмечено' : 'Принято') : 'Уже нельзя');

    // Клавиатура меняется РОВНО ОДИН РАЗ на переход: остаётся только «Открыть».
    // Иначе ту же кнопку можно нажать второй раз и увидеть «уже нельзя» на
    // собственное действие.
    if (res.ok && chat && msgId) {
      await editMessageReplyMarkup(c.env, chat, msgId, { inline_keyboard: [[openButton(task.id)]] });
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
  // Кнопка меню перебивает ожидание причины «не успею» / «отказ»: человек
  // передумал, и «Мои задачи» -- не причина. Сама причина разбирается ниже,
  // вместе с голосом (см. хвост: там уже есть расшифровка).
  if ((st.await === 'late' || st.await === 'decline') && (Object.values(BTN) as string[]).includes(text)) {
    await setState(c.env, userId, { ...st, await: undefined, task: undefined });
    st.await = undefined;
  }

  // fix/late/decline разбираются в хвосте: там фраза уже расшифрована и с голоса.
  if (st.await && st.await !== 'fix' && st.await !== 'late' && st.await !== 'decline' && text) {
    if (st.await === 'name') {
      const ok = await setDisplayName(c.env, userId, text);
      await sendMessage(c.env, chatId, ok ? 'Имя обновлено.' : 'Слишком короткое имя.');
      await show(c.env, chatId, userId, profileScreen(ok ? text.trim() : myName, orgs));
      return c.json({ ok: true });
    }
    if (st.await === 'new') {
      // Название запомнили, теперь профиль: он решает, какие отделы завести.
      await show(c.env, chatId, userId, categoryScreen(text.slice(0, 60)));
      return c.json({ ok: true });
    }
    if (st.await === 'pack') {
      const orgDraft = st.draft ?? 'Моя организация';
      // «Назад» с экрана отраслей -- к категориям.
      if (text === BTN.back) {
        await show(c.env, chatId, userId, categoryScreen(orgDraft));
        return c.json({ ok: true });
      }
      const category = categoryByButton(text);
      if (category) {
        await show(c.env, chatId, userId, industryScreen(orgDraft, category.id));
        return c.json({ ok: true });
      }
      const chosen = packByButton(text);
      if (!chosen) {
        // Написали текстом вместо нажатия -- переспрашиваем, а не гадаем.
        await show(c.env, chatId, userId, st.cat ? industryScreen(orgDraft, st.cat) : categoryScreen(orgDraft));
        return c.json({ ok: true });
      }
      const orgName = orgDraft;
      const { code, departments } = await createOrg(c.env, userId, orgName, chosen.id);
      await sendMessage(c.env, chatId, [
        `Организация «${orgName}» создана. Вы её владелец.`,
        `Профиль: ${chosen.title}`,
        `Отделы: ${departments.join(', ')}`,
        '',
        `Код для сотрудников: ${code}`,
        'Каждого вступившего Вы подтверждаете кнопкой.',
        '',
        'Попробуйте сказать так:',
        ...chosen.examples.map((e: string) => `· ${e}`),
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
    case BTN.drafts: {
      const who2 = await whoIs(c.env, msg.from);
      if (!who2) return c.json({ ok: true });
      const rows = await listDrafts(c.env, who2.userId, who2.orgId);
      if (rows.length === 0) {
        await sendMessage(c.env, chatId, 'Черновиков нет. Напишите или наговорите поручение — оно появится здесь до подтверждения.');
        return c.json({ ok: true });
      }
      const orgRow = await c.env.DB.prepare('SELECT timezone FROM orgs WHERE id = ?').bind(who2.orgId).first<{ timezone: string }>();
      // Каждый черновик -- свежей карточкой: старая могла уехать далеко вверх.
      for (const row of rows.slice(0, 10)) await renderDraft(c.env, row, chatId, orgRow?.timezone ?? 'Asia/Tashkent', true);
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
  const chat = String(msg.chat.id);

  if (media?.hasAudio) {
    const blob = await download(c.env, media);
    if (!blob) {
      // 20 МБ -- потолок getFile у Telegram, не наш выбор (ADR-4). Говорим
      // прямо, что делать: короче или файлом.
      await sendMessage(c.env, chat, 'Файл больше 20 МБ — Telegram не отдаёт такие боту. Пришлите короче.');
      return c.json({ ok: true });
    }
    const text = await transcribe(c.env, blob, media.filename);
    if (!text) {
      await sendMessage(c.env, chat, 'Не удалось разобрать запись. Напишите текстом, пожалуйста.');
      return c.json({ ok: true });
    }
    // Подпись к видео тоже учитывается: человек мог дописать то, чего не сказал.
    phrase = [text, phrase].filter(Boolean).join('. ');
  }

  if (!phrase && !media) return c.json({ ok: true });

  const org = await c.env.DB.prepare('SELECT timezone, industry_pack FROM orgs WHERE id = ?').bind(who.orgId)
    .first<{ timezone: string; industry_pack: string }>();
  const tz = org?.timezone ?? 'Asia/Tashkent';

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

  // ------------------------------------------------ причина «не успею» / «отказ»
  //
  // Текстом или голосом: фраза выше уже расшифрована. Пустая расшифровка
  // ожидание не снимает -- переспрашиваем, а не заводим черновик из тишины.
  if ((st.await === 'late' || st.await === 'decline') && st.task) {
    if (!phrase) {
      await sendMessage(c.env, chat, 'Не разобрал. Напишите причину текстом.');
      return c.json({ ok: true });
    }
    // Задача -- только ТЕКУЩЕЙ организации: ожидание могло пережить смену
    // организации или отзыв членства.
    const task = await c.env.DB.prepare('SELECT * FROM tasks WHERE id = ? AND org_id = ?').bind(st.task, who.orgId).first<Task>();
    const mine = task ? await myAssignee(c.env, task.id, userId, task.org_id) : null;
    await setState(c.env, userId, { ...st, await: undefined, task: undefined });
    if (!task || !mine) {
      await sendMessage(c.env, chat, 'Задача недоступна.');
      return c.json({ ok: true });
    }
    const ok = st.await === 'late'
      ? await lateAssignee(c.env, task, mine, userId, phrase)
      : (await declineAssignee(c.env, task, mine, userId, phrase)).ok;
    await sendMessage(c.env, chat, ok ? 'Передал автору.' : 'Уже нельзя: задача изменилась.');
    await drainOutbox(c.env);
    return c.json({ ok: true });
  }

  // ------------------------------------------------ поправка к черновику
  //
  // Ответ на карточку черновика или сообщение после «Изменить» -- это правка,
  // а не новое поручение. Голосом или текстом, одно поле или вся фраза заново.
  const replyTo = msg.reply_to_message?.message_id;
  let target = st.await === 'fix' && st.fix ? await getDraft(c.env, st.fix) : null;
  if (!target && replyTo) target = await draftByMessage(c.env, chat, String(replyTo));
  if (target && target.author_id === who.userId) {
    const patch: DraftPatch = {};
    // Голос поправки -- не вложение: вложение это фото и документ.
    if (media && !media.hasAudio) patch.media = [...mediaOf(target), media];
    if (phrase) {
      Object.assign(patch, await refineDraft(c.env, {
        title: target.title, assigneeIds: assigneesOf(target), deadline: target.deadline,
        priority: target.priority, priorityExplicit: target.priority_explicit === 1,
      }, phrase, roster, tz, org?.industry_pack));
    }
    const updated = await patchDraft(c.env, target.id, patch);
    if (st.await === 'fix') await setState(c.env, userId, { ...st, await: undefined, fix: undefined });
    if (updated) await renderDraft(c.env, updated, chat, tz);
    return c.json({ ok: true });
  }

  // ------------------------------------------------ файл без подписи
  //
  // К последнему черновику -- всегда. Созданной задаче он не достаётся: её
  // правят только в приложении, а новый файл без слов -- это ещё не поручение.
  if (!phrase && media) {
    const last = await latestDraft(c.env, who.userId, who.orgId);
    if (last) {
      const updated = await patchDraft(c.env, last.id, { media: [...mediaOf(last), media] });
      if (updated) await renderDraft(c.env, updated, chat, tz);
      return c.json({ ok: true });
    }
    await sendMessage(c.env, chat, 'Что с этим сделать? Напишите подпись — я заведу черновик и приложу файл.');
    return c.json({ ok: true });
  }

  // ------------------------------------------------ новый черновик
  const draft = await parseTask(c.env, phrase, roster, who.userId, tz, new Date(), org?.industry_pack);

  // Неоднозначное имя -- ПЕРЕСПРОС, а не догадка. Поручение, ушедшее не тому,
  // дороже одного вопроса.
  if (draft.ambiguous.length > 0) {
    await sendMessage(c.env, chat, `Кого именно вы имели в виду: «${draft.ambiguous.join('», «')}»? Уточните фамилию.`);
    return c.json({ ok: true });
  }

  // Задача НЕ создаётся здесь. Черновик показывает, как фраза понята, и ждёт
  // «Создать» -- самой главной кнопки: разбор ошибается, и не тому понятый
  // адресат должен ловиться до того, как поручение ушло.
  const row = await saveDraft(c.env, who, draft, phrase, media ? [media] : []);
  await renderDraft(c.env, row, chat, tz);
  return c.json({ ok: true });
});
