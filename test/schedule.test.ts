// Напоминания и график -- шаг 3 концепции (раздел 21).
//
// Главное здесь -- ДОЗИРОВКА: тик cron идёт каждые пять минут, а человек
// должен получать «не принято» раз в час, «просрочено» раз в час, автор --
// раз в день. Между ним и двенадцатью сообщениями в час стоит только журнал
// reminders, поэтому первый тест гоняет проход дважды на одном часе.
import { env as testEnv } from 'cloudflare:test';
import { afterEach, describe, expect, it } from 'vitest';
import { botApp } from '../src/bot';
import { apiRoutes } from '../src/routes';
import { BTN } from '../src/menu';
import { drainOutbox } from '../src/outbox';
import { remindDueSoon, remindNotAccepted, remindOverdue, sendDigests } from '../src/scheduled';
import { dayEnd, inWorkHours, type OrgSchedule } from '../src/schedule';
import { matchDeadline } from '../src/parse';
import { cookie, envWith, ORG_A, ORG_B, stubTelegram } from './fixture';
import type { Env } from '../src/types';

let restore: { mockRestore(): void } | null = null;
afterEach(() => { restore?.mockRestore(); restore = null; });
const tg = () => (restore = stubTelegram()) as ReturnType<typeof stubTelegram>;
const sentTexts = (spy: ReturnType<typeof stubTelegram>) =>
  (spy.mock.calls as unknown as [string, { body?: string }][])
    .filter(([u]) => u.includes('/sendMessage'))
    .map(([, i]) => JSON.parse(String(i.body)) as { chat_id: string; text: string });

const TZ = 'Asia/Tashkent';
// Четверг, 10 сентября 2026, 10:00 в Ташкенте.
const NOW = new Date('2026-09-10T05:00:00Z');
const at = (isoLocalHm: string) => new Date(`2026-09-10T${isoLocalHm}:00+05:00`);
const plus = (d: Date, min: number) => new Date(d.getTime() + min * 60000);

const SCHED: OrgSchedule = {
  id: 'x', timezone: TZ, work_days: '1,2,3,4,5', work_start: '09:00', work_end: '18:00',
  lunch_start: '13:00', lunch_end: '14:00', always_on: 0, digest_enabled: 1, digest_time: null, quiet_hours: 1,
};

describe('график', () => {
  it('рабочее время: будни между началом и концом, не обед; 24/7 -- всегда', () => {
    expect(inWorkHours(SCHED, at('10:00'))).toBe(true);
    expect(inWorkHours(SCHED, at('13:30'))).toBe(false); // обед
    expect(inWorkHours(SCHED, at('18:00'))).toBe(false);
    expect(inWorkHours(SCHED, new Date('2026-09-12T05:00:00Z'))).toBe(false); // суббота
    expect(inWorkHours({ ...SCHED, always_on: 1 }, new Date('2026-09-12T20:00:00Z'))).toBe(true);
  });

  it('«до завтра» -- конец СЕГОДНЯШНИХ суток, 23:59 при любом графике', () => {
    // Предлог меняет смысл: «сдать до завтра» -- это успеть, пока завтра не
    // наступило. Прежде разбор давал завтрашний вечер, то есть лишние сутки.
    // Час здесь не из графика: в полночь и наступает то самое «завтра».
    const local = (iso: string) => new Intl.DateTimeFormat('ru-RU', { timeZone: TZ, day: '2-digit', hour: '2-digit', minute: '2-digit', hour12: false }).format(new Date(iso));
    expect(local(matchDeadline('сдать до завтра', NOW, TZ, '17:30').iso!)).toBe('10, 23:59');
    expect(local(matchDeadline('сдать до завтра', NOW, TZ, dayEnd({ ...SCHED, always_on: 1 })).iso!)).toBe('10, 23:59');
    // А просто «завтра» -- завтрашний день по графику организации.
    expect(local(matchDeadline('сдать завтра', NOW, TZ, '17:30').iso!)).toBe('11, 17:30');
  });
});

const world = (deadline: string | null) =>
  envWith({
    users: [
      { id: 'boss', phone: '+1', name: 'Директор', role: 'creator' },
      { id: 'w1', phone: '+2', name: 'Азиз Каримов', role: 'admin', orgs: [ORG_A, ORG_B] },
    ],
    memberships: [{ project_id: 'p1', user_id: 'boss' }, { project_id: 'p1', user_id: 'w1' }],
    projects: [{ id: 'p1', telegram_chat_id: '-100999', created_by: 'boss' }],
    tasks: [{ id: 't1', project_id: 'p1', title: 'Подготовить отчёт', status: 'todo', responsible_user_id: 'w1', author_id: 'boss', deadline }],
  });
const createdAgo = (min: number) =>
  testEnv.DB.prepare("UPDATE tasks SET created_at = ? WHERE id = 't1'").bind(plus(NOW, -min).toISOString()).run();
const queued = async () =>
  (await testEnv.DB.prepare('SELECT kind, assignee_id, payload FROM notifications ORDER BY rowid').all<{ kind: string; assignee_id: string; payload: string }>()).results
    .map((r) => ({ kind: r.kind, to: r.assignee_id, p: JSON.parse(r.payload) as { text: string; urgent: boolean; gated: boolean; keyboard: { text: string }[][] } }));

describe('матрица напоминаний: дозировка', () => {
  it('«не принято»: через час, при сроке сегодня -- раз в час; два тика в один час дают одно сообщение', async () => {
    const env = await world(at('17:00').toISOString());
    await createdAgo(120);
    await remindNotAccepted(env, NOW);
    await remindNotAccepted(env, plus(NOW, 10));
    let q = await queued();
    expect(q.filter((n) => n.kind === 'not_accepted')).toHaveLength(1);
    expect(q[0].p.gated).toBe(true);
    expect(q[0].p.text).toContain('Не принято: «Подготовить отчёт»');
    expect(q[0].p.keyboard.flat().map((b) => b.text)).toEqual(['✅ Принять', '⏳ Не успею', '✖ Отказать', '📱 Открыть']);
    // Автор: через три часа, один раз.
    expect(q.some((n) => n.kind === 'author_not_accepted')).toBe(false);
    await remindNotAccepted(env, plus(NOW, 60));
    await remindNotAccepted(env, plus(NOW, 65));
    q = await queued();
    expect(q.filter((n) => n.kind === 'not_accepted')).toHaveLength(2);
    expect(q.filter((n) => n.kind === 'author_not_accepted').map((n) => n.to)).toEqual(['boss']);
    expect(q.find((n) => n.kind === 'author_not_accepted')!.p.keyboard.flat().map((b) => b.text)).toEqual(['👤 Переназначить', '📱 Открыть']);
  });

  it('«не принято» без срока сегодня -- один раз', async () => {
    const env = await world(null);
    await createdAgo(120);
    await remindNotAccepted(env, NOW);
    await remindNotAccepted(env, plus(NOW, 120));
    expect((await queued()).filter((n) => n.kind === 'not_accepted')).toHaveLength(1);
  });

  it('за час, за N минут (настройка человека) и в срок -- по разу и всегда (urgent)', async () => {
    const env = await world(plus(NOW, 20).toISOString());
    await testEnv.DB.prepare("UPDATE users SET remind_before_min = 25 WHERE id = 'w1'").run();
    await remindDueSoon(env, NOW);
    await remindDueSoon(env, plus(NOW, 5));
    let kinds = (await queued()).map((n) => n.kind).sort();
    expect(kinds).toEqual(['before_1h', 'before_n']);
    expect((await queued()).every((n) => n.p.urgent)).toBe(true);
    expect((await queued()).find((n) => n.kind === 'before_n')!.p.text).toContain('Через 25 мин');
    await remindDueSoon(env, plus(NOW, 22));
    kinds = (await queued()).map((n) => n.kind).sort();
    expect(kinds).toEqual(['at_due', 'before_1h', 'before_n']);
  });

  it('просрочено: первое сразу, дальше раз в час в рабочее время; автору раз в день', async () => {
    const env = await world(plus(NOW, -120).toISOString());
    await remindOverdue(env, NOW);
    await remindOverdue(env, plus(NOW, 10));
    let q = await queued();
    expect(q.map((n) => n.kind).sort()).toEqual(['author_overdue', 'overdue']);
    // Первое -- срочное, сквозь тишину; повтор через час -- уже по графику.
    expect(q.find((n) => n.kind === 'overdue')!.p).toMatchObject({ gated: false, urgent: true });
    expect(q.find((n) => n.kind === 'overdue')!.p.text).toContain('Просрочено на 2ч 0м');
    await remindOverdue(env, plus(NOW, 60));
    q = await queued();
    expect(q.filter((n) => n.kind === 'overdue')).toHaveLength(2);
    expect(q.filter((n) => n.kind === 'overdue')[1].p).toMatchObject({ gated: true, urgent: false });
    expect(q.filter((n) => n.kind === 'author_overdue')).toHaveLength(1);
  });

  it('«Напомнить» у автора стирает журнал -- следующий тик шлёт заново', async () => {
    const env = await world(at('17:00').toISOString());
    tg();
    await createdAgo(120);
    await remindNotAccepted(env, NOW);
    await botApp.request('/webhook', {
      method: 'POST', headers: { 'x-telegram-bot-api-secret-token': 'tg-secret', 'Content-Type': 'application/json' },
      body: JSON.stringify({ callback_query: { id: 'cb', from: { id: 'tg-boss' }, data: 'nudge_remind:t1', message: { chat: { id: 'tg-boss' }, message_id: 1 } } }),
    }, env);
    await remindNotAccepted(env, plus(NOW, 5));
    expect((await queued()).filter((n) => n.kind === 'not_accepted')).toHaveLength(2);
  });
});

describe('сводка', () => {
  it('в начало рабочего дня, раз в день, только задачи со сроком сегодня; черновики -- карточками', async () => {
    const env = await world(at('15:00').toISOString());
    const spy = tg();
    await testEnv.DB.prepare(
      `INSERT INTO drafts (id, org_id, author_id, title, assignee_ids, deadline, priority, priority_explicit, kind, heard, media, source, created_at, updated_at)
       VALUES ('d1', ?, 'w1', 'Купить бумагу', '["w1"]', NULL, 'medium', 0, 'single', 'купить бумагу', '[]', 'pattern', ?, ?)`,
    ).bind(ORG_A, NOW.toISOString(), NOW.toISOString()).run();
    // 08:50 -- рано. 09:10 -- пора.
    expect(await sendDigests(env, at('08:50'))).toBe(0);
    expect(await sendDigests(env, at('09:10'))).toBe(1);
    const digest = (await queued()).find((n) => n.kind === 'digest')!;
    expect(digest.to).toBe('w1');
    expect(digest.p.text).toContain('1. «Подготовить отчёт» — 15:00');
    expect(digest.p.text).toContain('Черновиков без подтверждения: 1');
    expect(sentTexts(spy).some((m) => m.chat_id === 'tg-w1' && m.text.includes('Черновик'))).toBe(true);
    // Второй раз в тот же день -- нет; в субботу -- нет.
    expect(await sendDigests(env, at('09:30'))).toBe(0);
    expect(await sendDigests(env, new Date('2026-09-12T04:10:00Z'))).toBe(0);
    // Директору сроков сегодня нет -- сводки нет, а не пустое письмо.
    expect((await queued()).filter((n) => n.kind === 'digest').map((n) => n.to)).toEqual(['w1']);
  });
});

describe('очередь: ночной пол, график и режим человека', () => {
  const enqueue = (env: Env, userId: string, payload: Record<string, unknown>) =>
    env.DB.prepare(
      `INSERT INTO notifications (id, task_id, assignee_id, org_id, kind, payload, scheduled_at) VALUES (?, 't1', ?, ?, 'x', ?, ?)`,
    ).bind(crypto.randomUUID(), userId, ORG_A, JSON.stringify({ recipient_user_id: userId, text: 'T', delete_message_id: null, track: false, ...payload }), NOW.toISOString()).run();

  it('gated ждёт рабочего времени; «сразу из всех» получает переходы вечером; «по расписанию» -- нет; срочное -- всегда', async () => {
    const env = await world(null);
    tg();
    await testEnv.DB.prepare('UPDATE orgs SET quiet_hours = 1 WHERE id = ?').bind(ORG_A).run();
    await enqueue(env, 'w1', { gated: true });
    // 19:00 -- не ночь, но уже не рабочее время: напоминание ждёт.
    expect(await drainOutbox(env, at('19:00'))).toBe(0);
    expect(await drainOutbox(env, at('10:00'))).toBe(1);

    await enqueue(env, 'w1', {});
    expect(await drainOutbox(env, at('19:00'))).toBe(1); // переход, режим «сразу»
    await testEnv.DB.prepare("UPDATE users SET notify_mode = 'schedule' WHERE id = 'w1'").run();
    await enqueue(env, 'w1', {});
    expect(await drainOutbox(env, at('19:00'))).toBe(0); // по расписанию -- утром
    expect(await drainOutbox(env, at('21:00'))).toBe(0); // ночной пол -- для всех несрочных
    await enqueue(env, 'w1', { urgent: true });
    expect(await drainOutbox(env, at('21:00'))).toBe(1);
  });
});

describe('бот: задача в СВОЕЙ организации и настройки', () => {
  const hook = (env: Env, update: unknown) =>
    botApp.request('/webhook', {
      method: 'POST', headers: { 'x-telegram-bot-api-secret-token': 'tg-secret', 'Content-Type': 'application/json' },
      body: JSON.stringify(update),
    }, env);
  const say = (env: Env, tgId: string, text: string) =>
    hook(env, { message: { chat: { id: tgId, type: 'private' }, from: { id: tgId, first_name: 'Ч' }, text } });

  it('кнопка на задаче второй организации работает, хотя текущая -- первая', async () => {
    const env = await envWith({
      users: [{ id: 'w1', phone: '+2', name: 'Азиз', role: 'admin', orgs: [ORG_A, ORG_B] }, { id: 'b', phone: '+3', name: 'Босс Б', role: 'creator', orgs: [ORG_B] }],
      memberships: [{ project_id: 'pb', user_id: 'w1', org_id: ORG_B }],
      projects: [{ id: 'pb', telegram_chat_id: '-100222', created_by: 'b', org_id: ORG_B }],
      tasks: [{ id: 'tb', project_id: 'pb', status: 'todo', responsible_user_id: 'w1', author_id: 'b', org_id: ORG_B }],
    });
    tg();
    await hook(env, { callback_query: { id: 'cb', from: { id: 'tg-w1' }, data: 'accept:tb', message: { chat: { id: 'tg-w1' }, message_id: 1 } } });
    expect((await testEnv.DB.prepare("SELECT state FROM task_assignees WHERE task_id='tb'").first<{ state: string }>())!.state).toBe('accepted');
  });

  it('Организации → Настройки: режим, «за N минут», сводка и её час', async () => {
    const env = await world(null);
    const spy = tg();
    await say(env, 'tg-boss', BTN.settings);
    expect(sentTexts(spy).at(-1)!.text).toContain('Уведомления: сразу из всех');
    await say(env, 'tg-boss', BTN.notifySchedule);
    await say(env, 'tg-boss', BTN.remind15);
    await say(env, 'tg-boss', BTN.digestOff);
    await say(env, 'tg-boss', BTN.digestTime);
    await say(env, 'tg-boss', '08:30');
    const u = await testEnv.DB.prepare("SELECT notify_mode, remind_before_min FROM users WHERE id='boss'").first<{ notify_mode: string; remind_before_min: number }>();
    expect(u).toEqual({ notify_mode: 'schedule', remind_before_min: 15 });
    const o = await testEnv.DB.prepare('SELECT digest_enabled, digest_time FROM orgs WHERE id = ?').bind(ORG_A).first<{ digest_enabled: number; digest_time: string }>();
    expect(o).toEqual({ digest_enabled: 0, digest_time: '08:30' });
    expect(sentTexts(spy).at(-1)!.text).toContain('Сводка: выключена');
    // Не владелец сводку не трогает.
    await say(env, 'tg-w1', BTN.digestOn);
    expect((await testEnv.DB.prepare('SELECT digest_enabled FROM orgs WHERE id = ?').bind(ORG_A).first<{ digest_enabled: number }>())!.digest_enabled).toBe(0);
  });
});

describe('API: те же настройки', () => {
  const api = async (env: Env, path: string, method: string, body: unknown, who: string, role: string) =>
    apiRoutes.request(path, { method, headers: { Cookie: await cookie(who, role, ORG_A), 'Content-Type': 'application/json' }, body: JSON.stringify(body) }, env);

  it('PATCH /me и PATCH /orgs/:id; чужой график -- 403', async () => {
    const env = await world(null);
    tg();
    expect((await api(env, '/me', 'PATCH', { notify_mode: 'schedule', remind_before_min: 45 }, 'w1', 'admin')).status).toBe(200);
    const me = await (await apiRoutes.request('/me', { headers: { Cookie: await cookie('w1', 'admin', ORG_A) } }, env)).json<{ user: { notify_mode: string; remind_before_min: number } }>();
    expect(me.user).toMatchObject({ notify_mode: 'schedule', remind_before_min: 45 });
    expect((await api(env, '/me', 'PATCH', { notify_mode: 'never' }, 'w1', 'admin')).status).toBe(400);

    expect((await api(env, `/orgs/${ORG_A}`, 'PATCH', { work_start: '08:00', work_end: '17:00', lunch_start: null, lunch_end: null, digest_time: '08:15' }, 'boss', 'creator')).status).toBe(200);
    const o = await testEnv.DB.prepare('SELECT work_start, work_end, lunch_start, digest_time FROM orgs WHERE id = ?').bind(ORG_A).first();
    expect(o).toEqual({ work_start: '08:00', work_end: '17:00', lunch_start: null, digest_time: '08:15' });
    expect((await api(env, `/orgs/${ORG_A}`, 'PATCH', { work_start: '25:00' }, 'boss', 'creator')).status).toBe(403);
    expect((await api(env, `/orgs/${ORG_A}`, 'PATCH', { work_start: '08:00' }, 'w1', 'admin')).status).toBe(403);
    // Дата без часа в быстрой правке -- теперь конец НОВОГО рабочего дня.
    await api(env, '/tasks/t1/quick', 'PATCH', { deadline: '2026-09-15' }, 'boss', 'creator');
    const t = await testEnv.DB.prepare("SELECT deadline FROM tasks WHERE id='t1'").first<{ deadline: string }>();
    expect(new Intl.DateTimeFormat('ru-RU', { timeZone: TZ, hour: '2-digit', minute: '2-digit', hour12: false }).format(new Date(t!.deadline))).toBe('17:00');
  });
});
