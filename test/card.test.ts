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
import { initialState } from '../src/assignees';
import { remindOverdue } from '../src/scheduled';
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
      { id: 'boss', name: 'Директор', role: 'creator' },
      { id: 'w1', name: 'Азиз Каримов', role: 'admin' },
      { id: 'w2', name: 'Бек Юсупов', role: 'admin' },
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

describe('повтор и список пунктов', () => {
  it('подтверждение повторяющейся задачи заводит следующий круг', async () => {
    const env = await world();
    tg();
    // Срок В БУДУЩЕМ: только тогда следующий круг считается от него. Если
    // прежний срок уже прошёл, отсчёт идёт от «сейчас» -- иначе новая задача
    // родилась бы просроченной (это проверяет следующий тест).
    const before = new Date(Date.now() + 3 * 24 * 60 * 60 * 1000).toISOString();
    await testEnv.DB.prepare("UPDATE tasks SET repeat_min = 2880, deadline = ? WHERE id='t1'").bind(before).run();
    await testEnv.DB.prepare("UPDATE task_assignees SET due_at = ? WHERE task_id='t1'").bind(before).run();
    await say(env, 'tg-w1', 'подготовить отчёт готово');
    const spy = tg();
    await say(env, 'tg-boss', 'принимаю работу подготовить отчёт');
    const { results } = await testEnv.DB.prepare("SELECT id, deadline, status, repeat_min FROM tasks WHERE title='Подготовить отчёт' ORDER BY created_at")
      .all<{ id: string; deadline: string; status: string; repeat_min: number }>();
    expect(results).toHaveLength(2);
    const next = results.find((t) => t.id !== 't1')!;
    // Новый круг: свой срок ровно через два дня от прежнего и снова
    // повторяющийся -- иначе цветы политы один раз и навсегда.
    expect(next.repeat_min).toBe(2880);
    expect(Date.parse(next.deadline) - Date.parse(before)).toBe(2 * 24 * 60 * 60 * 1000);
    // Исполнитель тот же, строка новая -- и УЖЕ принятая: на прошлом круге он
    // согласился, и просить «✅ Принять» через день было бы переспрашиванием.
    const row = await testEnv.DB.prepare('SELECT state, accepted_at FROM task_assignees WHERE task_id = ? AND user_id = ?')
      .bind(next.id, 'w1').first<{ state: string; accepted_at: string | null }>();
    expect(row).toMatchObject({ state: 'accepted' });
    expect(row!.accepted_at).toBeTruthy();
    expect(next.status).toBe('in_progress');
    // Карточка нового круга -- со следующим шагом, а не с «Принять».
    const card = sent(spy).find((m) => m.chat_id === 'tg-w1' && m.text.includes('Снова по кругу'))!;
    expect(labels(card)).toEqual(['🚀 Начал', '📱 Открыть']);
  });

  it('согласие переходит только от тех, кто его давал', () => {
    // «Кто первый» закрыл другой -- этот человек так и не соглашался и решает заново.
    const agreed = new Set(['w1']);
    expect(initialState('w1', 'boss', 'any', agreed)).toBe('accepted');
    expect(initialState('w2', 'boss', 'any', agreed)).toBe('pending');
    // «Ознакомиться» принятым не рождается никогда: принятие там и есть закрытие.
    expect(initialState('w1', 'boss', 'ack', agreed)).toBe('pending');
  });

  it('просроченный круг начинается от «сейчас», а не рождается просроченным', async () => {
    const env = await world();
    tg();
    // Срок фикстуры уже в прошлом.
    await testEnv.DB.prepare("UPDATE tasks SET repeat_min = 2880 WHERE id='t1'").run();
    await say(env, 'tg-w1', 'подготовить отчёт готово');
    await say(env, 'tg-boss', 'принимаю работу подготовить отчёт');
    const next = (await testEnv.DB.prepare("SELECT deadline FROM tasks WHERE title='Подготовить отчёт' AND id <> 't1'")
      .first<{ deadline: string }>())!;
    expect(Date.parse(next.deadline)).toBeGreaterThan(Date.now());
  });

  it('разовая задача следующего круга НЕ заводит', async () => {
    const env = await world();
    tg();
    await say(env, 'tg-w1', 'подготовить отчёт готово');
    await say(env, 'tg-boss', 'принимаю работу подготовить отчёт');
    expect((await testEnv.DB.prepare("SELECT COUNT(*) AS n FROM tasks WHERE title='Подготовить отчёт'").first<{ n: number }>())!.n).toBe(1);
  });

  it('список: кнопка на карточке, пункт отмечается нажатием и снимается вторым', async () => {
    const env = await world();
    const spy = tg();
    await testEnv.DB.prepare("UPDATE tasks SET checklist = ? WHERE id='t1'")
      .bind(JSON.stringify([{ t: 'молоко', d: null }, { t: 'хлеб', d: null }])).run();
    // Кнопка списка стоит первой в карточке адресата.
    expect(assigneeButtons({ id: 't1', checklist: '[]x' }, 'w1')[0][0].text).toBe('🧾 Список');
    await press(env, 'tg-w1', 'cl:t1');
    const list = sent(spy).find((m) => m.text.includes('Отмечено 0 из 2'))!;
    expect(list.text).toContain('⬜️ молоко');
    await press(env, 'tg-w1', 'ci:t1:0');
    const raw = (await testEnv.DB.prepare("SELECT checklist FROM tasks WHERE id='t1'").first<{ checklist: string }>())!.checklist;
    expect(JSON.parse(raw)[0].d).not.toBeNull();
    // Второе нажатие снимает.
    await press(env, 'tg-w1', 'ci:t1:0');
    const raw2 = (await testEnv.DB.prepare("SELECT checklist FROM tasks WHERE id='t1'").first<{ checklist: string }>())!.checklist;
    expect(JSON.parse(raw2)[0].d).toBeNull();
    // Статус задачи галочка НЕ трогает.
    expect(await status()).toBe('todo');
  });
});

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

describe('ответ на сообщение бота о задаче', () => {
  // Кнопки исходного сообщения Telegram присылает вместе с ответом; в
  // «📱 Открыть» зашит id задачи -- по нему бот и понимает, о чём речь.
  const replyTo = (env: Env, tgId: string, text: string, taskId = 't1') => hook(env, { message: {
    chat: { id: tgId, type: 'private' }, from: { id: tgId, first_name: 'Ч' }, text,
    reply_to_message: {
      message_id: 99, text: '⚠️ Азиз Каримов просрочил «Подготовить отчёт» на 15ч 0м.',
      reply_markup: { inline_keyboard: [[{ text: '👤 Переназначить', callback_data: `ra:${taskId}:` }], [{ text: '📱 Открыть', web_app: { url: `https://hando.alrevion.com/?task=${taskId}` } }]] },
    },
  } });
  const seedOverdue = () => testEnv.DB.prepare(
    "INSERT INTO reminders (assignee_row_id, kind, sent_at, n) SELECT id, 'overdue', datetime('now'), 3 FROM task_assignees WHERE task_id = 't1'",
  ).run();
  const overdueLogged = async () =>
    (await testEnv.DB.prepare("SELECT COUNT(*) AS n FROM reminders WHERE kind = 'overdue'").first<{ n: number }>())!.n;

  it('«напомни ещё раз ему» в ответ на «просрочил» -- напоминание по ЭТОЙ задаче, без вопроса «какой?»', async () => {
    const env = await world();
    await seedOverdue();
    const spy = tg();
    await replyTo(env, 'tg-boss', 'Напомни ещё раз ему');
    // Журнал просрочки сброшен -- ближайший проход напомнит заново, как кнопка «🔔 Напомнить».
    expect(await overdueLogged()).toBe(0);
    const reply = sent(spy).filter((m) => m.chat_id === 'tg-boss').at(-1)!;
    expect(reply.text).toBe('🔔 Напомню исполнителям «Подготовить отчёт».');
    expect(labels(reply)).toEqual(['📱 Открыть']);
    expect((await testEnv.DB.prepare('SELECT COUNT(*) AS n FROM drafts').first<{ n: number }>())!.n).toBe(0);
  });

  it('исполнитель толкнуть себя не может -- ответ прямо, а не «о какой задаче речь?»', async () => {
    const env = await world();
    await seedOverdue();
    const spy = tg();
    await replyTo(env, 'tg-w1', 'напомни ему');
    expect(await overdueLogged()).toBe(1);
    expect(sent(spy).filter((m) => m.chat_id === 'tg-w1').at(-1)!.text).toContain('это решает автор');
  });

  it('без ответа на сообщение «напомни …» по-прежнему не трогает исполнителя', async () => {
    // Иначе «напомни мне подготовить отчёт» при такой задаче толкнуло бы Азиза
    // вместо того, чтобы стать напоминанием себе.
    const env = await world();
    await seedOverdue();
    tg();
    await say(env, 'tg-boss', 'напомни ему подготовить отчёт');
    expect(await overdueLogged()).toBe(1);
  });

  it('кнопка задачи ЧУЖОЙ организации -- не указатель', async () => {
    const env = await world();
    await seedOverdue();
    tg();
    await replyTo(env, 'tg-boss', 'Напомни ещё раз ему', 'чужая');
    expect(await overdueLogged()).toBe(1);
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
    const reply = sent(spy).filter((m) => m.chat_id === 'tg-boss').at(-1)!;
    expect(reply.text).toContain('«Подготовить отчёт»');
    expect(reply.text).toContain('срок');
    // Кнопка ведёт в ту же задачу, а нового черновика не появилось.
    expect(labels(reply)).toEqual(['📱 Открыть']);
    expect((await testEnv.DB.prepare('SELECT COUNT(*) AS n FROM drafts').first<{ n: number }>())!.n).toBe(0);
    // Исполнитель узнаёт новый срок -- раньше перенос был молчаливым.
    const toWorker = sent(spy).filter((m) => m.chat_id === 'tg-w1');
    expect(toWorker).toHaveLength(1);
    expect(toWorker[0].text).toContain('📅 Срок перенесён');
    expect(toWorker[0].text).toContain('«Подготовить отчёт»');
  });

  it('перенос в приложении: дата без часа -- конец рабочего дня, срок у исполнителя тот же, и он извещён', async () => {
    const env = await world();
    const spy = tg();
    const res = await apiRoutes.request('/tasks/t1', {
      method: 'PATCH', headers: { Cookie: await cookie('boss', 'creator', ORG_A), 'Content-Type': 'application/json' },
      body: JSON.stringify({ deadline: '2026-09-25' }),
    }, env);
    expect(res.status).toBe(200);
    const t = (await testEnv.DB.prepare("SELECT deadline FROM tasks WHERE id='t1'").first<{ deadline: string }>())!.deadline;
    const a = (await testEnv.DB.prepare("SELECT due_at FROM task_assignees WHERE task_id='t1'").first<{ due_at: string }>())!.due_at;
    // Не полночь по Гринвичу (05:00 в Ташкенте), а конец рабочего дня.
    expect(new Intl.DateTimeFormat('en-CA', { timeZone: 'Asia/Tashkent', hour: '2-digit', minute: '2-digit', hour12: false }).format(new Date(t))).toBe('18:00');
    expect(a).toBe(t);
    expect(sent(spy).some((m) => m.chat_id === 'tg-w1' && m.text.includes('📅 Срок перенесён'))).toBe(true);
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

  it('«Принять»: автору «принято», у адресата остаётся следующий шаг -- «Начал»', async () => {
    const env = await world();
    const spy = tg();
    await press(env, 'tg-w1', 'accept:t1');
    expect((await row('w1'))!.state).toBe('accepted');
    const toBoss = sent(spy).find((m) => m.chat_id === 'tg-boss')!;
    expect(toBoss.text).toContain('🚀 Принято');
    expect(toBoss.text).toContain('Кто: Азиз Каримов');
    expect(edits(spy)).toHaveLength(1);
    expect(labels(edits(spy)[0])).toEqual(['🚀 Начал', '📱 Открыть']);
  });

  it('«Начал»: состояние то же, появляется отметка времени и весть автору', async () => {
    const env = await world();
    await press(env, 'tg-w1', 'accept:t1');
    const spy = tg();
    await press(env, 'tg-w1', 'start:t1');
    const r = (await testEnv.DB.prepare("SELECT state, started_at FROM task_assignees WHERE task_id='t1' AND user_id='w1'")
      .first<{ state: string; started_at: string | null }>())!;
    // Состояние НЕ менялось -- «в работе» это отметка поверх accepted.
    expect(r.state).toBe('accepted');
    expect(r.started_at).not.toBeNull();
    expect(await status()).toBe('in_progress');
    // Очередь могла довезти «Принято» тем же проходом -- ищем нужное письмо, а
    // не первое подряд.
    expect(sent(spy).some((m) => m.chat_id === 'tg-boss' && m.text.includes('🚀 В работе'))).toBe(true);
    // Второе нажатие ничего не меняет.
    await press(env, 'tg-w1', 'start:t1');
    expect((await testEnv.DB.prepare("SELECT started_at FROM task_assignees WHERE task_id='t1' AND user_id='w1'")
      .first<{ started_at: string }>())!.started_at).toBe(r.started_at);
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
        { id: 'boss', name: 'Директор', role: 'creator' },
        { id: 'w1', name: 'Азиз Каримов', role: 'member', orgs: [ORG_A, 'org-b'] },
        { id: 'bb', name: 'Босс Б', role: 'creator', orgs: ['org-b'] },
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

describe('порядок работ: «одно после другого»', () => {
  const two = () =>
    envWith({
      users: [{ id: 'boss', name: 'Директор', role: 'creator' }],
      memberships: [{ project_id: 'p1', user_id: 'boss' }],
      projects: [{ id: 'p1', telegram_chat_id: '-100999', created_by: 'boss' }],
      tasks: [
        { id: 'granny', project_id: 'p1', title: 'полить цветы бабули', status: 'todo', responsible_user_id: 'boss', author_id: 'boss', deadline: null },
        { id: 'larisa', project_id: 'p1', title: 'полить цветы Ларисы', status: 'todo', responsible_user_id: 'boss', author_id: 'boss', deadline: null },
      ],
    });
  const dep = async (id: string) =>
    (await testEnv.DB.prepare('SELECT depends_on_task_id FROM tasks WHERE id = ?').bind(id).first<{ depends_on_task_id: string | null }>())!.depends_on_task_id;
  const startedAt = async (taskId: string) =>
    (await testEnv.DB.prepare("SELECT started_at FROM task_assignees WHERE task_id = ? AND user_id = 'boss'").bind(taskId).first<{ started_at: string | null }>())!.started_at;

  it('«X после Y» связывает две названные задачи', async () => {
    const env = await two();
    const spy = tg();
    await say(env, 'tg-boss', 'полить цветы Ларисы после полить цветы бабули');
    expect(await dep('larisa')).toBe('granny');
    expect(sent(spy).at(-1)!.text).toContain('только после');
  });

  it('«сначала Y, потом X» -- тот же смысл, обратный порядок слов', async () => {
    const env = await two();
    tg();
    await say(env, 'tg-boss', 'сначала полить цветы бабули, потом полить цветы Ларисы');
    expect(await dep('larisa')).toBe('granny');
    expect(await dep('granny')).toBeNull();
  });

  it('связь держит НАЧАЛО, а не согласие: принять можно, взять в работу -- нет', async () => {
    const env = await two();
    const spy = tg();
    await say(env, 'tg-boss', 'полить цветы Ларисы после полить цветы бабули');

    await say(env, 'tg-boss', 'взял в работу полить цветы Ларисы');
    // Принято -- да, начато -- нет: согласие взяться зависимость не держит.
    expect(await startedAt('larisa')).toBeNull();
    // Ответ ищем среди всех сообщений: следом за ним уходит ещё и уведомление
    // «Принято», и оно оказывается последним.
    expect(sent(spy).map((m) => m.text).join('\n')).toContain('Начать можно после');

    await testEnv.DB.prepare("UPDATE tasks SET status = 'done' WHERE id = 'granny'").run();
    await say(env, 'tg-boss', 'взял в работу полить цветы Ларисы');
    expect(await startedAt('larisa')).toBeTruthy();
  });

  it('круг из двух звеньев не заводится: иначе обе задачи ждут друг друга вечно', async () => {
    const env = await two();
    const spy = tg();
    await say(env, 'tg-boss', 'полить цветы Ларисы после полить цветы бабули');
    await say(env, 'tg-boss', 'полить цветы бабули после полить цветы Ларисы');
    expect(await dep('granny')).toBeNull();
    expect(sent(spy).at(-1)!.text).toContain('запрут друг друга');
  });

  it('длинная фраза БЕЗ «после» не уходит в перебор: разбор по ключевому слову, а не регуляркой', async () => {
    // Ловушка, на которую я наступил: регулярка `^(.{4,200}?)\s+после\s+(.{4,200})$`
    // на фразе без «после» перебирает все разбиения, и вопрос помощнику висел
    // минутами. Тест падает по таймауту, если разбор снова станет переборным.
    const env = await two();
    tg();
    const long = 'подскажи пожалуйста что мне сегодня стоит сделать в первую очередь '
      + 'и на что обратить внимание завтра с учётом того что на этой неделе много дел '
      + 'и я не очень понимаю за что хвататься сначала а что можно отложить';
    const began = Date.now();
    await say(env, 'tg-boss', long);
    expect(Date.now() - began).toBeLessThan(3000);
    expect(await dep('larisa')).toBeNull();
  });
});

// Живая жалоба: пришло «⚠️ Просрочено: «Посмотреть оформление»», человек
// ответил голосом «заверши её» -- бот спросил «о какой задаче речь?». Бот сам
// её только что назвал.
describe('задача из контекста: «заверши её» после напоминания', () => {
  const selfWorld = async () => {
    const env = await envWith({
      users: [
        { id: 'boss', name: 'Директор', role: 'creator' },
        { id: 'w1', name: 'Азиз Каримов', role: 'admin' },
      ],
      memberships: [{ project_id: 'p1', user_id: 'boss' }, { project_id: 'p1', user_id: 'w1' }],
      projects: [{ id: 'p1', telegram_chat_id: '-100999', created_by: 'boss' }],
      tasks: [
        { id: 't1', project_id: 'p1', title: 'Подготовить отчёт', status: 'todo', responsible_user_id: 'w1', author_id: 'boss' },
        { id: 't2', project_id: 'p1', title: 'Посмотреть оформление', status: 'in_progress', responsible_user_id: 'boss', author_id: 'boss', priority: 'medium' },
      ],
    });
    await testEnv.DB.prepare("UPDATE task_assignees SET state = 'accepted', accepted_at = datetime('now') WHERE task_id = 't2'").run();
    // Задачи «старые»: иначе последней упомянутой была бы просто последняя созданная.
    await testEnv.DB.prepare("UPDATE tasks SET created_at = datetime('now', '-2 days')").run();
    return env;
  };
  const notified = (taskId: string, userId: string, minutesAgo: number) =>
    testEnv.DB.prepare(
      `INSERT INTO notifications (id, task_id, assignee_id, org_id, kind, payload, scheduled_at, sent_at)
       VALUES (?, ?, ?, ?, 'overdue', '{}', ?, ?)`,
    ).bind(`n-${taskId}-${minutesAgo}`, taskId, userId, ORG_A,
      new Date(Date.now() - minutesAgo * 60000).toISOString(), new Date(Date.now() - minutesAgo * 60000).toISOString()).run();
  const task = async (id: string) =>
    (await testEnv.DB.prepare('SELECT status, confirmed_at, priority FROM tasks WHERE id = ?').bind(id).first<{ status: string; confirmed_at: string | null; priority: string }>())!;
  const drafts = async () => (await testEnv.DB.prepare('SELECT COUNT(*) AS n FROM drafts').first<{ n: number }>())!.n;

  it('«заверши её» закрывает задачу из последнего напоминания; своя -- сразу выполнена', async () => {
    const env = await selfWorld();
    const spy = tg();
    await notified('t2', 'boss', 5);
    await say(env, 'tg-boss', 'Заверши её.');
    expect(await task('t2')).toMatchObject({ status: 'done' });
    expect((await task('t2')).confirmed_at).toBeTruthy();
    expect(sent(spy).some((m) => m.text === '✅ «Посмотреть оформление» выполнена.')).toBe(true);
    expect(sent(spy).some((m) => m.text.includes('Уточните'))).toBe(false);
    expect(await drafts()).toBe(0);
    // И ровно ОДНО сообщение: отчёт «✅ Готово · Кто: Яков» о собственном
    // действии приходил вторым и читался как двойное подтверждение.
    expect(sent(spy).filter((m) => m.chat_id === 'tg-boss').map((m) => m.text))
      .toEqual(['✅ «Посмотреть оформление» выполнена.']);
  });

  it('голое «готово» -- о задаче из напоминания; чужая уходит на проверку', async () => {
    const env = await selfWorld();
    const spy = tg();
    await notified('t1', 'w1', 3);
    await say(env, 'tg-w1', 'всё, готово');
    expect(await row('w1')).toMatchObject({ state: 'done' });
    expect(sent(spy).some((m) => m.text === '✅ «Подготовить отчёт» сдана на проверку.')).toBe(true);
    // Исполнителю -- только ответ команды, а отчёт «Готово» уходит АВТОРУ.
    expect(sent(spy).filter((m) => m.chat_id === 'tg-w1')).toHaveLength(1);
    expect(sent(spy).some((m) => m.chat_id === 'tg-boss' && m.text.includes('Готово'))).toBe(true);
  });

  it('напоминание старше получаса уже не в счёт', async () => {
    const env = await selfWorld();
    tg();
    await notified('t2', 'boss', 45);
    await say(env, 'tg-boss', 'заверши её');
    expect(await task('t2')).toMatchObject({ status: 'in_progress' });
  });

  it('«не сделал её» -- не сдача', async () => {
    const env = await selfWorld();
    tg();
    await notified('t2', 'boss', 2);
    await say(env, 'tg-boss', 'я её ещё не сделал');
    expect(await task('t2')).toMatchObject({ status: 'in_progress' });
  });

  it('«сделай это срочно» -- не правка прошлой задачи: «это» ни на что не указывает', async () => {
    const env = await selfWorld();
    tg();
    await notified('t2', 'boss', 2);
    await say(env, 'tg-boss', 'сделай это срочно');
    expect(await task('t2')).toMatchObject({ priority: 'medium' });
  });
});

// Жалоба: «Задачи ставила себе — много раз приходит «просрочено», но я не могу
// сделать «выполнено»». В напоминании была одна «Открыть», в приложении --
// безымянная стрелка «взять в работу», потом «сдать на проверку».
describe('своя задача закрывается одним нажатием', () => {
  const selfWorld = async (state: 'accepted' | 'pending' = 'accepted') => {
    const env = await envWith({
      users: [{ id: 'boss', name: 'Лариса', role: 'creator' }, { id: 'w1', name: 'Азиз Каримов', role: 'admin' }],
      memberships: [{ project_id: 'p1', user_id: 'boss' }, { project_id: 'p1', user_id: 'w1' }],
      projects: [{ id: 'p1', telegram_chat_id: '-100999', created_by: 'boss' }],
      tasks: [
        { id: 'own', project_id: 'p1', title: 'Написать письмо', status: 'in_progress', responsible_user_id: 'boss', author_id: 'boss', deadline: '2026-09-13T18:59:00.000Z' },
        { id: 't1', project_id: 'p1', title: 'Подготовить отчёт', status: 'todo', responsible_user_id: 'w1', author_id: 'boss', deadline: '2026-09-13T18:59:00.000Z' },
      ],
    });
    await testEnv.DB.prepare("UPDATE task_assignees SET state = ?, due_at = '2026-09-13T18:59:00.000Z' WHERE task_id = 'own'").bind(state).run();
    await testEnv.DB.prepare("UPDATE task_assignees SET due_at = '2026-09-13T18:59:00.000Z' WHERE task_id = 't1'").run();
    return env;
  };
  const own = async () => (await testEnv.DB.prepare("SELECT status, confirmed_at FROM tasks WHERE id = 'own'").first<{ status: string; confirmed_at: string | null }>())!;

  it('в «Просрочено» по своей задаче есть «✅ Выполнено», по чужой -- нет', async () => {
    const env = await selfWorld();
    tg();
    await remindOverdue(env, new Date());
    const q = (await testEnv.DB.prepare("SELECT task_id, payload FROM notifications WHERE kind = 'overdue'").all<{ task_id: string; payload: string }>()).results;
    const kb = (id: string) => (JSON.parse(q.find((r) => r.task_id === id)!.payload) as { keyboard: { text: string }[][] }).keyboard.flat().map((b) => b.text);
    expect(kb('own')).toEqual(['✅ Выполнено', '📱 Открыть']);
    expect(kb('t1')).toEqual(['📱 Открыть']);
  });

  it('«✅ Выполнено» закрывает свою задачу, а чужую -- не трогает', async () => {
    const env = await selfWorld();
    const spy = tg();
    await press(env, 'tg-boss', 'done:own');
    expect(await own()).toMatchObject({ status: 'done' });
    expect((await own()).confirmed_at).toBeTruthy();
    // И никаких отчётов самой себе.
    expect(sent(spy).filter((m) => m.chat_id === 'tg-boss')).toHaveLength(0);
    await press(env, 'tg-w1', 'done:t1');
    expect((await testEnv.DB.prepare("SELECT status FROM tasks WHERE id = 't1'").first<{ status: string }>())!.status).toBe('todo');
  });

  it('в приложении «Выполнено» своей задачи -- одно нажатие, даже из «не принято»', async () => {
    const env = await selfWorld('pending');
    tg();
    const res = await apiRoutes.request('/tasks/own/move', {
      method: 'POST', headers: { Cookie: await cookie('boss', 'creator', ORG_A), 'Content-Type': 'application/json' }, body: JSON.stringify({ to: 'done' }),
    }, env);
    expect(res.status).toBe(200);
    expect(await own()).toMatchObject({ status: 'done' });
    expect((await own()).confirmed_at).toBeTruthy();
  });
});

// Аудит: «Принять» на старой карточке ОТМЕНЁННОЙ задачи возвращало её из
// архива, и автору приходило «🚀 Принято».
describe('кнопки старой карточки у закрытой задачи', () => {
  it('«Принять» после отмены не оживляет задачу и никого не извещает', async () => {
    const env = await world();
    const spy = tg();
    await testEnv.DB.prepare("UPDATE tasks SET status = 'archived' WHERE id = 't1'").run();
    await press(env, 'tg-w1', 'accept:t1');
    expect(await status()).toBe('archived');
    expect(await row('w1')).toMatchObject({ state: 'pending' });
    expect(sent(spy).filter((m) => m.text.includes('Принято'))).toHaveLength(0);
    // Кнопки на карточке сняты -- второй раз нажать нечего.
    expect(edits(spy).at(-1)!.reply_markup!.inline_keyboard!.flat().map((b) => b.text)).toEqual(['📱 Открыть']);
  });
});

// Аудит: кто нажимал «Принять» на ЧУЖОМ поручении, получал «🚀 Принято, кто:
// он сам» -- исправление от 17-го касалось только задач себе.
describe('о собственном действии -- ни слова', () => {
  it('«Принять» на поручении: «Принято» получает автор, а не нажавший', async () => {
    const env = await world();
    const spy = tg();
    await press(env, 'tg-w1', 'accept:t1');
    expect(await row('w1')).toMatchObject({ state: 'accepted' });
    expect(sent(spy).filter((m) => m.chat_id === 'tg-w1')).toHaveLength(0);
    expect(sent(spy).some((m) => m.chat_id === 'tg-boss' && m.text.includes('Принято'))).toBe(true);
  });
});
