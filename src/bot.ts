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
import { nowIso } from './db';
import { confirmWork, myAssignee, startWork, transitionAssignee, declineAssignee, lateAssignee, reassignCandidates, reassignTask } from './assignees';
import { answerCallbackQuery, editMessageReplyMarkup, sendMessage, sendTyping, type InlineButton, type InlineKeyboard, editMessageText } from './telegram';
import { drainOutbox } from './outbox';
import { applyTransition, openButton } from './transition';
import { approveJoin, canCreateOrg, createOrg, departmentsFor, ensureUser, hasPendingJoin, inviteCodeFor, inviteLink, joinByCode, joinByInvite, notifyApprover, pendingOrgFor, pendingRequests, rejectJoin } from './signup';
import { commandTaskByPhrase, setTaskDeadline } from './intake';
import {
  assigneesOf, confirmDraft, draftAssignable, draftByMessage, getDraft, latestDraft, listDrafts, mediaOf,
  logMiss, patchDraft, removeDraft, renderCreated, renderDraft, saveDraft, type DraftPatch,
} from './drafts';
import { categoryByButton, packByButton } from './packs';
import {
  askNameScreen, BTN, getState, isOnboarded, categoryScreen, industryScreen, mainScreen, myOrgs, orgsScreen, setDisplayName,
  setState, switchOrg, type Screen, notifyPrefs, setNotifyPrefs, settingsScreen, updateOrgSettings, isOrgOwner, START_TIPS } from './menu';
import { download, extractMedia } from './media';
import { formatWhen, learnAlias, parseTask, refineDraft, swapWords, transcribe, localIso, localToday, matchPeople } from './parse';
import { dayEnd, hm, loadSchedule, localHm, weekEndDay, type OrgSchedule } from './schedule';
import { askAssistant, asksOwnDrafts, classifyIntent } from './assistant';
import { assignableMembers } from './hierarchy';
import { APP_URL } from './transition';
import { show as showChecklist, toggleItem } from './checklist';
import { brainTurn } from './act';
import { loginPending, membershipRole, resolveOrgId } from './auth';
import { safeEqual } from './auth';

const enc = new TextEncoder();

export const botApp = new Hono<{ Bindings: Env }>();

type TgUser = { id: number; username?: string; first_name?: string; last_name?: string };
type Update = {
  // Медиа-поля описаны в media.ts; здесь они приходят как есть и передаются
  // туда через extractMedia -- дублировать их формы в двух местах незачем.
  message?: {
    chat: { id: number; type?: string }; from?: TgUser; text?: string; caption?: string;
    /**
     * На что отвечают. Ответ на карточку черновика -- поправка к нему; ответ
     * на сообщение о задаче -- команда по ней. Telegram присылает исходное
     * сообщение целиком: текст и кнопки, а в «📱 Открыть» зашит id задачи.
     */
    reply_to_message?: { message_id: number; text?: string; reply_markup?: unknown };
  };
  callback_query?: {
    id: string; from: TgUser; data?: string;
    message?: { chat: { id: number }; message_id: number; reply_markup?: { inline_keyboard?: InlineButton[][] } };
  };
};

/** Кто это. null -- неизвестный, и тогда мы молчим. */
/**
 * Черновики карточками -- и по кнопке «📝 Черновики», и на «какие у меня
 * черновики?» словами. Словами вопрос уходил модели, а она черновиков не
 * видела и отвечала «у вас их нет».
 */
async function showDrafts(env: Env, chatId: string, userId: string, orgId: string): Promise<void> {
  const rows = await listDrafts(env, userId, orgId);
  if (rows.length === 0) {
    await sendMessage(env, chatId, 'Черновиков нет. Напишите или наговорите поручение — оно появится здесь до подтверждения.');
    return;
  }
  const orgRow = await env.DB.prepare('SELECT timezone FROM orgs WHERE id = ?').bind(orgId).first<{ timezone: string }>();
  // Каждый черновик -- свежей карточкой: старая могла уехать далеко вверх.
  for (const row of rows.slice(0, 10)) await renderDraft(env, row, chatId, orgRow?.timezone ?? 'Asia/Tashkent', true);
}

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

/** Заявка по личной ссылке и карточка её хозяину. */
async function applyInvite(env: Env, userId: string, chatId: string, code: string): Promise<void> {
  const res = await joinByInvite(env, userId, code);
  if (!res.ok) {
    await sendMessage(env, chatId,
      res.reason === 'already_member' ? 'Вы уже в этом пространстве.'
      : res.reason === 'already_pending' ? 'Заявка уже подана, ждём подтверждения.'
      : 'Ссылка не подошла. Попросите новую у того, кто приглашал.');
    return;
  }
  await sendMessage(env, chatId, `Заявка в «${res.orgName}» отправлена. Ждём подтверждения.`);
  await notifyApprover(env, res, userId);
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
// Ролей три (решение 10.09): владелец, руководитель отдела, участник.
// super_admin больше не выдаётся; существующие работают как раньше.
const ROLE_CODE: Record<string, Role> = { m: 'member', a: 'admin' };
const ROLE_TITLE: Record<Role, string> = {
  creator: 'Владелец', super_admin: 'Руководитель', admin: 'Руководитель отдела', member: 'Участник',
};

function roleKeyboard(applicantId: string): InlineKeyboard {
  return {
    inline_keyboard: [
      [{ text: '👤 Участник', callback_data: `jr:${applicantId}:m` }],
      [{ text: '📋 Руководитель отдела', callback_data: `jr:${applicantId}:a` }],
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
function resolveDue(arg: string, today: { y: number; m: number; d: number }, s: OrgSchedule): string | null {
  const tz = s.timezone;
  // Конец рабочего дня по графику; у 24/7 -- 23:59.
  const end = hm(dayEnd(s));
  const stamp = (y: number, m: number, d: number) =>
    new Date(Date.parse(localIso(y, m, d, Math.floor(end / 60), tz)) + (end % 60) * 60000).toISOString();
  const day = (offset: number) => {
    const d = new Date(Date.UTC(today.y, today.m - 1, today.d + offset));
    return stamp(d.getUTCFullYear(), d.getUTCMonth() + 1, d.getUTCDate());
  };
  if (arg === 't0') return day(0);
  if (arg === 't1') return day(1);
  if (arg === 'we') {
    // Конец недели -- ПОСЛЕДНИЙ РАБОЧИЙ день организации: у конторы пятница, у
    // магазина суббота, у семьи с графиком 24/7 воскресенье. Прежняя формула
    // всегда давала субботу -- и выходной конторе, и не-конец недели семье.
    const base = new Date(Date.UTC(today.y, today.m - 1, today.d));
    return day((weekEndDay(s) - 1 - ((base.getUTCDay() + 6) % 7) + 7) % 7);
  }
  if (/^\d{4}-\d{2}-\d{2}$/.test(arg)) {
    const [y, m, d] = arg.split('-').map(Number);
    return stamp(y, m, d);
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
const PAGE = 10;

/** «сегодня 15:00», «завтра 18:00», «через 3 дн.», «просрочено на 2ч 10м», «без срока». */
function dueWords(due: string | null, now: Date, tz: string): string {
  if (!due) return 'без срока';
  const ms = Date.parse(due) - now.getTime();
  const time = new Intl.DateTimeFormat('ru-RU', { timeZone: tz, hour: '2-digit', minute: '2-digit', hour12: false }).format(new Date(due));
  if (ms < 0) {
    const h = Math.floor(-ms / 3600000); const m = Math.floor((-ms % 3600000) / 60000);
    return `просрочено на ${h >= 24 ? `${Math.floor(h / 24)} дн.` : h > 0 ? `${h}ч ${m}м` : `${m}м`}`;
  }
  const dayOf = (d: Date) => Date.parse(localHm(d, tz).dayKey);
  const days = Math.round((dayOf(new Date(due)) - dayOf(now)) / 86400000);
  if (days === 0) return `сегодня ${time}`;
  if (days === 1) return `завтра ${time}`;
  return `через ${days} дн.`;
}

const PRI_MARK: Record<string, string> = { urgent: '‼️ ', low: '↓ ', medium: '' };
const STATE_MARK: Record<string, string> = {
  pending: 'не принял', accepted: 'в работе', done: 'сдал', confirmed: 'принято', rejected: 'вернули', declined: 'отказался',
};

/**
 * Список задач (что поручили мне) или поручений (что поручил я) -- ТЕКУЩЕЙ
 * организации, по десять, с листанием инлайн-кнопками (раздел 18). В строке:
 * важность, тема, кому и состояние (у поручений), сколько до срока.
 */
async function taskPage(env: Env, userId: string, orgId: string, kind: 'm' | 'a', page: number): Promise<{ text: string; kb: InlineKeyboard }> {
  const s = await loadSchedule(env, orgId);
  const now = new Date();
  type R = { id: string; title: string; priority: string; due_at: string | null; state: string; who: string };
  const { results } = kind === 'm'
    ? await env.DB.prepare(
        `SELECT t.id, t.title, t.priority, a.due_at, a.state, '' AS who
         FROM task_assignees a JOIN tasks t ON t.id = a.task_id
         WHERE a.user_id = ? AND a.org_id = ? AND a.state IN ('pending','accepted','rejected') AND t.status NOT IN ('archived','done')
         ORDER BY a.due_at IS NULL, a.due_at, t.created_at`,
      ).bind(userId, orgId).all<R>()
    : await env.DB.prepare(
        `SELECT t.id, t.title, t.priority, a.due_at, a.state, u.name AS who
         FROM tasks t JOIN task_assignees a ON a.task_id = t.id JOIN users u ON u.id = a.user_id
         WHERE t.author_id = ? AND t.org_id = ? AND a.user_id <> ? AND t.status <> 'archived' AND a.state <> 'declined'
         ORDER BY a.due_at IS NULL, a.due_at, t.created_at`,
      ).bind(userId, orgId, userId).all<R>();
  // Рассылка -- одной строкой: «Азиз и ещё 13», состояние -- по первому.
  const items: (R & { n: number })[] = [];
  const seen = new Map<string, R & { n: number }>();
  for (const r of results) {
    const prev = seen.get(r.id);
    if (prev) { prev.n += 1; continue; }
    const row = { ...r, n: 1 }; seen.set(r.id, row); items.push(row);
  }
  const total = items.length;
  const pages = Math.max(1, Math.ceil(total / PAGE));
  const p = Math.min(Math.max(0, page), pages - 1);
  const slice = items.slice(p * PAGE, p * PAGE + PAGE);
  const head = kind === 'm' ? `Ваши задачи (${total})` : `Ваши поручения (${total})`;
  const lines = total === 0
    ? [kind === 'm' ? 'Активных задач нет.' : 'Вы пока ничего не поручали.']
    : [pages > 1 ? `${head} · стр. ${p + 1}/${pages}` : head, ...slice.map((r, i) => {
        const who = kind === 'a' ? ` — ${r.who}${r.n > 1 ? ` и ещё ${r.n - 1}` : ''}, ${STATE_MARK[r.state] ?? r.state}` : '';
        return `${p * PAGE + i + 1}. ${PRI_MARK[r.priority] ?? ''}«${r.title}»${who} · ${dueWords(r.due_at, now, s.timezone)}`;
      })];
  const nav: InlineButton[] = [];
  if (p > 0) nav.push({ text: '‹ Назад', callback_data: `pg:${kind}:${p - 1}` });
  if (p + 1 < pages) nav.push({ text: 'Далее ›', callback_data: `pg:${kind}:${p + 1}` });
  const rows: InlineButton[][] = [];
  // Номер строки -- кнопка в САМУ задачу. Без них список только называет
  // задачи, а чтобы открыть одну, человек идёт в приложение и ищет её там
  // заново. Пятёрками: больше в ряд Telegram сжимает до нечитаемого.
  for (let i = 0; i < slice.length; i += 5) {
    rows.push(slice.slice(i, i + 5).map((r, j) => openButton(r.id, String(p * PAGE + i + j + 1))));
  }
  if (nav.length) rows.push(nav);
  rows.push([{ text: '📱 Открыть приложение', web_app: { url: `${APP_URL}/` } }]);
  return { text: lines.join('\n'), kb: { inline_keyboard: rows } };
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

    // ВХОД В БРАУЗЕРЕ -- до whoIs: войти может и тот, у кого пространства ещё
    // нет (сайт тогда покажет «создайте или вступите»).
    const login = cq.data?.match(/^(lg|lgx):([0-9a-f]{32})$/);
    if (login) {
      const [, kind, token] = login;
      const me = await c.env.DB.prepare('SELECT id FROM users WHERE telegram_user_id = ?').bind(String(cq.from.id)).first<{ id: string }>();
      let reply = 'Ссылка для входа устарела. Нажмите «Войти через Telegram» на сайте ещё раз.';
      if (me && await loginPending(c.env.DB, token)) {
        if (kind === 'lgx') {
          await c.env.DB.prepare('DELETE FROM login_links WHERE token = ?').bind(token).run();
          reply = 'Вход отменён. Без этой кнопки по ссылке не войти — аккаунт в безопасности.';
        } else {
          await c.env.DB.prepare('UPDATE login_links SET user_id = ?, confirmed_at = ? WHERE token = ? AND confirmed_at IS NULL')
            .bind(me.id, nowIso(), token).run();
          reply = '✅ Вход подтверждён. Вернитесь в браузер — Hando уже открывается.';
        }
      }
      await answerCallbackQuery(c.env, cq.id);
      if (cq.message) await editMessageText(c.env, String(cq.message.chat.id), String(cq.message.message_id), reply);
      return c.json({ ok: true });
    }

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

      // Руководитель отдела сажает только в свои доски; владелец -- в любую.
      const depts = await departmentsFor(c.env, orgId, who.userId);

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
          await sendMessage(c.env, applicant.telegram_user_id, 'Вас приняли. Ваши задачи — кнопка «Мои задачи».');
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
        await sendMessage(c.env, applicant.telegram_user_id, `Вас приняли в отдел «${dept?.name ?? '-'}». Ваши задачи -- кнопка «Мои задачи».`);
      }
      return c.json({ ok: true });
    }

    // ------------------------------------- «это всё-таки поручение»
    //
    // Бот принял фразу за вопрос и ответил. Одно нажатие -- и та же фраза
    // становится черновиком: цена ошибки разбора ровно такая.
    if (action === 'as_task') {
      const st = await getState(c.env, who.userId);
      const said = st.said;
      if (!said) {
        await answerCallbackQuery(c.env, cq.id, 'Фраза потерялась');
        return c.json({ ok: true });
      }
      const sched = await loadSchedule(c.env, who.orgId);
      const org = await c.env.DB.prepare('SELECT industry_pack FROM orgs WHERE id = ?').bind(who.orgId).first<{ industry_pack: string }>();
      const people = await assignableMembers(c.env, who.orgId, who.userId, who.role);
      const roster = people.map((p) => ({ id: p.id, name: p.name, aliases: p.aliases ? (JSON.parse(p.aliases) as string[]) : undefined }));
      const draft = await parseTask(c.env, said, roster, who.userId, sched.timezone, new Date(), org?.industry_pack, dayEnd(sched), weekEndDay(sched));
      const row = await saveDraft(c.env, who, draft, said, []);
      await setState(c.env, who.userId, { ...st, said: undefined });
      await answerCallbackQuery(c.env, cq.id, 'Завёл черновик');
      if (cq.message) await editMessageReplyMarkup(c.env, String(cq.message.chat.id), String(cq.message.message_id));
      await renderDraft(c.env, row, String(cq.message?.chat.id ?? who.userId), sched.timezone);
      return c.json({ ok: true });
    }

    // ------------------------------------------------------------ листание
    if (action === 'pg') {
      const kind = parts[1] === 'a' ? 'a' : 'm';
      const page = await taskPage(c.env, who.userId, who.orgId, kind, Number(parts[2] ?? 0) || 0);
      await answerCallbackQuery(c.env, cq.id);
      if (cq.message) await editMessageText(c.env, String(cq.message.chat.id), String(cq.message.message_id), page.text, page.kb);
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
      const sched = await loadSchedule(c.env, row.org_id);
      const tz = sched.timezone;
      const chat = cq.message ? String(cq.message.chat.id) : null;
      const msgId = cq.message ? String(cq.message.message_id) : null;

      if (action === 'dc') {
        // Пустая тема -- нечего создавать: такой черновик рождается из файла
        // без подписи и ждёт фразу.
        if (row.title.trim().length < 2) {
          await answerCallbackQuery(c.env, cq.id, 'Сначала напишите, чего это касается');
          return c.json({ ok: true });
        }
        // Самая главная кнопка: только она превращает черновик в поручение.
        // Адресаты перепроверяются здесь: с момента разбора кого-то могли
        // заморозить или отозвать.
        if (!(await draftAssignable(c.env, row))) {
          await answerCallbackQuery(c.env, cq.id, 'Этому человеку поручать нельзя');
          if (chat) await sendMessage(c.env, chat, 'Кому-то из адресатов сейчас поручать нельзя (заморожен или вне вашего отдела). Поправьте черновик.');
          return c.json({ ok: true });
        }
        const taskId = await confirmDraft(c.env, row);
        await answerCallbackQuery(c.env, cq.id, taskId ? 'Создано' : 'Некуда положить');
        if (chat) {
          if (taskId) await renderCreated(c.env, row, chat, tz, taskId);
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
        const iso = resolveDue(parts[2] ?? '', today, sched);
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
    // Задача -- в СВОЕЙ организации, а не в текущей у нажавшего: напоминание
    // про задачу второй организации иначе отвечало «Задача недоступна».
    // Право -- действующее членство именно там.
    const task = taskId ? await c.env.DB.prepare('SELECT * FROM tasks WHERE id = ?').bind(taskId).first<Task>() : null;
    if (!task || !(await membershipRole(c.env.DB, task.org_id, who.userId))) {
      await answerCallbackQuery(c.env, cq.id, 'Задача недоступна');
      return c.json({ ok: true });
    }
    const orgId = task.org_id;

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
        // Тем же путём, что «Принять» в приложении: строки адресатов
        // помечаются принятыми, событие ложится в журнал, исполнитель получает
        // «✔️ Подтверждено». Прямой UPDATE всего этого не делал.
        await confirmWork(c.env, task, who.userId);
        await answerCallbackQuery(c.env, cq.id, 'Принято');
      } else {
        await answerCallbackQuery(c.env, cq.id, 'Напомним исполнителям');
        // Стираем запись журнала -- следующий тик cron пошлёт напоминание
        // заново штатным проходом, а не отдельной рассылкой в обход графика.
        await c.env.DB.prepare(
          "DELETE FROM reminders WHERE kind IN ('not_accepted','overdue') AND assignee_row_id IN (SELECT id FROM task_assignees WHERE task_id = ? AND org_id = ?)",
        ).bind(task.id, orgId).run();
      }
      // Уходит только нажатая кнопка: под «просрочил» остаются «Переназначить»
      // и «Открыть» -- после напоминания они могут понадобиться.
      if (cq.message) {
        const rest = (cq.message.reply_markup?.inline_keyboard ?? [])
          .map((r) => r.filter((b) => !('callback_data' in b && String(b.callback_data).startsWith('nudge_'))))
          .filter((r) => r.length > 0);
        await editMessageReplyMarkup(c.env, String(cq.message.chat.id), String(cq.message.message_id), rest.length ? { inline_keyboard: rest } : undefined);
      }
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
        .bind(priority, nowIso(), task.id, orgId).run();
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
      const sched = await loadSchedule(c.env, orgId);
      const tz = sched.timezone;
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

      const iso = resolveDue(parts[2] ?? '', today, sched);
      if (!iso) {
        await answerCallbackQuery(c.env, cq.id);
        return c.json({ ok: true });
      }

      await setTaskDeadline(c.env, task.id, orgId, iso, who.userId);
      await answerCallbackQuery(c.env, cq.id, 'Срок поставлен');
      if (chatId && messageId) {
        // Без «напомню за день до срока»: такого напоминания нет. Есть «за час»,
        // «за N минут» и «в срок» -- исполнителю, и он сразу узнаёт новый срок.
        await editMessageText(c.env, chatId, messageId, [
          `✅ ${task.title}`,
          `Срок: ${formatWhen(iso, tz)}`,
        ].join('\n'), { inline_keyboard: [[openButton(task.id)]] });
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
      const people = await reassignCandidates(c.env, orgId, task.author_id);
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
      await sendMessage(c.env, String(cq.from.id), `↪ «${task.title}» — теперь у ${chosen.name}. Карточка ушла.`,
        { inline_keyboard: [[openButton(task.id)]] });
      await drainOutbox(c.env);
      return c.json({ ok: true });
    }

    // Сообщение уходит в ЛИЧКУ адресата (ADR-4), но нажать всё равно может
    // только тот, у кого есть своя строка: пересланное сообщение кнопку не
    // делает чужой.
    const mine = await myAssignee(c.env, task.id, who.userId, orgId);
    if (!mine) {
      await answerCallbackQuery(c.env, cq.id, 'Это не ваше поручение');
      return c.json({ ok: true });
    }

    const chat = cq.message ? String(cq.message.chat.id) : null;
    const msgId = cq.message ? String(cq.message.message_id) : null;

    // ЗАДАЧА ЗАКРЫТА -- кнопки старой карточки ничего не делают. Раньше
    // «Принять» на карточке отменённой задачи пересчитывало статус по строкам
    // и возвращало её из архива, а автору приходило «🚀 Принято»; в «кто
    // первый» после закрытия «Принять» рассылало «Принято» всем.
    if (task.status === 'archived' || task.status === 'done') {
      await answerCallbackQuery(c.env, cq.id, task.status === 'archived' ? 'Задача отменена' : 'Задача уже закрыта');
      if (chat && msgId) await editMessageReplyMarkup(c.env, chat, msgId, { inline_keyboard: [[openButton(task.id)]] });
      return c.json({ ok: true });
    }

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
        : `Почему отказываетесь от «${task.title}»? Напишите или наговорите причину — передам автору.`,
        { inline_keyboard: [[openButton(task.id)]] });
      return c.json({ ok: true });
    }

    // Список: отдельное сообщение с кнопкой на каждый пункт. Нажатие правит
    // его на месте, поэтому в чате не растёт стопка одинаковых списков.
    if (action === 'cl' || action === 'ci') {
      if (action === 'ci') {
        const idx = Number(parts[2] ?? '');
        const items = Number.isInteger(idx) ? await toggleItem(c.env, task, idx) : null;
        await answerCallbackQuery(c.env, cq.id, items ? (items[idx].d ? 'Отмечено' : 'Снято') : 'Список изменился');
      } else {
        await answerCallbackQuery(c.env, cq.id);
      }
      const after = await c.env.DB.prepare('SELECT * FROM tasks WHERE id = ?').bind(task.id).first<Task>();
      // При «cl» сообщение с карточкой править нельзя -- список уходит новым.
      if (after && chat) await showChecklist(c.env, after, chat, action === 'ci' ? msgId : null);
      return c.json({ ok: true });
    }

    // «Начал» -- не переход состояния, а отметка времени: строка остаётся
    // accepted, и автор узнаёт, что человек сел за работу, а не просто
    // согласился.
    if (action === 'start') {
      const ok = await startWork(c.env, task, mine, who.userId);
      await answerCallbackQuery(c.env, cq.id, ok ? 'В работе' : 'Уже отмечено');
      if (ok && chat && msgId) {
        await editMessageReplyMarkup(c.env, chat, msgId, { inline_keyboard: [[openButton(task.id)]] });
      }
      await drainOutbox(c.env);
      return c.json({ ok: true });
    }
    // «✅ Выполнено» -- только у СВОЕЙ задачи: проверять её некому, и сдают её
    // одним нажатием прямо из напоминания. Раньше в «⚠️ Просрочено» была одна
    // «Открыть», а в приложении -- безымянная стрелка «взять в работу», и
    // закрыть своё дело человек не находил как.
    if (action === 'done') {
      const self = task.author_id === who.userId;
      // Закрытую задачу отсеял общий гейт выше; здесь -- своя строка ещё открыта.
      const open = mine.state === 'accepted' || mine.state === 'pending' || mine.state === 'rejected';
      if (!self || !open) {
        await answerCallbackQuery(c.env, cq.id, self ? 'Уже закрыта' : 'Сдают в приложении');
        if (self && chat && msgId) await editMessageReplyMarkup(c.env, chat, msgId, { inline_keyboard: [[openButton(task.id)]] });
        return c.json({ ok: true });
      }
      let row = mine;
      for (const step of row.state === 'pending' ? (['accepted', 'done'] as const) : (['done'] as const)) {
        const res = await transitionAssignee(c.env, { task, assignee: row, to: step, actorId: who.userId });
        if (!res.ok) break;
        row = { ...row, state: step };
      }
      const fresh = await c.env.DB.prepare('SELECT * FROM tasks WHERE id = ?').bind(task.id).first<Task>();
      if (fresh && fresh.status === 'done' && !fresh.confirmed_at) await confirmWork(c.env, fresh, who.userId, false);
      await answerCallbackQuery(c.env, cq.id, 'Выполнено');
      if (chat && msgId) await editMessageReplyMarkup(c.env, chat, msgId, { inline_keyboard: [[openButton(task.id)]] });
      await drainOutbox(c.env);
      return c.json({ ok: true });
    }
    if (action !== 'accept' && action !== 'ack') {
      await answerCallbackQuery(c.env, cq.id);
      return c.json({ ok: true });
    }
    // «Готово» из бота нет: сдают в приложении (решение владельца) -- кроме
    // своей задачи, её закрывают кнопкой выше. Здесь --
    // принять и «ознакомился»; для рассылки «прочитать» accepted и есть закрытие.
    const res = await transitionAssignee(c.env, {
      task, assignee: mine, to: 'accepted', actorId: who.userId,
      notify: action === 'ack'
        ? { emoji: '👁', label: 'Ознакомился' }
        : { emoji: '🚀', label: 'Принято', track: true },
    });
    await answerCallbackQuery(c.env, cq.id, res.ok ? (action === 'ack' ? 'Отмечено' : 'Принято') : 'Уже нельзя');

    // Клавиатура меняется РОВНО ОДИН РАЗ на переход: остаётся только «Открыть».
    // Иначе ту же кнопку можно нажать второй раз и увидеть «уже нельзя» на
    // собственное действие.
    if (res.ok && chat && msgId) {
      // После «Принять» на карточке остаётся следующий шаг -- «Начал». Для
      // рассылки «ознакомиться» его нет: там принятие и есть выполнение.
      await editMessageReplyMarkup(c.env, chat, msgId, {
        inline_keyboard: [
          ...(task.checklist ? [[{ text: '🧾 Список', callback_data: `cl:${task.id}` }]] : []),
          action === 'ack'
            ? [openButton(task.id)]
            : [{ text: '🚀 Начал', callback_data: `start:${task.id}` }, openButton(task.id)],
        ],
      });
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
  // ВХОД В БРАУЗЕРЕ: сайт открыл бота с ключом. Сам переход ничего не
  // подтверждает -- нужна кнопка. Иначе чужую ссылку достаточно было бы
  // открыть, чтобы отдать свою сессию тому, кто её прислал.
  if (start && start[1].startsWith('login_')) {
    const token = start[1].slice('login_'.length);
    const chat = String(msg.chat.id);
    const known = await c.env.DB.prepare('SELECT id FROM users WHERE telegram_user_id = ?').bind(String(msg.from.id)).first<{ id: string }>();
    if (!known || !(await isOnboarded(c.env, known.id))) {
      await sendMessage(c.env, chat, 'Вы ещё не зарегистрированы в Hando. Нажмите /start — это займёт минуту, — а потом войдите на сайте ещё раз.');
    } else if (!(await loginPending(c.env.DB, token))) {
      await sendMessage(c.env, chat, 'Ссылка для входа устарела. Нажмите «Войти через Telegram» на сайте ещё раз.');
    } else {
      await sendMessage(c.env, chat,
        '🔐 <b>Вход в Hando в браузере</b>\n\nПодтвердите, если это вы только что нажали «Войти через Telegram» на сайте. Если нет — нажмите «Это не я»: кто-то прислал вам свою ссылку для входа.',
        { inline_keyboard: [[{ text: '✅ Войти', callback_data: `lg:${token}` }, { text: '✖ Это не я', callback_data: `lgx:${token}` }]] }, true);
    }
    return c.json({ ok: true });
  }
  if (start && start[1].startsWith('j_')) {
    // Личная ссылка-приглашение: заявка уходит её хозяину. Незнакомец сначала
    // называет себя -- в заявке должно стоять имя, а не никнейм.
    const tgName0 = [msg.from.first_name, msg.from.last_name].filter(Boolean).join(' ') || msg.from.username || 'Без имени';
    const uid = await ensureUser(c.env, String(msg.from.id), tgName0, msg.from.username ?? null);
    const code = start[1].slice(2);
    if (!(await isOnboarded(c.env, uid))) {
      // show() пишет состояние экрана -- код ссылки кладём ПОСЛЕ него.
      await show(c.env, String(msg.chat.id), uid, askNameScreen());
      await setState(c.env, uid, { await: 'name', join: code });
      return c.json({ ok: true });
    }
    await applyInvite(c.env, uid, String(msg.chat.id), code);
    const known = await c.env.DB.prepare('SELECT name FROM users WHERE id = ?').bind(uid).first<{ name: string }>();
    await show(c.env, String(msg.chat.id), uid, mainScreen(known?.name ?? tgName0, await myOrgs(c.env, uid)));
    return c.json({ ok: true });
  }
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
  if (text === '/start' || text === '/начать' || text === '/menu' || text === '/меню' || text === '/help' || text === '/помощь') {
    const onboarded = await isOnboarded(c.env, userId);
    if (onboarded) {
      // Тезисы с кнопкой в приложение (раздел 23): без этого никто не поймёт,
      // что куда, -- слова владельца. Кнопка инлайновая: в постоянной
      // клавиатуре приложение и так открывается кнопкой меню Telegram.
      await sendMessage(c.env, chatId, START_TIPS, { inline_keyboard: [[{ text: '📱 Открыть приложение', web_app: { url: `${APP_URL}/` } }]] });
    }
    await show(c.env, chatId, userId, onboarded ? mainScreen(myName, orgs, orgs.length === 0 && await hasPendingJoin(c.env, userId)) : askNameScreen());
    return c.json({ ok: true });
  }
  if (!(await isOnboarded(c.env, userId))) {
    if (!text) return c.json({ ok: true });
    if (!(await setDisplayName(c.env, userId, text))) {
      await show(c.env, chatId, userId, askNameScreen());
      return c.json({ ok: true });
    }
    await sendMessage(c.env, chatId, `Приятно познакомиться, ${text.trim()}.`);
    // Заявка -- СРАЗУ после знакомства, до тезисов: человек пришёл по ссылке
    // ради неё, и ответ на своё действие он должен увидеть первым, а не
    // выкапывать из-под рассказа о продукте.
    if (st.join) {
      await setState(c.env, userId, {});
      await applyInvite(c.env, userId, chatId, st.join);
    }
    // Тезисы -- следом: до этого /start показывал только вопрос об имени, и
    // новичок не видел, что бот умеет.
    await sendMessage(c.env, chatId, START_TIPS, { inline_keyboard: [[{ text: '📱 Открыть приложение', web_app: { url: `${APP_URL}/` } }]] });
    await show(c.env, chatId, userId, mainScreen(text.trim(), await myOrgs(c.env, userId), await hasPendingJoin(c.env, userId)));
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
    await setState(c.env, userId, { ...st, await: undefined, task: undefined, ask: undefined });
    st.await = undefined;
  }

  // fix/late/decline разбираются в хвосте: там фраза уже расшифрована и с голоса.
  if (st.await && st.await !== 'fix' && st.await !== 'late' && st.await !== 'decline' && text) {
    if (st.await === 'new') {
      // Название запомнили, теперь профиль: он решает, какие отделы завести.
      await show(c.env, chatId, userId, categoryScreen(text.slice(0, 60)));
      return c.json({ ok: true });
    }
    if (st.await === 'pack') {
      const orgDraft = st.draft ?? 'Моё пространство';
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
      if (!(await canCreateOrg(c.env, userId))) {
        await sendMessage(c.env, chatId, 'У Вас уже много пространств. Удалите ненужное, чтобы создать новое.');
        await show(c.env, chatId, userId, mainScreen(myName, orgs));
        return c.json({ ok: true });
      }
      const { code, departments } = await createOrg(c.env, userId, orgName, chosen.id);
      await sendMessage(c.env, chatId, [
        `Пространство «${orgName}» создано. Вы его владелец.`,
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
    if (st.await === 'digest_time') {
      const mine = orgs.find((o) => o.is_current) ?? orgs[0];
      const ok = mine ? await updateOrgSettings(c.env, userId, mine.id, { digest_time: text.trim() }) : false;
      await sendMessage(c.env, chatId, ok ? 'Час сводки поставлен.' : 'Не понял час. Напишите как 08:30.');
      if (mine) {
        const fresh = (await myOrgs(c.env, userId)).find((o) => o.id === mine.id) ?? mine;
        await show(c.env, chatId, userId, settingsScreen(await notifyPrefs(c.env, userId), { ...fresh, id: fresh.id }, await isOrgOwner(c.env, userId, mine.id)));
      }
      return c.json({ ok: true });
    }
    // st.await === 'join'
    const res = await joinByCode(c.env, userId, text);
    if (!res.ok) {
      await sendMessage(c.env, chatId,
        res.reason === 'unknown_code' ? 'Код не подошёл. Проверьте у того, кто его дал.'
        : res.reason === 'already_member' ? 'Вы уже в этом пространстве.'
        : 'Заявка уже подана, ждём подтверждения.');
      await show(c.env, chatId, userId, mainScreen(myName, orgs));
      return c.json({ ok: true });
    }
    await sendMessage(c.env, chatId, `Заявка в «${res.orgName}» отправлена. Ждём подтверждения.`);
    // Карточка решающему -- инлайновой клавиатурой НАМЕРЕННО: кнопка привязана
    // к этому человеку и к этой заявке, а не к навигации.
    await notifyApprover(c.env, res, userId);
    return c.json({ ok: true });
  }

  // ------------------------------------------------------- нажатия клавиатуры
  //
  // Reply-кнопка присылает свой текст, поэтому нажатие -- это совпадение с
  // подписью. Экран учитывается: «‹ Назад» на разных экранах ведёт в разное.
  const current = orgs.find((o) => o.is_current) ?? orgs[0];
  const orgsView = async () => show(c.env, chatId, userId, orgsScreen(orgs,
    current ? (await pendingRequests(c.env, current.id, userId)).length : 0,
    !!current && current.role !== 'member'));

  switch (text) {
    case BTN.tasks:
    case BTN.assigned: {
      if (!current) return c.json({ ok: true });
      const page = await taskPage(c.env, userId, current.id, text === BTN.tasks ? 'm' : 'a', 0);
      await sendMessage(c.env, chatId, page.text, page.kb);
      return c.json({ ok: true });
    }
    case BTN.orgs:
      await orgsView();
      return c.json({ ok: true });
    case BTN.create:
    case BTN.createShort:
      await setState(c.env, userId, { await: 'new', screen: st.screen });
      await sendMessage(c.env, chatId, 'Как назвать пространство?');
      return c.json({ ok: true });
    case BTN.join:
    case BTN.joinShort:
      await setState(c.env, userId, { await: 'join', screen: st.screen });
      await sendMessage(c.env, chatId, 'Пришлите код пространства.');
      return c.json({ ok: true });
    case BTN.back:
      // «Назад» зависит от экрана: из настроек -- в организации, иначе на главный.
      if (st.screen === 'settings') await orgsView();
      else await show(c.env, chatId, userId, mainScreen(myName, orgs, orgs.length === 0 && await hasPendingJoin(c.env, userId)));
      return c.json({ ok: true });
    case BTN.home:
      // «На главную» -- всегда домой, из любого места и с любого шага.
      await setState(c.env, userId, {});
      await show(c.env, chatId, userId, mainScreen(myName, orgs, orgs.length === 0 && await hasPendingJoin(c.env, userId)));
      return c.json({ ok: true });
    case BTN.requests: {
      if (!current) return c.json({ ok: true });
      const list = await pendingRequests(c.env, current.id, userId);
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
      await showDrafts(c.env, chatId, who2.userId, who2.orgId);
      return c.json({ ok: true });
    }
    case BTN.settings:
    case BTN.notifyAll:
    case BTN.notifySchedule:
    case BTN.remind15:
    case BTN.remind30:
    case BTN.remind60:
    case BTN.digestOn:
    case BTN.digestOff: {
      const mine = orgs.find((o) => o.is_current) ?? orgs[0];
      if (!mine) return c.json({ ok: true });
      if (text === BTN.notifyAll || text === BTN.notifySchedule) {
        await setNotifyPrefs(c.env, userId, { notify_mode: text === BTN.notifyAll ? 'all' : 'schedule' });
      } else if (text === BTN.remind15 || text === BTN.remind30 || text === BTN.remind60) {
        await setNotifyPrefs(c.env, userId, { remind_before_min: text === BTN.remind15 ? 15 : text === BTN.remind30 ? 30 : 60 });
      } else if (text === BTN.digestOn || text === BTN.digestOff) {
        await updateOrgSettings(c.env, userId, mine.id, { digest_enabled: text === BTN.digestOn ? 1 : 0 });
      }
      const fresh = (await myOrgs(c.env, userId)).find((o) => o.id === mine.id) ?? mine;
      await show(c.env, chatId, userId, settingsScreen(await notifyPrefs(c.env, userId), { ...fresh, id: fresh.id }, await isOrgOwner(c.env, userId, mine.id)));
      return c.json({ ok: true });
    }
    case BTN.digestTime: {
      await setState(c.env, userId, { ...st, await: 'digest_time', screen: 'settings' });
      await sendMessage(c.env, chatId, 'В какой час присылать сводку? Напишите, например: 08:30');
      return c.json({ ok: true });
    }
    case BTN.invite: {
      if (!current) return c.json({ ok: true });
      const code = await inviteCodeFor(c.env, current.id, userId);
      await sendMessage(c.env, chatId, code
        ? `Ваша ссылка-приглашение в «${current.name}»:\n${inviteLink(code)}\n\nКто перейдёт по ней, подаст заявку Вам — Вы её подтверждаете и выбираете роль и отдел.`
        : 'Приглашать могут владелец и руководители отделов.');
      return c.json({ ok: true });
    }
  }

  // Выбор организации из списка: тап -- переключение, без вопросов (раздел 18).
  if (st.screen === 'orgs' && text) {
    const picked = orgs.find((o) => `${o.is_current ? '● ' : '○ '}${o.name}` === text);
    if (picked) {
      if (!picked.is_current) await switchOrg(c.env, userId, picked.id);
      await show(c.env, chatId, userId, mainScreen(myName, await myOrgs(c.env, userId)));
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

  // Команд со слешем больше нет: ими никто не пользовался, а кнопки делают то
  // же самое. Осталась /start -- её требует сам Telegram при первом входе.

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
  const sched = await loadSchedule(c.env, who.orgId);
  const tz = sched.timezone;

  // Справочник -- те, КОМУ ЭТОТ ЧЕЛОВЕК ВПРАВЕ ПОРУЧАТЬ (дерево, раздел 19),
  // а не вся организация: имя из чужого отдела не должно узнаваться вовсе.
  const people = await assignableMembers(c.env, who.orgId, who.userId, who.role);
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
    await sendMessage(c.env, chat, ok ? 'Передал автору.' : 'Уже нельзя: задача изменилась.',
      { inline_keyboard: [[openButton(task.id)]] });
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

  // ПОПРАВКА БЕЗ ОТВЕТА НА КАРТОЧКУ.
  //
  // Бот понимал поправку только ответом на сообщение -- а голосом «ответить на
  // сообщение» никто не делает. «Надо в содержании изменить: не оппонентскую
  // плату, а абонентскую» уходило новым черновиком с темой «Изменить
  // содержание», а исправляемый оставался с ошибкой.
  //
  // Правило УЗКОЕ, иначе «заменить картридж» стало бы правкой чужого черновика.
  // Поправкой считается только то, что без черновика смысла не имеет: названо
  // поле («в содержании», «в теме») ИЛИ заменяемое слово реально стоит в
  // свежем черновике. И только свежем -- через полчаса это уже другой разговор.
  if (!target && phrase) {
    const last = await latestDraft(c.env, who.userId, who.orgId);
    const age = last ? Date.now() - Date.parse(last.updated_at ?? last.created_at) : Infinity;
    const namesField = /(?:^|[\s,])(?:в|во)\s+(?:содержани|тем[еуы]|назван|описани)[а-яё]*/i.test(phrase);
    const swaps = last ? (swapWords(phrase, last.title) ?? swapWords(phrase, last.description ?? '')) : null;
    if (last && age < 30 * 60_000 && (namesField || swaps)) target = last;
  }
  if (target && target.author_id === who.userId) {
    const patch: DraftPatch = {};
    // Голос поправки -- не вложение: вложение это фото и документ.
    if (media && !media.hasAudio) patch.media = [...mediaOf(target), media];
    const before = assigneesOf(target);
    if (phrase) {
      Object.assign(patch, await refineDraft(c.env, {
        title: target.title, description: target.description, assigneeIds: before, deadline: target.deadline,
        priority: target.priority, priorityExplicit: target.priority_explicit === 1,
      }, phrase, roster, tz, org?.industry_pack, new Date(), dayEnd(sched), weekEndDay(sched)));
      // Адресата сменили -- значит человека назвали словом, которого правила не
      // знают. Запоминаем его: следующая такая фраза разберётся без модели.
      const now = patch.assigneeIds;
      if (now?.length === 1 && !before.includes(now[0])) await learnAlias(c.env, phrase, roster, now[0]);
    }
    const updated = await patchDraft(c.env, target.id, patch);
    // Поправка = разобрали неверно. Отмечаем сами: командой /промах этого никто
    // не делал, а без знаменателя метрика точности не считается.
    if (Object.keys(patch).length > 0) await logMiss(c.env, who.userId, who.orgId);
    if (st.await === 'fix') await setState(c.env, userId, { ...st, await: undefined, fix: undefined });

    // НЕ ПОНЯЛИ -- так и говорим. Раньше карточка молча перерисовывалась той же,
    // и человек не знал, дошла ли поправка вообще.
    if (Object.keys(patch).length === 0) {
      await sendMessage(c.env, chat, 'Не понял, что поправить. Скажите, например: «не Азизу, а Беку», «срок вторник», «в содержании не USEL, а Ucell».');
      return c.json({ ok: true });
    }

    // Поправка пришла ОТДЕЛЬНЫМ сообщением -- значит, человек смотрит в НИЗ
    // чата, а не на карточку выше. Правка на месте была невидима: карточка
    // менялась где-то наверху, а внизу -- тишина, и выглядело так, будто бот не
    // ответил вовсе (владелец: «отправил сообщение, а бот не отвечает» -- хотя
    // тема уже была исправлена). Поэтому старая карточка уходит, а исправленная
    // приходит заново -- прямо под поправкой. Двух карточек одного черновика с
    // живыми кнопками быть не должно: старую удаляем до отправки новой.
    //
    // Кнопки под карточкой по-прежнему правят её НА МЕСТЕ: там человек смотрит
    // ровно на неё.
    // Старую карточку renderDraft убирает сам.
    if (updated) await renderDraft(c.env, updated, chat, tz, true);
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
    // Черновика нет -- заводим его прямо сейчас, с файлом и пустой темой.
    //
    // Правило владельца: присланный после создания задачи файл -- это уже
    // НОВАЯ задача. Раньше бот просил подпись и ничего не создавал, и файл
    // висел в чате сам по себе; теперь он сразу лежит в черновике, который
    // видно и в «Черновиках», а карточка спрашивает, чего он касается.
    const row = await saveDraft(c.env, who, {
      title: '', assigneeIds: [], deadline: null, priority: 'medium',
      priorityExplicit: false, kind: 'single', source: 'pattern', ambiguous: [],
    }, '', [media]);
    await renderDraft(c.env, row, chat, tz, true);
    return c.json({ ok: true });
  }

  // ------------------------------------------------ вопрос, просьба или поручение
  //
  // Режима «Вопрос» больше нет: одна строка ввода принимает всё, а решает
  // СМЫСЛ фразы. Вопрос -- отвечаем; просьба к боту («удали», «напомни») --
  // выполняем; остальное -- поручение, то есть черновик. Ошибка стоит одного
  // нажатия: под ответом висит «Это поручение», под черновиком -- «Отменить».
  // Дальше может быть сеть: разбор намерения, ответ помощника, разбор фразы.
  // Человеку в чате видно, что бот занят, -- иначе тишина читается как «не дошло».
  await sendTyping(c.env, chat);

  // КОМАНДА ПО ДЕЙСТВУЮЩЕЙ ЗАДАЧЕ идёт первой -- до разбора намерения. «Взял в
  // работу подготовить отчёт», «перенеси срок по «сдать отчёт» на пятницу» --
  // это не вопрос и не новое поручение, а распоряжение о том, что уже создано,
  // и классификатор развёл бы их в одно из двух неверных русел. Срабатывает
  // только при глаголе команды И дословно названной теме -- см.
  // commandTaskByPhrase; иначе фраза идёт дальше и становится черновиком.
  //
  // ОТВЕТ НА СООБЩЕНИЕ О ЗАДАЧЕ -- о ней и речь. «Напомни ещё раз ему» в ответ
  // на «⚠️ Артур просрочил «Подготовь IT-CV»» кончалось вопросом «какое именно
  // поручение?»: бот не связывал ответ с собственным сообщением. Задачу даёт
  // кнопка «📱 Открыть» исходного сообщения -- она есть под каждым сообщением о
  // задаче, а подделать её в личке с ботом нельзя. И только своей организации.
  const quoted = msg.reply_to_message;
  const pointedId = /[?&]task=([\w-]+)/.exec(JSON.stringify(quoted?.reply_markup ?? {}))?.[1];
  const pointed = pointedId
    ? await c.env.DB.prepare('SELECT * FROM tasks WHERE id = ? AND org_id = ?').bind(pointedId, who.orgId).first<Task>()
    : null;
  const edited = await commandTaskByPhrase(c.env, who, phrase, tz, org?.industry_pack, dayEnd(sched), weekEndDay(sched), new Date(), pointed);
  if (edited) {
    await sendMessage(c.env, chat, edited.text, { inline_keyboard: [[openButton(edited.taskId)]] });
    await drainOutbox(c.env);
    return c.json({ ok: true });
  }

  const named = matchPeople(phrase, roster).ids.length > 0;

  // Разговор живёт двадцать минут. Вчерашние реплики -- не контекст, а помеха:
  // они меняют смысл сегодняшнего вопроса и закрывают ему память ответов,
  // потому что продолжение диалога из общей памяти брать нельзя.
  const fresh = st.askAt ? Date.now() - Date.parse(st.askAt) < 20 * 60 * 1000 : false;
  const history = fresh ? (st.ask ?? []) : [];
  // Помощнику и модели -- и само сообщение, на которое ответили: «а когда
  // срок?» в ответ на карточку понятно только вместе с ней.
  const said = pointed && quoted?.text ? [...history, { role: 'assistant' as const, text: quoted.text }] : history;

  // ОТВЕТ НА ВОПРОС БОТА -- продолжение разговора, а не новая фраза.
  //
  // Бот спросил «какие именно?», человек ответил «все» -- и это становилось
  // задачей с темой «Все». Классификатор смотрит на одну фразу и не знает, что
  // её у человека только что спросили; сама по себе «все» на поручение и
  // правда похожа больше, чем на вопрос.
  //
  // Названный человек отменяет правило: «Азизу подготовить отчёт» -- поручение,
  // даже если бот перед этим что-то спрашивал.
  const lastSaid = history.at(-1);
  const answering = !named && lastSaid?.role === 'assistant' && /\?\s*$/.test(lastSaid.text.trim());

  const answer = async () => {
    if (asksOwnDrafts(phrase)) {
      await showDrafts(c.env, chat, userId, who.orgId);
      return;
    }
    const meRow = await c.env.DB.prepare('SELECT name FROM users WHERE id = ?').bind(userId).first<{ name: string }>();
    const reply = await askAssistant(c.env, { userId, orgId: who.orgId, role: who.role, name: meRow?.name ?? '' }, phrase, said);
    await sendMessage(c.env, chat, reply, { inline_keyboard: [[{ text: '📌 Это поручение', callback_data: 'as_task' }]] });
    await setState(c.env, userId, {
      ...st, said: phrase, askAt: nowIso(),
      ask: [...said, { role: 'user' as const, text: phrase }, { role: 'assistant' as const, text: reply }].slice(-6),
    });
  };

  // МОДЕЛЬ С ДЕЙСТВИЯМИ (brain.ts): видит людей, задачи, черновики и разговор
  // и сама выбирает, что сделать. Не ответила внятно -- ниже прежний путь
  // правил. Пропускается, пока висит «кого именно?»: ответ на него дополняет
  // запомненную фразу, и это умеет только старый путь.
  const whomPending = !!st.whom && !!st.whomAt && Date.now() - Date.parse(st.whomAt) < 20 * 60 * 1000;
  const turn = whomPending ? null
    : await brainTurn(c.env, who, phrase, chat, media ?? null, said, roster, sched, org?.industry_pack, pointed?.id);
  if (turn) {
    for (const what of turn.show) {
      if (what === 'drafts') await showDrafts(c.env, chat, userId, who.orgId);
      else {
        const page = await taskPage(c.env, userId, who.orgId, what === 'my_tasks' ? 'm' : 'a', 0);
        await sendMessage(c.env, chat, page.text, page.kb);
      }
    }
    if (turn.ask) await answer();
    else if (turn.asked) {
      // Уточняющий вопрос -- в историю разговора: следующая фраза его ответ.
      await setState(c.env, userId, {
        ...st, askAt: nowIso(),
        ask: [...history, { role: 'user' as const, text: phrase }, { role: 'assistant' as const, text: turn.asked }].slice(-6),
      });
    } else if (history.length) {
      // Сделано -- разговор закрыт. Иначе висящее «Какую задачу перенести?»
      // двадцать минут читалось бы вопросом к каждой следующей фразе.
      await setState(c.env, userId, { ...st, ask: undefined, askAt: undefined });
    }
    return c.json({ ok: true });
  }

  if (answering || await classifyIntent(c.env, phrase, named) === 'ask') {
    await answer();
    return c.json({ ok: true });
  }

  // ------------------------------------------------ новый черновик

  // ОТВЕТ НА «КОГО ИМЕННО?»: разбираем ЗАПОМНЕННУЮ фразу, а адресата берём из
  // ответа. Так «Азизу подготовить отчёт» + «Каримов» даёт поручение целиком,
  // а не черновик с темой «Каримов».
  const whomFresh = st.whomAt ? Date.now() - Date.parse(st.whomAt) < 20 * 60 * 1000 : false;
  const clarified = whomFresh && st.whom ? matchPeople(phrase, roster) : null;
  if (st.whom && clarified && clarified.ids.length === 1 && clarified.ambiguous.length === 0) {
    // Разбираем с СОКРАЩЁННЫМ списком людей: двойника в нём уже нет, и потому
    // «Азизу» в старой фразе теперь однозначен. Иначе разбор снова упёрся бы в
    // ту же неоднозначность и по-честному вернул бы ПУСТУЮ тему (parse.ts:543).
    //
    // Оставляем и тех, кого фраза назвала однозначно: у рассылки на двоих
    // второй адресат не должен пропасть из-за чужого тёзки.
    const keep = new Set([...matchPeople(st.whom, roster).ids, ...clarified.ids]);
    const narrowed = roster.filter((p) => keep.has(p.id));
    const back = await parseTask(c.env, st.whom, narrowed, who.userId, tz, new Date(), org?.industry_pack, dayEnd(sched), weekEndDay(sched));
    await setState(c.env, userId, { ...st, whom: undefined, whomAt: undefined });
    const row = await saveDraft(c.env, who, { ...back, assigneeIds: back.assigneeIds.length ? back.assigneeIds : clarified.ids, ambiguous: [] }, st.whom, media ? [media] : []);
    await renderDraft(c.env, row, chat, tz);
    return c.json({ ok: true });
  }

  const draft = await parseTask(c.env, phrase, roster, who.userId, tz, new Date(), org?.industry_pack, dayEnd(sched), weekEndDay(sched));

  // Черновик БЕЗ ТЕМЫ ждёт ответа на свой же вопрос «чего это касается?».
  //
  // Такой рождается из файла без подписи. Без этой ветки следующая фраза
  // заводила ВТОРОЙ черновик, а первый оставался висеть с файлом и пустой
  // темой -- то есть вопрос карточки было некуда ответить.
  const waiting = await latestDraft(c.env, who.userId, who.orgId);
  if (waiting && !waiting.title.trim() && draft.ambiguous.length === 0) {
    const updated = await patchDraft(c.env, waiting.id, {
      title: draft.title,
      description: draft.description ?? null,
      assigneeIds: draft.assigneeIds,
      deadline: draft.deadline,
      priority: draft.priority,
      priorityExplicit: draft.priorityExplicit,
      kind: draft.kind,
    });
    if (updated) await renderDraft(c.env, updated, chat, tz);
    return c.json({ ok: true });
  }

  // Неоднозначное имя -- ПЕРЕСПРОС, а не догадка. Поручение, ушедшее не тому,
  // дороже одного вопроса. Фраза при этом ЗАПОМИНАЕТСЯ: раньше она пропадала
  // целиком, и на ответ «Каримов» бот заводил черновик с темой «Каримов», а
  // продиктованное поручение приходилось наговаривать заново.
  if (draft.ambiguous.length > 0) {
    await setState(c.env, userId, { ...st, whom: phrase, whomAt: nowIso() });
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
