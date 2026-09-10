// Черновик с подтверждением -- самая главная кнопка.
//
// Фраза не становится задачей сама: сначала карточка «как понял», и только
// «Создать» заводит поручение. Поправка -- ответом на карточку или после
// «Изменить»; кнопки срока и важности -- те же, что были под задачей. Один
// черновик в боте и в приложении: продиктованное в одном видно в другом.
import { env as testEnv } from 'cloudflare:test';
import { afterEach, describe, expect, it } from 'vitest';
import { botApp } from '../src/bot';
import { apiRoutes } from '../src/routes';
import { BTN } from '../src/menu';
import { matchDeadline, refineDraft } from '../src/parse';
import { cookie, envWith, ORG_A, stubTelegram } from './fixture';
import type { Env } from '../src/types';

let restore: { mockRestore(): void } | null = null;
afterEach(() => { restore?.mockRestore(); restore = null; });
const tg = () => (restore = stubTelegram()) as ReturnType<typeof stubTelegram>;
type Sent = { chat_id: string; text: string; reply_markup?: { inline_keyboard?: { text: string; callback_data: string }[][] } };
/** Все отправки и правки карточек, по порядку: и sendMessage, и editMessageText. */
const shown = (spy: ReturnType<typeof stubTelegram>) =>
  (spy.mock.calls as unknown as [string, { body?: string }][])
    .filter(([u]) => u.includes('/sendMessage') || u.includes('/editMessageText'))
    .map(([, i]) => JSON.parse(String(i.body)) as Sent);

const TZ = 'Asia/Tashkent';
// Среда, 2 сентября 2026, 10:00 в Ташкенте.
const NOW = new Date('2026-09-02T05:00:00Z');
const PEOPLE = [
  { id: 'u-aziz', name: 'Азиз Каримов' },
  { id: 'u-bek', name: 'Бек Юсупов' },
];
const local = (iso: string) => new Intl.DateTimeFormat('ru-RU', {
  timeZone: TZ, day: '2-digit', month: '2-digit', hour: '2-digit', minute: '2-digit', hour12: false,
}).format(new Date(iso));

describe('срок словами: месяцы, «до пятого», часы дня', () => {
  it('«2 октября» -- дата, а не непонятный текст', () => {
    expect(local(matchDeadline('сдать отчёт 2 октября', NOW, TZ).iso!)).toBe('02.10, 18:00');
  });

  it('«до 5-го» -- пятое число, а не пять часов утра', () => {
    expect(local(matchDeadline('оплатить счёт до 5-го', NOW, TZ).iso!)).toBe('05.09, 18:00');
  });

  it('«завтра до трёх часов дня» -- 15:00, а не три ночи', () => {
    expect(local(matchDeadline('завтра до трёх часов дня забрать документы', NOW, TZ).iso!)).toBe('03.09, 15:00');
  });

  it('«к 3» без даты -- ближайшие три часа дня', () => {
    expect(local(matchDeadline('к 3 привезти образцы', NOW, TZ).iso!)).toBe('02.09, 15:00');
  });
});

describe('поправка к черновику без модели', () => {
  const current = { title: 'Подготовить отчёт', assigneeIds: ['u-aziz'], deadline: null, priority: 'medium' as const, priorityExplicit: false };
  const env = { GROQ_API_KEY: '' } as unknown as Env;

  it('«не Азизу, а Беку» меняет адресата и не трогает тему', async () => {
    const p = await refineDraft(env, current, 'не Азизу, а Беку', PEOPLE, TZ, null, NOW);
    expect(p.assigneeIds).toEqual(['u-bek']);
    expect(p.title).toBeUndefined();
  });

  it('«срок вторник» ставит срок', async () => {
    const p = await refineDraft(env, current, 'срок вторник', PEOPLE, TZ, null, NOW);
    expect(local(p.deadline!)).toBe('08.09, 18:00');
    expect(p.title).toBeUndefined();
  });

  it('«это срочно» -- важность высокая, сказана явно', async () => {
    const p = await refineDraft(env, current, 'это срочно', PEOPLE, TZ, null, NOW);
    expect(p).toMatchObject({ priority: 'urgent', priorityExplicit: true });
    expect(p.title).toBeUndefined();
  });

  it('вся фраза заново -- заменяется всё', async () => {
    const p = await refineDraft(env, current, 'Беку закупить бумагу в пятницу', PEOPLE, TZ, null, NOW);
    expect(p.assigneeIds).toEqual(['u-bek']);
    expect(p.title).toBe('Закупить бумагу');
    expect(local(p.deadline!)).toBe('04.09, 18:00');
  });

  it('новая суть без имени -- только тема', async () => {
    const p = await refineDraft(env, current, 'тема сдать квартальный отчёт', PEOPLE, TZ, null, NOW);
    expect(p.title).toBe('Тема сдать квартальный отчёт');
    expect(p.assigneeIds).toBeUndefined();
  });
});

const world = () =>
  envWith({
    users: [
      { id: 'boss', phone: '+1', name: 'Директор', role: 'creator' },
      { id: 'u-aziz', phone: '+2', name: 'Азиз Каримов', role: 'admin' },
      { id: 'u-bek', phone: '+3', name: 'Бек Юсупов', role: 'admin' },
    ],
    memberships: [{ project_id: 'p1', user_id: 'boss' }, { project_id: 'p1', user_id: 'u-aziz' }, { project_id: 'p1', user_id: 'u-bek' }],
    projects: [{ id: 'p1', telegram_chat_id: '-100999', created_by: 'boss' }],
    tasks: [],
  });
const hook = (env: Env, update: unknown) =>
  botApp.request('/webhook', {
    method: 'POST',
    headers: { 'x-telegram-bot-api-secret-token': 'tg-secret', 'Content-Type': 'application/json' },
    body: JSON.stringify(update),
  }, env);
const from = { id: 'tg-boss', first_name: 'Директор' };
const say = (env: Env, text: string, extra: Record<string, unknown> = {}) =>
  hook(env, { message: { chat: { id: 'tg-boss', type: 'private' }, from, text, ...extra } });
const press = (env: Env, data: string, who = from) =>
  hook(env, { callback_query: { id: 'cb', from: who, data, message: { chat: { id: 'tg-boss' }, message_id: 1 } } });
const draft = async () => (await testEnv.DB.prepare('SELECT * FROM drafts').first<{
  id: string; title: string; assignee_ids: string; deadline: string | null; priority: string; priority_explicit: number; media: string;
}>())!;
const tasks = async () => (await testEnv.DB.prepare('SELECT COUNT(*) AS n FROM tasks').first<{ n: number }>())!.n;

describe('бот: черновик правится, подтверждается, отменяется', () => {
  it('карточка показывает, что услышано, и предлагает срок и важность, раз их не сказали', async () => {
    const env = await world();
    const spy = tg();
    await say(env, 'Азизу подготовить отчёт');
    const card = shown(spy).at(-1)!;
    expect(card.text).toContain('Услышал: «Азизу подготовить отчёт»');
    expect(card.text).toContain('не сказана');
    const buttons = card.reply_markup!.inline_keyboard!.flat().map((b) => b.text);
    expect(buttons[0]).toBe('✅ Создать');
    expect(buttons).toEqual(expect.arrayContaining(['Сегодня', 'Завтра', 'В конце недели', '❗️ Высокая', '✏️ Изменить', '✖ Отменить']));
    // Срок и важность сказаны -- их кнопок нет: они заслоняли бы «Создать».
    await testEnv.DB.prepare('DELETE FROM drafts').run();
    await say(env, 'Азизу срочно подготовить отчёт завтра');
    const b2 = shown(spy).at(-1)!.reply_markup!.inline_keyboard!.flat().map((b) => b.text);
    expect(b2).toEqual(['✅ Создать', '✏️ Изменить', '✖ Отменить']);
  });

  it('ответ на карточку -- поправка: адресат меняется, задачи по-прежнему нет', async () => {
    const env = await world();
    const spy = tg();
    await say(env, 'Азизу подготовить отчёт');
    await say(env, 'не Азизу, а Беку', { reply_to_message: { message_id: 1 } });
    expect(JSON.parse((await draft()).assignee_ids)).toEqual(['u-bek']);
    expect(await tasks()).toBe(0);
    // Карточка отредактирована на месте, а не прислана второй.
    expect(shown(spy).at(-1)!.text).toContain('Бек');
    expect((await testEnv.DB.prepare('SELECT COUNT(*) AS n FROM drafts').first<{ n: number }>())!.n).toBe(1);
  });

  it('«Изменить», затем сообщение без ответа -- тоже поправка', async () => {
    const env = await world();
    tg();
    await say(env, 'Азизу подготовить отчёт');
    await press(env, `de:${(await draft()).id}`);
    await say(env, 'срок вторник');
    expect((await draft()).deadline).not.toBeNull();
    // Следующее сообщение -- уже новое поручение, а не вечная правка.
    await say(env, 'Беку закупить бумагу');
    expect((await testEnv.DB.prepare('SELECT COUNT(*) AS n FROM drafts').first<{ n: number }>())!.n).toBe(2);
  });

  it('кнопки срока и важности правят черновик', async () => {
    const env = await world();
    tg();
    await say(env, 'Азизу подготовить отчёт');
    const id = (await draft()).id;
    await press(env, `dd:${id}:t1`);
    expect((await draft()).deadline).not.toBeNull();
    await press(env, `dp:${id}:u`);
    expect(await draft()).toMatchObject({ priority: 'urgent', priority_explicit: 1 });
    expect(await tasks()).toBe(0);
  });

  it('фото без подписи липнет к последнему черновику', async () => {
    const env = await world();
    tg();
    await say(env, 'Азизу подготовить отчёт');
    await hook(env, { message: { chat: { id: 'tg-boss', type: 'private' }, from, photo: [{ file_id: 'ph', file_size: 500 }] } });
    expect(JSON.parse((await draft()).media)).toHaveLength(1);
    await press(env, `dc:${(await draft()).id}`);
    const att = await testEnv.DB.prepare('SELECT COUNT(*) AS n FROM attachments').first<{ n: number }>();
    expect(att!.n).toBe(1);
  });

  it('«Отменить» удаляет черновик; чужая кнопка не работает', async () => {
    const env = await world();
    const spy = tg();
    await say(env, 'Азизу подготовить отчёт');
    const id = (await draft()).id;
    await press(env, `dc:${id}`, { id: 'tg-aziz', first_name: 'Азиз' });
    expect(await tasks()).toBe(0);
    await press(env, `dx:${id}`);
    expect((await testEnv.DB.prepare('SELECT COUNT(*) AS n FROM drafts').first<{ n: number }>())!.n).toBe(0);
    expect(shown(spy).at(-1)!.text).toContain('удалён');
  });

  it('«Черновики» показывают неподтверждённое, а не пустоту', async () => {
    const env = await world();
    const spy = tg();
    await say(env, BTN.drafts);
    expect(shown(spy).at(-1)!.text).toContain('Черновиков нет');
    await say(env, 'Азизу подготовить отчёт');
    await say(env, 'Беку закупить бумагу');
    await say(env, BTN.drafts);
    const last2 = shown(spy).slice(-2).map((m) => m.text).join('\n');
    expect(last2).toContain('Подготовить отчёт');
    expect(last2).toContain('Закупить бумагу');
  });
});

describe('приложение: тот же черновик', () => {
  const api = async (env: Env, path: string, method: string, body?: unknown, who = 'boss') =>
    apiRoutes.request(path, {
      method,
      headers: { Cookie: await cookie(who, 'creator', ORG_A), 'Content-Type': 'application/json' },
      body: body === undefined ? undefined : JSON.stringify(body),
    }, env);

  it('продиктовано -- черновик, не задача; «кому» пусто, если не узнан', async () => {
    const env = await world();
    tg();
    const res = await api(env, '/tasks/dictate', 'POST', { text: 'Еве приготовить сырники', mode: 'assigned' });
    expect(res.status).toBe(201);
    const d = await res.json<{ id: string; assignee_ids: string[]; title: string }>();
    expect(d.assignee_ids).toEqual([]);
    expect(await tasks()).toBe(0);
    // Черновик приложения виден и боту.
    const list = await (await api(env, '/drafts', 'GET')).json<{ drafts: { id: string }[] }>();
    expect(list.drafts.map((x) => x.id)).toEqual([d.id]);
  });

  it('правка полей, чужой человек -- отказ, подтверждение -- задача', async () => {
    const env = await world();
    tg();
    const d = await (await api(env, '/tasks/dictate', 'POST', { text: 'подготовить отчёт', mode: 'assigned' })).json<{ id: string }>();
    expect((await api(env, `/drafts/${d.id}`, 'PATCH', { assignee_ids: ['nobody'] })).status).toBe(400);
    const patched = await (await api(env, `/drafts/${d.id}`, 'PATCH', {
      assignee_ids: ['u-bek'], deadline: '2026-09-11', priority: 'urgent', title: 'Сдать отчёт',
    })).json<{ assignees: string[]; deadline: string; priority: string; priority_explicit: boolean; title: string }>();
    expect(patched).toMatchObject({ assignees: ['Бек Юсупов'], priority: 'urgent', priority_explicit: true, title: 'Сдать отчёт' });
    expect(local(patched.deadline)).toBe('11.09, 18:00');

    const ok = await api(env, `/drafts/${d.id}/confirm`, 'POST', {});
    expect(ok.status).toBe(201);
    const task = await testEnv.DB.prepare('SELECT title, deadline, priority FROM tasks').first<{ title: string; deadline: string; priority: string }>();
    expect(task).toMatchObject({ title: 'Сдать отчёт', priority: 'urgent' });
    const a = await testEnv.DB.prepare('SELECT user_id FROM task_assignees').first<{ user_id: string }>();
    expect(a!.user_id).toBe('u-bek');
    expect((await testEnv.DB.prepare('SELECT COUNT(*) AS n FROM drafts').first<{ n: number }>())!.n).toBe(0);
  });

  it('удаление -- и черновика нет, и задачи не появилось', async () => {
    const env = await world();
    tg();
    const d = await (await api(env, '/tasks/dictate', 'POST', { text: 'подготовить отчёт' })).json<{ id: string }>();
    expect((await api(env, `/drafts/${d.id}`, 'DELETE')).status).toBe(200);
    expect((await api(env, `/drafts/${d.id}`, 'DELETE')).status).toBe(404);
    expect(await tasks()).toBe(0);
  });
});
