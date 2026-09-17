// Cron (каждые 5 минут): архив залежавшихся Done, матрица напоминаний
// (раздел 21), сводка в начало рабочего дня, поводы и страховка за очередь.
import type { Env, Task } from './types';
import { chunks, nowIso, uuid } from './db';
import { reconcileWebhook, type InlineButton } from './telegram';
import { applyTransition, assigneeButtons, openButton } from './transition';
import { drainOutbox } from './outbox';
import { enqueueNudges } from './nudges';
import { formatWhen } from './parse';
import { digestAt, hm, inWorkHours, isWorkDay, localHm, sameLocalDay, scheduleCols, type OrgSchedule } from './schedule';
import { listDrafts, renderDraft } from './drafts';

// Тот же домен, что в transition.ts: адрес воркера один.
const APP_URL = 'https://hando.alrevion.com';

const SEVEN_DAYS_MS = 7 * 24 * 60 * 60 * 1000;
const HOUR_MS = 60 * 60 * 1000;
const REVIEW_WINDOW_MS = 2 * 24 * HOUR_MS;
// Повтор «раз в час» считается с запасом: тик идёт каждые 5 минут, и ровно 60
// минут попали бы то в один тик, то в следующий.
const HOURLY_MS = 55 * 60 * 1000;
const DAILY_MS = 23 * HOUR_MS;
const ONCE = Number.POSITIVE_INFINITY;

export async function scheduled(controller: ScheduledController, env: Env, _ctx: ExecutionContext): Promise<void> {
  const now = new Date();
  // Каждый проход -- сам по себе: упавший проход не должен отменять слив
  // очереди (страховку доставки) и самопочинку вебхука в этом же тике.
  const guard = async (name: string, fn: () => Promise<unknown>) => {
    try { await fn(); } catch (err) { console.error(`cron ${name} failed`, err); }
  };
  // Тик -- КАЖДУЮ МИНУТУ, но поминутно идёт только срок: «напомни через
  // минуту» при пятиминутном тике приходило через шесть. Остальное --
  // непринятые, просрочки, сводка -- дозируется часами и сутками, и гонять
  // его чаще раза в пять минут значило бы впятеро больше читать базу впустую.
  // Минута -- из расписания, а не из часов: тик может начаться на секунду
  // позже. Вызов без расписания (тест, ручной запуск) -- полный проход.
  const full = !controller.scheduledTime || new Date(controller.scheduledTime).getUTCMinutes() % 5 === 0;
  if (full) {
    await guard('autoArchive', () => autoArchive(env));
    await guard('notAccepted', () => remindNotAccepted(env, now));
  }
  await guard('dueSoon', () => remindDueSoon(env, now));
  if (full) {
    await guard('overdue', () => remindOverdue(env, now));
    await guard('staleReview', () => remindStaleReview(env));
    await guard('digests', () => sendDigests(env, now));
    // Поводы ставятся ДО слива очереди: иначе выданный сейчас повод ждал бы
    // следующего тика.
    await guard('nudges', () => enqueueNudges(env));
  }
  // Страховка за отправку: роуты сливают outbox сразу после ответа, но если тот
  // вызов не дошёл, строка так и лежит с sent_at IS NULL -- здесь она уедет.
  await guard('outbox', () => drainOutbox(env, now));
  // Самопочинка вебхука: без неё регистрация была бы ручным шагом с токеном
  // бота, а сбившийся вебхук пришлось бы замечать по молчанию бота.
  if (full) await guard('webhook', () => reconcileWebhook(env, APP_URL));
}

// (a) status='done' + done_at older than 7 days -> archived (system-generated event).
// Единственная ветка cron, которая пишет status, -- и потому единственная, что
// идёт через applyTransition. Остальные проходы пишут только журнал напоминаний.
async function autoArchive(env: Env): Promise<void> {
  // Порог -- в SQL: выбирать все закрытые задачи за всё время и отсеивать в
  // коде значило бы читать растущую таблицу каждые пять минут.
  const cutoff = new Date(Date.now() - SEVEN_DAYS_MS).toISOString();
  const { results } = await env.DB.prepare(
    "SELECT * FROM tasks WHERE status = 'done' AND done_at IS NOT NULL AND datetime(done_at) <= datetime(?) LIMIT 200",
  ).bind(cutoff).all<Task>();
  for (const t of results) {
    // actorId null -- отметка «сделала система»: по ней архив отличают от ручного.
    // Уведомления нет намеренно: автоархив семидневной давности никого не касается.
    await applyTransition(env, { task: t, to: 'archived', actorId: null, action: 'archived' });
  }
}

// Общая постановка напоминания в ОЧЕРЕДЬ, а не прямая отправка.
//
// До ревью проходы звали sendMessage напрямую и слали В ГРУППОВОЙ ЧАТ текст с
// заголовком задачи. Это нарушало сразу два решения: ADR-4 (заголовок только в
// личку) и шаг 4d (тихие часы в ЕДИНСТВЕННОЙ точке отправки). Теперь у cron
// нет своего пути отправки вообще. `gated` -- рабочее напоминание, идёт только в
// рабочее время графика; `urgent` -- срок и просрочка, идут всегда.
function queueReminder(
  env: Env,
  row: { task_id: string; org_id: string; user_id: string },
  text: string,
  kind: string,
  opts: { urgent?: boolean; gated?: boolean; buttons?: InlineButton[][] },
): D1PreparedStatement {
  return env.DB.prepare(
    `INSERT INTO notifications (id, task_id, assignee_id, org_id, kind, payload, scheduled_at)
     VALUES (?, ?, ?, ?, ?, ?, ?)`,
  ).bind(uuid(), row.task_id, row.user_id, row.org_id, kind, JSON.stringify({
    recipient_user_id: row.user_id,
    text,
    delete_message_id: null,
    track: false,
    urgent: opts.urgent === true,
    gated: opts.gated === true,
    keyboard: [...(opts.buttons ?? []), [openButton(row.task_id)]],
  }), nowIso());
}

// Строка адресата со всем, что нужно матрице: задача, человек, график.
type Row = {
  id: string; due_at: string | null; state: string; user_id: string;
  task_id: string; title: string; org_id: string; author_id: string | null; kind: string; created_at: string; repeat_min: number | null;
  responsible_name: string; remind_before_min: number;
} & Omit<OrgSchedule, 'id'>;

const ROW_COLS = `a.id, a.due_at, a.state, a.user_id, t.id AS task_id, t.title, t.org_id, t.author_id, t.kind, t.created_at, t.repeat_min,
       u.name AS responsible_name, COALESCE(u.remind_before_min, 30) AS remind_before_min, ${scheduleCols('o')}`;

/**
 * Журнал: что по этой строке уже слали. Ключ -- «строка:вид». Разовые виды
 * шлются, пока записи нет; повторяющиеся -- когда прошлая старше интервала.
 * Это единственное, что стоит между человеком и двенадцатью сообщениями в час.
 */
async function sentLog(env: Env, rowIds: string[]): Promise<Map<string, number>> {
  const map = new Map<string, number>();
  // Кусками: предел D1 -- 100 параметров, а строки здесь со ВСЕХ арендаторов.
  for (const part of chunks(rowIds)) {
    const { results } = await env.DB.prepare(
      `SELECT assignee_row_id, kind, sent_at FROM reminders WHERE assignee_row_id IN (${part.map(() => '?').join(',')})`,
    ).bind(...part).all<{ assignee_row_id: string; kind: string; sent_at: string }>();
    for (const r of results) map.set(`${r.assignee_row_id}:${r.kind}`, Date.parse(r.sent_at));
  }
  return map;
}

function dueNow(log: Map<string, number>, rowId: string, kind: string, gapMs: number, now: Date): boolean {
  const last = log.get(`${rowId}:${kind}`);
  if (last === undefined) return true;
  return now.getTime() - last >= gapMs;
}

function mark(env: Env, rowId: string, kind: string, now: Date): D1PreparedStatement {
  return env.DB.prepare('INSERT OR REPLACE INTO reminders (assignee_row_id, kind, sent_at) VALUES (?, ?, ?)')
    .bind(rowId, kind, now.toISOString());
}

/** Рабочее ли сейчас время у организации строки. Повторы по графику ставятся
 *  только в него: иначе они копились бы у головы очереди до утра. */
const working = (r: Row, now: Date) => inWorkHours({ ...r, id: r.org_id }, now);

/** Кнопка автору под напоминанием: переназначить, если это не рассылка. */
function authorButtons(r: Row): InlineButton[][] {
  return r.kind === 'each' ? [] : [[{ text: '👤 Переназначить', callback_data: `ra:${r.task_id}:` }]];
}

/** Когда поставлена задача: created_at бывает и ISO, и SQLite-строкой без пояса. */
const bornAt = (r: Row) => Date.parse(r.created_at.includes('T') ? r.created_at : `${r.created_at.replace(' ', 'T')}Z`);

// (b) НЕ ПРИНЯЛ. Адресату -- через час после постановки; если срок сегодня --
// каждый час. Автору -- через три часа, один раз.
export async function remindNotAccepted(env: Env, now: Date): Promise<void> {
  const { results } = await env.DB.prepare(
    `SELECT ${ROW_COLS}
     FROM task_assignees a
     JOIN tasks t ON t.id = a.task_id
     JOIN users u ON u.id = a.user_id
     JOIN orgs o ON o.id = t.org_id
     JOIN projects p ON p.id = t.project_id
     WHERE a.state = 'pending' AND p.archived_at IS NULL AND o.archived_at IS NULL
       AND t.status NOT IN ('archived','done')
       -- Своя строка «не принято» не напоминается: принимать своё незачем.
       -- Новые такие строки не рождаются вовсе (initialState), это страховка
       -- от любой будущей двери, которая заведёт строку в обход неё.
       AND (t.author_id IS NULL OR a.user_id <> t.author_id)`,
  ).all<Row>();
  const log = await sentLog(env, results.map((r) => r.id));
  const writes: D1PreparedStatement[] = [];
  for (const r of results) {
    const age = now.getTime() - bornAt(r);
    if (age < HOUR_MS) continue;
    // КАЖДЫЙ ЧАС, пока не принял, а не один раз. Одно напоминание теряется в
    // ленте Telegram за ночь, и поручение висит непринятым до утра, хотя
    // человек в телефоне. Тишина и график по-прежнему держат: working()
    // проверяется тем же условием, поэтому ночью у конторы не звонит.
    // Останавливает это сам человек -- «Принять», «Не успею» или «Отказать»:
    // любое из трёх уводит строку из pending, и выборка её больше не видит.
    if (working(r, now) && dueNow(log, r.id, 'not_accepted', HOURLY_MS, now)) {
      writes.push(queueReminder(env, r,
        `⏳ Не принято: «${r.title}»${r.due_at ? `\nСрок: ${formatWhen(r.due_at, r.timezone)}` : ''}\nПримите или откажитесь — автор ждёт.`,
        'not_accepted', { gated: true, buttons: assigneeButtons({ id: r.task_id, kind: r.kind, author_id: r.author_id }, r.user_id) }));
      writes.push(mark(env, r.id, 'not_accepted', now));
    }
    if (working(r, now) && age >= 3 * HOUR_MS && r.author_id && r.author_id !== r.user_id && dueNow(log, r.id, 'author_not_accepted', ONCE, now)) {
      writes.push(queueReminder(env, { task_id: r.task_id, org_id: r.org_id, user_id: r.author_id },
        `⏳ ${r.responsible_name} не принял «${r.title}» (уже ${Math.floor(age / HOUR_MS)} ч).`,
        'author_not_accepted', { gated: true, buttons: authorButtons(r) }));
      writes.push(mark(env, r.id, 'author_not_accepted', now));
    }
  }
  if (writes.length) await env.DB.batch(writes);
}

// (c) СРОК БЛИЗКО: за час, за N минут (настройка человека), в срок. Всегда,
// сквозь график и тихие часы: предупреждение после провала бесполезно.
export async function remindDueSoon(env: Env, now: Date): Promise<void> {
  const { results } = await env.DB.prepare(
    `SELECT ${ROW_COLS}
     FROM task_assignees a
     JOIN tasks t ON t.id = a.task_id
     JOIN users u ON u.id = a.user_id
     JOIN orgs o ON o.id = t.org_id
     JOIN projects p ON p.id = t.project_id
     WHERE a.state IN ('pending','accepted','rejected') AND a.due_at IS NOT NULL
       AND p.archived_at IS NULL AND o.archived_at IS NULL
       AND t.status NOT IN ('archived','done')`,
  ).all<Row>();
  const log = await sentLog(env, results.map((r) => r.id));
  const writes: D1PreparedStatement[] = [];
  for (const r of results) {
    const left = Date.parse(r.due_at as string) - now.getTime();
    const shoot = (kind: string, text: string) => {
      writes.push(queueReminder(env, r, text, kind, { urgent: true }));
      writes.push(mark(env, r.id, kind, now));
    };
    // Повтор чаще суток -- дело минутное: «каждые два часа» с напоминанием за
    // час до срока напоминало бы почти непрерывно. Для таких задач остаётся
    // только «срок наступил» и просрочка.
    const tight = r.repeat_min !== null && r.repeat_min < 24 * 60;
    // Предупреждение «за час» -- только если задача появилась РАНЬШЕ, чем за
    // час. «Напомни через 2 минуты» иначе получало «⏰ Через час срок» на
    // первом же проходе: до срока меньше часа, значит окно открыто.
    const lead = Date.parse(r.due_at as string) - bornAt(r);
    if (!tight && lead > HOUR_MS && left > 0 && left <= HOUR_MS && dueNow(log, r.id, 'before_1h', ONCE, now)) {
      shoot('before_1h', `⏰ Через час срок: «${r.title}»`);
    }
    const n = r.remind_before_min;
    if (!tight && n > 0 && n !== 60 && lead > n * 60 * 1000 && left > 0 && left <= n * 60 * 1000 && dueNow(log, r.id, 'before_n', ONCE, now)) {
      shoot('before_n', `⏰ ${n % 60 === 0 ? `Через ${n / 60} ч` : `Через ${n} мин`} срок: «${r.title}»`);
    }
    if (left <= 0 && -left < HOUR_MS && dueNow(log, r.id, 'at_due', ONCE, now)) {
      shoot('at_due', `🔔 Срок наступил: «${r.title}»`);
    }
  }
  if (writes.length) await env.DB.batch(writes);
}

// (d) ПРОСРОЧЕНО: адресату каждый час в рабочее время, автору раз в день.
export async function remindOverdue(env: Env, now: Date): Promise<void> {
  const { results } = await env.DB.prepare(
    `SELECT ${ROW_COLS}
     FROM task_assignees a
     JOIN tasks t ON t.id = a.task_id
     JOIN users u ON u.id = a.user_id
     JOIN orgs o ON o.id = t.org_id
     JOIN projects p ON p.id = t.project_id
     WHERE a.state IN ('pending','accepted','rejected') AND a.due_at IS NOT NULL
       AND p.archived_at IS NULL AND o.archived_at IS NULL
       AND t.status NOT IN ('archived','done')`,
  ).all<Row>();
  const log = await sentLog(env, results.map((r) => r.id));
  const writes: D1PreparedStatement[] = [];
  for (const r of results) {
    const overdueMs = now.getTime() - Date.parse(r.due_at as string);
    // Первый час после срока закрывает «в срок»; просрочка начинается дальше.
    if (overdueMs < HOUR_MS) continue;
    if (dueNow(log, r.id, 'overdue', HOURLY_MS, now)) {
      // ПЕРВОЕ предупреждение пробивает и тишину, и график: после провала оно
      // бесполезно. Повторы -- каждый час, но только в рабочее время.
      const first = !log.has(`${r.id}:overdue`);
      if (!first && !working(r, now)) continue;
      writes.push(queueReminder(env, r,
        `⚠️ Просрочено на ${formatOverdue(overdueMs)}: «${r.title}»`,
        'overdue', first ? { urgent: true } : { gated: true }));
      writes.push(mark(env, r.id, 'overdue', now));
    }
    if (working(r, now) && r.author_id && r.author_id !== r.user_id && dueNow(log, r.id, 'author_overdue', DAILY_MS, now)) {
      writes.push(queueReminder(env, { task_id: r.task_id, org_id: r.org_id, user_id: r.author_id },
        `⚠️ ${r.responsible_name} просрочил «${r.title}» на ${formatOverdue(overdueMs)}.`,
        'author_overdue', { gated: true, buttons: authorButtons(r) }));
      writes.push(mark(env, r.id, 'author_overdue', now));
    }
  }
  if (writes.length) await env.DB.batch(writes);
}

// (e) Сделано, но не проверено 2+ дня. Это упрёк ПРОВЕРЯЮЩЕМУ, не исполнителю:
// опоздание исполнителя судится по done_at против срока при подтверждении.
// Поэтому и адресат напоминания -- АВТОР задачи, а не тот, кто её сделал.
async function remindStaleReview(env: Env): Promise<void> {
  const { results } = await env.DB.prepare(
    `SELECT a.id, a.done_at, t.id AS task_id, t.title, t.org_id, t.author_id, u.name AS responsible_name
     FROM task_assignees a
     JOIN tasks t ON t.id = a.task_id
     JOIN users u ON u.id = a.user_id
     JOIN projects p ON p.id = t.project_id
     WHERE a.state = 'done' AND a.done_at IS NOT NULL
       AND a.review_reminded_at IS NULL AND p.archived_at IS NULL
       AND t.status <> 'archived' AND t.author_id IS NOT NULL
       -- Строки остаются 'done' и после приёмки, поэтому фильтр по состоянию
       -- строки подтверждение НЕ видит. Без этого условия директор получает
       -- «пора проверить» по задаче, которую сам принял.
       AND t.confirmed_at IS NULL`,
  ).all<{ id: string; done_at: string; task_id: string; title: string; org_id: string; author_id: string; responsible_name: string }>();

  const now = Date.now();
  const writes: D1PreparedStatement[] = [];
  for (const r of results) {
    if (now - Date.parse(r.done_at) < REVIEW_WINDOW_MS) continue;
    writes.push(queueReminder(env, { task_id: r.task_id, org_id: r.org_id, user_id: r.author_id },
      `🔔 Пора проверить: «${r.title}» (${r.responsible_name}) сдана больше двух дней назад.`,
      'stale_review', { gated: true }));
    writes.push(env.DB.prepare('UPDATE task_assignees SET review_reminded_at = ? WHERE id = ?').bind(nowIso(), r.id));
  }
  if (writes.length) await env.DB.batch(writes);
}

const PRIORITY_RANK: Record<string, number> = { urgent: 0, medium: 1, low: 2 };
const PRIORITY_RU: Record<string, string> = { urgent: 'высокая', medium: '', low: 'низкая' };

// (f) СВОДКА: в начало рабочего дня организации (или свой час), раз в день на
// человека. Задачи со сроком сегодня -- по важности и близости срока; следом --
// черновики карточками: они напоминают о себе здесь, а не пропадают.
export async function sendDigests(env: Env, now: Date): Promise<number> {
  const { results: orgs } = await env.DB.prepare(
    `SELECT id, ${scheduleCols('orgs')} FROM orgs WHERE archived_at IS NULL AND digest_enabled = 1`,
  ).all<OrgSchedule>();
  let sent = 0;
  for (const s of orgs) {
    if (!isWorkDay(s, now)) continue;
    const { minutes, dayKey } = localHm(now, s.timezone);
    if (minutes < hm(digestAt(s))) continue;
    const { results: members } = await env.DB.prepare(
      `SELECT m.id AS mid, m.user_id, u.telegram_user_id FROM org_memberships m
       JOIN users u ON u.id = m.user_id
       WHERE m.org_id = ? AND m.left_at IS NULL AND m.confirmed_at IS NOT NULL AND m.frozen_at IS NULL
         AND u.telegram_user_id IS NOT NULL AND (m.digest_sent_on IS NULL OR m.digest_sent_on <> ?)`,
    ).bind(s.id, dayKey).all<{ mid: string; user_id: string; telegram_user_id: string }>();
    for (const m of members) {
      // БЕЗ СРОКА -- тоже часть сводки. Раньше выбирались только строки с
      // due_at, и семья, которая сроков не ставит вовсе, не получала утром
      // НИЧЕГО: сводка молчала, хотя дел полный список. Открытые дела без
      // срока идут отдельным разделом и заодно напоминают, что срок стоит
      // поставить -- без него не будет ни одного напоминания.
      const { results: rows } = await env.DB.prepare(
        `SELECT t.id, t.title, t.priority, a.due_at
         FROM task_assignees a
         JOIN tasks t ON t.id = a.task_id
         JOIN projects p ON p.id = t.project_id
         WHERE a.user_id = ? AND a.org_id = ? AND p.archived_at IS NULL
           AND a.state IN ('pending','accepted','rejected')
           AND t.status NOT IN ('archived','done')`,
      ).bind(m.user_id, s.id).all<{ id: string; title: string; priority: string; due_at: string | null }>();
      const today = rows
        .filter((r) => r.due_at !== null && sameLocalDay(r.due_at, now, s.timezone))
        .sort((a, b) => (PRIORITY_RANK[a.priority] - PRIORITY_RANK[b.priority]) || (Date.parse(a.due_at!) - Date.parse(b.due_at!)));
      const undated = rows.filter((r) => r.due_at === null)
        .sort((a, b) => PRIORITY_RANK[a.priority] - PRIORITY_RANK[b.priority]);
      const drafts = await listDrafts(env, m.user_id, s.id);
      const writes = [env.DB.prepare('UPDATE org_memberships SET digest_sent_on = ? WHERE id = ?').bind(dayKey, m.mid)];
      if (today.length > 0 || undated.length > 0) {
        const time = (iso: string) => new Intl.DateTimeFormat('ru-RU', { timeZone: s.timezone, hour: '2-digit', minute: '2-digit', hour12: false }).format(new Date(iso));
        const lines = [
          `📰 ${new Intl.DateTimeFormat('ru-RU', { timeZone: s.timezone, weekday: 'long', day: 'numeric', month: 'long' }).format(now)}`,
          ...today.map((r, i) => `${i + 1}. «${r.title}» — ${time(r.due_at!)}${PRIORITY_RU[r.priority] ? ` · ${PRIORITY_RU[r.priority]}` : ''}`),
        ];
        if (undated.length > 0) {
          if (today.length > 0) lines.push('');
          lines.push(`Без срока (${undated.length}) — напоминаний по ним не будет:`);
          lines.push(...undated.slice(0, 5).map((r) => `• «${r.title}»`));
          if (undated.length > 5) lines.push(`…и ещё ${undated.length - 5}`);
        }
        if (drafts.length) lines.push('', `Черновиков без подтверждения: ${drafts.length} — ниже.`);
        // Через outbox (членство, адрес, клейм -- всё там). task_id -- первая
        // задача сводки: у строки очереди задача обязательна.
        writes.push(queueReminder(env, { task_id: (today[0] ?? undated[0]).id, org_id: s.id, user_id: m.user_id }, lines.join('\n'), 'digest', {}));
      }
      await env.DB.batch(writes);
      // Черновики -- карточками с их кнопками: Создать · Изменить · Отменить.
      for (const d of drafts.slice(0, 5)) await renderDraft(env, d, m.telegram_user_id, s.timezone, true);
      if (today.length > 0 || undated.length > 0 || drafts.length > 0) sent++;
    }
  }
  return sent;
}

function formatOverdue(ms: number): string {
  const mins = Math.floor(ms / 60000);
  const h = Math.floor(mins / 60);
  const m = mins % 60;
  if (h >= 24) return `${Math.floor(h / 24)}д ${h % 24}ч`;
  if (h > 0) return `${h}ч ${m}м`;
  return `${m}м`;
}
