// Карточка адресата -- шаг 2 концепции.
//
// Поручение приходит в личку карточкой с кнопками: Принять · Не успею ·
// Отказать · Открыть (для рассылки «прочитать» -- Ознакомился). «Готово» здесь
// нет: сдают в приложении. Ответы адресата возвращаются автору тоже кнопками:
// перенести срок · оставить · переназначить · отменить.
import { env as testEnv } from 'cloudflare:test';
import { afterEach, describe, expect, it } from 'vitest';
import { botApp } from '../src/bot';
import { assigneeButtons } from '../src/transition';
import { cookie, envWith, ORG_A, stubTelegram } from './fixture';
import { apiRoutes } from '../src/routes';
import type { Env } from '../src/types';

let restore: { mockRestore(): void } | null = null;
afterEach(() => { restore?.mockRestore(); restore = null; });
const tg = () => (restore = stubTelegram()) as ReturnType<typeof stubTelegram>;
type Btn = { text: string; callback_data?: string; web_app?: { url: string } };
type Sent = { chat_id: string; text: string; reply_markup?: { inline_keyboard?: Btn[][] } };
const calls = (spy: ReturnType<typeof stubTelegram>) => spy.mock.calls as unknown as [string, { body?: string }][];
const sent = (spy: ReturnType<typeof stubTelegram>) =>
  calls(spy).filter(([u]) => u.includes('/sendMessage')).map(([, i]) => JSON.parse(String(i.body)) as Sent);
const edits = (spy: ReturnType<typeof stubTelegram>) =>
  calls(spy).filter(([u]) => u.includes('/editMessageReplyMarkup')).map(([, i]) => JSON.parse(String(i.body)) as Sent);
const labels = (m: Sent) => (m.reply_markup?.inline_keyboard ?? []).flat().map((b) => b.text);

const world = () =>
  envWith({
    users: [
      { id: 'boss', phone: '+1', name: 'Директор', role: 'creator' },
      { id: 'w1', phone: '+2', name: 'Азиз Каримов', role: 'admin' },
      { id: 'w2', phone: '+3', name: 'Бек Юсупов', role: 'admin' },
    ],
    memberships: [{ project_id: 'p1', user_id: 'boss' }, { project_id: 'p1', user_id: 'w1' }, { project_id: 'p1', user_id: 'w2' }],
    projects: [{ id: 'p1', telegram_chat_id: '-100999', created_by: 'boss' }],
    tasks: [{ id: 't1', project_id: 'p1', title: 'Подготовить отчёт', status: 'todo', responsible_user_id: 'w1', author_id: 'boss', deadline: '2026-09-11T10:00:00.000Z' }],
  });
const hook = (env: Env, update: unknown) =>
  botApp.request('/webhook', {
    method: 'POST',
    headers: { 'x-telegram-bot-api-secret-token': 'tg-secret', 'Content-Type': 'application/json' },
    body: JSON.stringify(update),
  }, env);
const press = (env: Env, tgId: string, data: string) =>
  hook(env, { callback_query: { id: 'cb', from: { id: tgId, first_name: 'Ч' }, data, message: { chat: { id: tgId }, message_id: 7 } } });
const say = (env: Env, tgId: string, text: string) =>
  hook(env, { message: { chat: { id: tgId, type: 'private' }, from: { id: tgId, first_name: 'Ч' }, text } });
const row = async (userId: string) =>
  (await testEnv.DB.prepare("SELECT state, declined_reason FROM task_assignees WHERE task_id='t1' AND user_id=?").bind(userId).first<{ state: string; declined_reason: string | null }>());
const status = async () => (await testEnv.DB.prepare("SELECT status FROM tasks WHERE id='t1'").first<{ status: string }>())!.status;

describe('этапы голосом и текстом', () => {
  const state = async (u = 'w1') =>
    (await testEnv.DB.prepare("SELECT state FROM task_assignees WHERE task_id='t1' AND user_id=?").bind(u).first<{ state: string }>())!.state;

  it('«взял в работу» двигает СВОЮ строку, а не сдаёт задачу', async () => {
    const env = await world();
    const spy = tg();
    // Ловушка: «готов» лежит внутри «подготовить». Без границы слова фраза
    // читалась бы как «готово», и задача прыгнула бы сразу на проверку.
    await say(env, 'tg-w1', 'взял в работу подготовить отчёт');
    expect(await state()).toBe('accepted');
    expect(await status()).toBe('in_progress');
    const reply = sent(spy).find((m) => m.chat_id === 'tg-w1' && m.text.includes('в работе'))!;
    expect(labels(reply)).toEqual(['📱 Открыть']);
  });

  it('«готово» из «не принял» проходит обе ступени разом', async () => {
    const env = await world();
    tg();
    await say(env, 'tg-w1', 'подготовить отчёт готово');
    expect(await state()).toBe('done');
    expect(await status()).toBe('done');
  });

  it('автор принимает работу словами; исполнитель тем же словом -- не может', async () => {
    const env = await world();
    tg();
    await say(env, 'tg-w1', 'подготовить отчёт сделано');
    expect(await status()).toBe('done');
    // Исполнитель «подтверждаю» не закрывает: приёмка -- дело автора.
    await say(env, 'tg-w1', 'подтверждаю подготовить отчёт');
    expect((await testEnv.DB.prepare("SELECT confirmed_at FROM tasks WHERE id='t1'").first<{ confirmed_at: string | null }>())!.confirmed_at).toBeNull();
    await say(env, 'tg-boss', 'принимаю работу подготовить отчёт');
    expect((await testEnv.DB.prepare("SELECT confirmed_at FROM tasks WHERE id='t1'").first<{ confirmed_at: string | null }>())!.confirmed_at).not.toBeNull();
  });

  it('«не успеваю» уходит автору причиной, а строка остаётся на месте', async () => {
    const env = await world();
    const spy = tg();
    await say(env, 'tg-w1', 'не успеваю подготовить отчёт, жду документы от бухгалтерии');
    expect(await state()).toBe('pending');
    const toAuthor = sent(spy).find((m) => m.chat_id === 'tg-boss' && m.text.includes('Не успевает'))!;
    expect(toAuthor.text).toContain('жду документы от бухгалтерии');
  });

  it('«отказываюсь» снимает задачу и уносит причину автору', async () => {
    const env = await world();
    const spy = tg();
    await say(env, 'tg-w1', 'отказываюсь от подготовить отчёт, нет доступа к базе');
    expect(await state()).toBe('declined');
    const toAuthor = sent(spy).find((m) => m.chat_id === 'tg-boss' && m.text.includes('Отказ от поручения'))!;
    expect(toAuthor.text).toContain('нет доступа к базе');
    // Отыграть назад можно переназначением -- кнопка в том же сообщении.
    expect(labels(toAuthor)).toContain('👤 Переназначить');
  });

  it('«верни на доработку» возвращает сданное с новым сроком', async () => {
    const env = await world();
    const spy = tg();
    await say(env, 'tg-w1', 'подготовить отчёт сделано');
    expect(await status()).toBe('done');
    await say(env, 'tg-boss', 'верни подготовить отчёт на доработку, нет итогов по регионам');
    expect(await state()).toBe('rejected');
    expect(await status()).toBe('in_progress');
    const back = sent(spy).find((m) => m.chat_id === 'tg-w1' && m.text.includes('возвращено в работу'))!;
    expect(back.text).toContain('нет итогов по регионам');
    // Срок обязан сдвинуться: прежний уже прошёл, раз работу сдавали.
    const t = (await testEnv.DB.prepare("SELECT deadline, confirmed_at, done_at FROM tasks WHERE id='t1'").first<{ deadline: string; confirmed_at: string | null; done_at: string | null }>())!;
    expect(Date.parse(t.deadline)).toBeGreaterThan(Date.now());
    expect(t.confirmed_at).toBeNull();
    expect(t.done_at).toBeNull();
  });

  it('«не принимаю работу» -- это ВОЗВРАТ, а не приёмка', async () => {
    const env = await world();
    tg();
    await say(env, 'tg-w1', 'подготовить отчёт сделано');
    // Ловушка порядка: «не принимаю работу» содержит «принимаю работу».
    await say(env, 'tg-boss', 'не принимаю работу подготовить отчёт, переделайте выводы');
    expect((await testEnv.DB.prepare("SELECT confirmed_at FROM tasks WHERE id='t1'").first<{ confirmed_at: string | null }>())!.confirmed_at).toBeNull();
    expect(await state()).toBe('rejected');
  });

  it('«не возьму» -- это ОТКАЗ, а не взятие в работу', async () => {
    const env = await world();
    tg();
    // Ловушка порядка: «не возьму» содержит «возьму».
    await say(env, 'tg-w1', 'не возьму подготовить отчёт, это не мой участок');
    expect(await state()).toBe('declined');
  });

  it('чужая задача командой не двигается: нет ни строки, ни авторства', async () => {
    const env = await world();
    tg();
    await say(env, 'tg-w2', 'взял в работу подготовить отчёт');
    expect(await state()).toBe('pending');
    // Фраза не проглочена -- она ушла обычным путём и стала черновиком.
    expect((await testEnv.DB.prepare('SELECT COUNT(*) AS n FROM drafts').first<{ n: number }>())!.n).toBe(1);
  });
});

describe('правка действующей задачи словами', () => {
  it('«перенеси срок» по названной теме двигает срок уже созданной задачи', async () => {
    const env = await world();
    const spy = tg();
    const before = (await testEnv.DB.prepare("SELECT deadline FROM tasks WHERE id='t1'").first<{ deadline: string }>())!.deadline;
    await say(env, 'tg-boss', 'перенеси срок по подготовить отчёт на завтра');
    const after = (await testEnv.DB.prepare("SELECT deadline FROM tasks WHERE id='t1'").first<{ deadline: string }>())!.deadline;
    expect(after).not.toBe(before);
    const reply = sent(spy).at(-1)!;
    expect(reply.text).toContain('«Подготовить отчёт»');
    expect(reply.text).toContain('срок');
    // Кнопка ведёт в ту же задачу, а нового черновика не появилось.
    expect(labels(reply)).toEqual(['📱 Открыть']);
    expect((await testEnv.DB.prepare('SELECT COUNT(*) AS n FROM drafts').first<{ n: number }>())!.n).toBe(0);
  });

  it('«сделай срочной» меняет важность, а «переименуй в» -- тему', async () => {
    const env = await world();
    tg();
    await say(env, 'tg-boss', 'сделай подготовить отчёт срочной');
    expect((await testEnv.DB.prepare("SELECT priority FROM tasks WHERE id='t1'").first<{ priority: string }>())!.priority).toBe('urgent');
    await say(env, 'tg-boss', 'переименуй подготовить отчёт в закрыть акты');
    expect((await testEnv.DB.prepare("SELECT title FROM tasks WHERE id='t1'").first<{ title: string }>())!.title).toBe('Закрыть акты');
  });

  it('без глагола правки та же фраза заводит НОВЫЙ черновик, а не правит задачу', async () => {
    const env = await world();
    tg();
    // Тема названа дословно, но это поручение, а не распоряжение о правке.
    await say(env, 'tg-boss', 'Азизу подготовить отчёт');
    expect((await testEnv.DB.prepare('SELECT COUNT(*) AS n FROM drafts').first<{ n: number }>())!.n).toBe(1);
  });

  it('правит только АВТОР: исполнителю та же фраза задачу не трогает', async () => {
    const env = await world();
    tg();
    const before = (await testEnv.DB.prepare("SELECT deadline FROM tasks WHERE id='t1'").first<{ deadline: string }>())!.deadline;
    await say(env, 'tg-w1', 'перенеси срок по подготовить отчёт на завтра');
    expect((await testEnv.DB.prepare("SELECT deadline FROM tasks WHERE id='t1'").first<{ deadline: string }>())!.deadline).toBe(before);
  });
});

describe('карточка адресата', () => {
  it('задача из бота: адресату приходит карточка с кнопками и «Открыть» в приложение', async () => {
    const env = await world();
    const spy = tg();
    await say(env, 'tg-boss', 'Азизу завтра до трёх подготовить отчёт');
    const d = (await testEnv.DB.prepare('SELECT id FROM drafts').first<{ id: string }>())!;
    await press(env, 'tg-boss', `dc:${d.id}`);

    const card = sent(spy).find((m) => m.chat_id === 'tg-w1')!;
    expect(card.text).toContain('📌 Вам поручено');
    expect(card.text).toContain('«Подготовить отчёт»');
    expect(card.text).toContain('От кого: Директор');
    expect(card.text).toMatch(/Срок: .*15:00/);
    // Ни ISO-даты, ни голого URL: в задачу ведёт кнопка.
    expect(card.text).not.toMatch(/\d{4}-\d{2}-\d{2}T/);
    expect(card.text).not.toContain('https://');
    expect(labels(card)).toEqual(['✅ Принять', '⏳ Не успею', '✖ Отказать', '📱 Открыть']);
    const open = card.reply_markup!.inline_keyboard!.flat().find((b) => b.web_app)!;
    expect(open.web_app!.url).toMatch(/^https:\/\/hando\.alrevion\.com\/\?task=/);
  });

  it('задача из приложения -- та же карточка, «От кого» -- автор, а не получатель', async () => {
    const env = await world();
    const spy = tg();
    await apiRoutes.request('/projects/p1/tasks', {
      method: 'POST', headers: { Cookie: await cookie('boss', 'creator', ORG_A), 'Content-Type': 'application/json' },
      body: JSON.stringify({ title: 'Закупить бумагу', responsible_user_id: 'w2' }),
    }, env);
    const card = sent(spy).find((m) => m.chat_id === 'tg-w2')!;
    expect(card.text).toContain('От кого: Директор');
    expect(labels(card)).toEqual(['✅ Принять', '⏳ Не успею', '✖ Отказать', '📱 Открыть']);
  });

  it('задаче себе -- только «Принять»: отпрашиваться не у кого', () => {
    const own = { id: 'x', author_id: 'u1' };
    expect(assigneeButtons(own, 'u1').flat().map((b) => b.text)).toEqual(['✅ Принять']);
    expect(assigneeButtons(own, 'u2').flat().map((b) => b.text)).toEqual(['✅ Принять', '⏳ Не успею', '✖ Отказать']);
  });

  it('рассылке «прочитать» -- одна кнопка «Ознакомился», и она закрывает задачу', async () => {
    expect(assigneeButtons({ id: 'x', kind: 'ack' }, 'u1').flat().map((b) => b.text)).toEqual(['👁 Ознакомился']);
    const env = await world();
    const spy = tg();
    await testEnv.DB.prepare("UPDATE tasks SET kind='ack' WHERE id='t1'").run();
    await press(env, 'tg-w1', 'ack:t1');
    expect((await row('w1'))!.state).toBe('accepted');
    expect(await status()).toBe('done');
    expect(sent(spy).find((m) => m.chat_id === 'tg-boss')!.text).toContain('👁 Ознакомился');
  });

  it('«Принять»: автору «принято в работу», у адресата остаётся только «Открыть»', async () => {
    const env = await world();
    const spy = tg();
    await press(env, 'tg-w1', 'accept:t1');
    expect((await row('w1'))!.state).toBe('accepted');
    const toBoss = sent(spy).find((m) => m.chat_id === 'tg-boss')!;
    expect(toBoss.text).toContain('🚀 Принято в работу');
    expect(toBoss.text).toContain('Кто: Азиз Каримов');
    expect(edits(spy)).toHaveLength(1);
    expect(labels(edits(spy)[0])).toEqual(['📱 Открыть']);
  });

  it('«Не успею»: бот спрашивает причину, автор получает её с кнопками, строка не меняется', async () => {
    const env = await world();
    const spy = tg();
    await press(env, 'tg-w1', 'late:t1');
    expect(sent(spy).at(-1)!.text).toContain('Почему не успеваете');
    await say(env, 'tg-w1', 'болею до среды');
    expect((await row('w1'))!.state).toBe('pending');
    const toBoss = sent(spy).find((m) => m.chat_id === 'tg-boss')!;
    expect(toBoss.text).toContain('⏳ Не успевает');
    expect(toBoss.text).toContain('Причина: болею до среды');
    expect(labels(toBoss)).toEqual(['📅 Перенести срок', 'Оставить как есть', '👤 Переназначить', '📱 Открыть']);
    const ev = await testEnv.DB.prepare("SELECT action, comment FROM events WHERE action='late'").first<{ action: string; comment: string }>();
    expect(ev).toMatchObject({ action: 'late', comment: 'болею до среды' });

    // «Оставить как есть» -- клавиатура сворачивается до «Открыть».
    await press(env, 'tg-boss', 'keep:t1');
    expect(labels(edits(spy).at(-1)!)).toEqual(['📱 Открыть']);
  });

  it('причина голосом -- та же причина, а не новый черновик', async () => {
    const env = await world();
    const spy = tg();
    await press(env, 'tg-w1', 'late:t1');
    // Голосовое: getFile + скачивание + расшифровка подменены -- transcribe без ключа
    // отдаёт null, поэтому расшифровку подставляем через подпись к кружочку.
    await hook(env, { message: { chat: { id: 'tg-w1', type: 'private' }, from: { id: 'tg-w1', first_name: 'Ч' }, photo: [{ file_id: 'ph', file_size: 100 }], caption: 'сломалась машина' } });
    expect((await testEnv.DB.prepare("SELECT comment FROM events WHERE action='late'").first<{ comment: string }>())!.comment).toBe('сломалась машина');
    expect((await testEnv.DB.prepare('SELECT COUNT(*) AS n FROM drafts').first<{ n: number }>())!.n).toBe(0);
    expect(sent(spy).find((m) => m.chat_id === 'tg-boss')!.text).toContain('Причина: сломалась машина');
  });

  it('кнопка меню вместо причины -- ожидание снимается, кнопка работает', async () => {
    const env = await world();
    const spy = tg();
    await press(env, 'tg-w1', 'late:t1');
    await say(env, 'tg-w1', '📋 Мои задачи');
    expect(sent(spy).at(-1)!.text).toContain('Подготовить отчёт');
    expect((await testEnv.DB.prepare("SELECT COUNT(*) AS n FROM events WHERE action='late'").first<{ n: number }>())!.n).toBe(0);
  });

  it('«Переназначить»: список без автора, выбранный получает карточку, прежний -- отказан, задача снова в работе', async () => {
    const env = await world();
    const spy = tg();
    await press(env, 'tg-boss', 'ra:t1:');
    const list = edits(spy).at(-1)!;
    expect(labels(list)).toEqual(['Азиз Каримов', 'Бек Юсупов', '‹ Отмена']);
    await press(env, 'tg-boss', 'ra:t1:1:w2');
    expect(await row('w1')).toEqual({ state: 'declined', declined_reason: 'переназначено' });
    expect((await row('w2'))!.state).toBe('pending');
    expect(await status()).toBe('todo');
    const card = sent(spy).find((m) => m.chat_id === 'tg-w2')!;
    expect(card.text).toContain('📌 Вам поручено');
    expect(labels(card)).toContain('✅ Принять');
  });

  it('«Отказать»: причина -> declined, автору кнопки «Переназначить · Отменить»; вернуть тому же -- воскрешение строки', async () => {
    const env = await world();
    const spy = tg();
    await press(env, 'tg-w1', 'decline:t1');
    await say(env, 'tg-w1', 'в отпуске');
    expect(await row('w1')).toEqual({ state: 'declined', declined_reason: 'в отпуске' });
    const toBoss = sent(spy).find((m) => m.chat_id === 'tg-boss')!;
    expect(toBoss.text).toContain('🚫 Отказ от поручения');
    expect(toBoss.text).toContain('Причина: в отпуске');
    expect(labels(toBoss)).toEqual(['👤 Переназначить', '🗑 Отменить задачу', '📱 Открыть']);
    // Единственный адресат отказался -- свёртка увела задачу в архив…
    expect(await status()).toBe('archived');
    // …а переназначение тому же человеку воскрешает его строку (уникальный индекс task+user).
    // Сдвинувшийся список отвергается: индекс без хвоста id -- не тот человек.
    await press(env, 'tg-boss', 'ra:t1:0:zzz');
    expect((await row('w1'))!.state).toBe('declined');
    await press(env, 'tg-boss', 'ra:t1:0:w1');
    expect(await row('w1')).toEqual({ state: 'pending', declined_reason: null });
    expect(await status()).toBe('todo');
  });

  it('«Отменить задачу» -- архив по авторству; чужие кнопки отвергаются', async () => {
    const env = await world();
    const spy = tg();
    await press(env, 'tg-w2', 'cancel:t1');
    expect(await status()).toBe('todo');
    await press(env, 'tg-w2', 'accept:t1');
    expect((await row('w1'))!.state).toBe('pending');
    await press(env, 'tg-boss', 'cancel:t1');
    expect(await status()).toBe('archived');
    expect(sent(spy).find((m) => m.chat_id === 'tg-w1')!.text).toContain('🗑 Поручение отменено');
    const ev = await testEnv.DB.prepare("SELECT action FROM events WHERE target_id='t1' AND action='deleted'").first();
    expect(ev).not.toBeNull();
  });
});

describe('списки в боте: текущая организация, по десять, с листанием', () => {
  it('«Мои задачи»: 12 задач -- две страницы; чужая организация не примешивается', async () => {
    const env = await envWith({
      users: [
        { id: 'boss', phone: '+1', name: 'Директор', role: 'creator' },
        { id: 'w1', phone: '+2', name: 'Азиз Каримов', role: 'member', orgs: [ORG_A, 'org-b'] },
        { id: 'bb', phone: '+3', name: 'Босс Б', role: 'creator', orgs: ['org-b'] },
      ],
      memberships: [{ project_id: 'p1', user_id: 'w1' }, { project_id: 'pb', user_id: 'w1', org_id: 'org-b' }],
      projects: [{ id: 'p1', telegram_chat_id: '-100111', created_by: 'boss' }, { id: 'pb', telegram_chat_id: '-100222', created_by: 'bb', org_id: 'org-b' }],
      tasks: [
        ...Array.from({ length: 12 }, (_, i) => ({ id: `a${i}`, project_id: 'p1', title: `Задача ${i + 1}`, status: 'todo', responsible_user_id: 'w1', author_id: 'boss', priority: i === 0 ? 'urgent' : 'medium', deadline: `2026-09-${String(12 + i).padStart(2, '0')}T10:00:00.000Z` })),
        { id: 'zb', project_id: 'pb', title: 'Чужая', status: 'todo', responsible_user_id: 'w1', author_id: 'bb', org_id: 'org-b' },
      ],
    });
    const spy = tg();
    await say(env, 'tg-w1', '📋 Мои задачи');
    const first = sent(spy).at(-1)!;
    expect(first.text).toContain('Ваши задачи (12) · стр. 1/2');
    expect(first.text).toContain('1. ‼️ «Задача 1»');
    expect(first.text).toContain('10. «Задача 10»');
    expect(first.text).not.toContain('Задача 11');
    expect(first.text).not.toContain('Чужая');
    // Номер строки -- кнопка в саму задачу, пятёрками; текст и ссылка должны
    // совпадать по номеру, иначе «3» открывала бы не третью строку.
    expect(labels(first)).toEqual(['1', '2', '3', '4', '5', '6', '7', '8', '9', '10', 'Далее ›', '📱 Открыть приложение']);
    expect(first.reply_markup!.inline_keyboard![0]).toHaveLength(5);
    expect(first.reply_markup!.inline_keyboard![0][0]).toMatchObject({ text: '1', web_app: { url: expect.stringContaining('?task=a0') } });
    await press(env, 'tg-w1', 'pg:m:1');
    const edited = calls(spy).filter(([u]) => u.includes('/editMessageText')).map(([, i]) => JSON.parse(String(i.body)) as Sent).at(-1)!;
    expect(edited.text).toContain('стр. 2/2');
    expect(edited.text).toContain('11. «Задача 11»');
    // Вторая страница: нумерация продолжается, а не начинается с единицы.
    expect(labels(edited)).toEqual(['11', '12', '‹ Назад', '📱 Открыть приложение']);
    expect(edited.reply_markup!.inline_keyboard![0][0]).toMatchObject({ text: '11', web_app: { url: expect.stringContaining('?task=a10') } });
  });
});
