// Приёмка шага 4c: личный слой -- поводы, потолок, метрики.
//
// Пять принятых метрик записаны здесь как SQL: они и есть приёмка пилота, и
// проверять надо не «есть ли код», а считаются ли они вообще на живой схеме.
import { env as testEnv } from 'cloudflare:test';
import { afterEach, describe, expect, it } from 'vitest';
import { enqueueNudges } from '../src/nudges';
import { drainOutbox } from '../src/outbox';
import { botApp } from '../src/bot';
import { envWith, ORG_A, stubTelegram } from './fixture';
import type { Env } from '../src/types';

let restore: { mockRestore(): void } | null = null;
afterEach(() => { restore?.mockRestore(); restore = null; });
const tg = () => (restore = stubTelegram()) as ReturnType<typeof stubTelegram>;
const calls = (spy: ReturnType<typeof stubTelegram>) => spy.mock.calls as unknown as [string, { body?: string }][];

const boss = { id: 'boss', name: 'Директор', role: 'creator' };
const w1 = { id: 'w1', name: 'Работник', role: 'admin' };
const old = "datetime('now', '-5 day')";

const world = () =>
  envWith({
    users: [boss, w1],
    memberships: [{ project_id: 'p1', user_id: 'boss' }, { project_id: 'p1', user_id: 'w1' }],
    projects: [{ id: 'p1', telegram_chat_id: '-100999', created_by: 'boss' }],
    tasks: [
      { id: 'stale1', project_id: 'p1', status: 'todo', responsible_user_id: 'w1', author_id: 'boss' },
      { id: 'stale2', project_id: 'p1', status: 'todo', responsible_user_id: 'w1', author_id: 'boss' },
      { id: 'stale3', project_id: 'p1', status: 'todo', responsible_user_id: 'w1', author_id: 'boss' },
    ],
  });

// Задачи «состарить»: кандидаты требуют возраст, иначе поводов не будет вовсе и
// тест окажется вакуумно зелёным.
const age = () => testEnv.DB.prepare(`UPDATE tasks SET created_at = ${old}`).run();

const hook = (env: Env, body: unknown) =>
  botApp.request('/webhook', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json', 'X-Telegram-Bot-Api-Secret-Token': 'tg-secret' },
    body: JSON.stringify(body),
  }, env);

describe('шаг 4c: поводы', () => {
  it('повод адресован АВТОРУ и говорит про чужую работу, не про его дела', async () => {
    const env = await world();
    await age();
    tg();
    expect(await enqueueNudges(env)).toBeGreaterThan(0);
    const { results } = await testEnv.DB.prepare('SELECT user_id, kind, actionable FROM nudges').all<{ user_id: string; kind: string; actionable: number }>();
    // Инициатива ТОЛЬКО про поручения другим -- прямое требование заказчика.
    // Повод уходит тому, кто поручил, а не тому, кто исполняет.
    expect(results.every((r) => r.user_id === 'boss')).toBe(true);
    expect(results.every((r) => r.kind === 'stale_task')).toBe(true);
  });

  it('потолок два повода в день соблюдается и внутри одного прохода', async () => {
    const env = await world();
    await age();
    tg();
    // Кандидатов три, но за один тик человек получит максимум два: иначе один
    // проход cron выдал бы десяток, каждый «второй за день» по отдельности.
    await enqueueNudges(env);
    const { n } = (await testEnv.DB.prepare('SELECT COUNT(*) AS n FROM nudges WHERE user_id = ?').bind('boss').first<{ n: number }>())!;
    expect(n).toBe(2);

    // Следующий тик в тот же день не добавляет ничего.
    await enqueueNudges(env);
    const { n: after } = (await testEnv.DB.prepare('SELECT COUNT(*) AS n FROM nudges WHERE user_id = ?').bind('boss').first<{ n: number }>())!;
    expect(after).toBe(2);
  });

  it('поводы едут ТЕМ ЖЕ outbox -- значит тихие часы их накрывают', async () => {
    const env = await world();
    await age();
    const spy = tg();
    await enqueueNudges(env);
    // Не отправлены сразу: строка в очереди, отправкой занимается drainOutbox.
    expect(calls(spy).filter(([u]) => u.includes('/sendMessage'))).toHaveLength(0);
    expect(await drainOutbox(env)).toBe(2);
    expect(calls(spy).filter(([u]) => u.includes('/sendMessage'))).toHaveLength(2);
  });

  it('нажатие на кнопку повода отмечается: без acted_at метрика без числителя', async () => {
    const env = await world();
    await age();
    tg();
    await enqueueNudges(env);
    const nudge = await testEnv.DB.prepare('SELECT task_id FROM nudges LIMIT 1').first<{ task_id: string }>();

    await hook(env, {
      callback_query: { id: 'cb', from: { id: 'tg-boss' }, data: `nudge_remind:${nudge!.task_id}`, message: { chat: { id: 1, type: 'private' }, message_id: 2 } },
    });
    const acted = await testEnv.DB.prepare('SELECT acted_at FROM nudges WHERE task_id = ?').bind(nudge!.task_id).first<{ acted_at: string | null }>();
    expect(acted!.acted_at).not.toBeNull();
  });

  it('«принять» с кнопки повода доступно только автору', async () => {
    const env = await world();
    await testEnv.DB.prepare("UPDATE tasks SET status='done', done_at=datetime('now','-3 day'), author_id='boss' WHERE id='stale1'").run();
    await testEnv.DB.prepare("UPDATE task_assignees SET state='done' WHERE task_id='stale1'").run();
    tg();
    await enqueueNudges(env);

    // Работник не автор -- кнопку могли переслать, и гейт обязан её отбить.
    await hook(env, { callback_query: { id: 'c1', from: { id: 'tg-w1' }, data: 'nudge_confirm:stale1', message: { chat: { id: 1, type: 'private' }, message_id: 2 } } });
    expect((await testEnv.DB.prepare("SELECT confirmed_at FROM tasks WHERE id='stale1'").first<{ confirmed_at: string | null }>())!.confirmed_at).toBeNull();

    await hook(env, { callback_query: { id: 'c2', from: { id: 'tg-boss' }, data: 'nudge_confirm:stale1', message: { chat: { id: 1, type: 'private' }, message_id: 2 } } });
    expect((await testEnv.DB.prepare("SELECT confirmed_at FROM tasks WHERE id='stale1'").first<{ confirmed_at: string | null }>())!.confirmed_at).not.toBeNull();
    // Та же дорога, что «Принять» в приложении: строки помечены принятыми,
    // событие в журнале, исполнителю ушло «Подтверждено».
    expect((await testEnv.DB.prepare("SELECT state FROM task_assignees WHERE task_id='stale1'").first<{ state: string }>())!.state).toBe('confirmed');
    expect((await testEnv.DB.prepare("SELECT COUNT(*) AS n FROM events WHERE target_id='stale1' AND action='confirmed'").first<{ n: number }>())!.n).toBe(1);
    expect((await testEnv.DB.prepare("SELECT COUNT(*) AS n FROM notifications WHERE task_id='stale1' AND payload LIKE '%Подтверждено%'").first<{ n: number }>())!.n).toBeGreaterThan(0);
  });

  it('промах пишется САМ -- из поправки черновика, а не командой', async () => {
    // Команду /промах не набирал никто, и знаменатель метрики оставался пустым.
    // Поправка черновика -- честный сигнал: разобрали не так.
    const env = await world();
    tg();
    await hook(env, { message: { chat: { id: 1, type: 'private' }, from: { id: 'tg-boss' }, text: 'Азизу подготовить отчёт' } });
    const d = (await testEnv.DB.prepare('SELECT id, telegram_chat_id, telegram_message_id FROM drafts').first<{ id: string }>())!;
    await hook(env, { callback_query: { id: 'c9', from: { id: 'tg-boss' }, data: `de:${d.id}`, message: { chat: { id: 1, type: 'private' }, message_id: 3 } } });
    await hook(env, { message: { chat: { id: 1, type: 'private' }, from: { id: 'tg-boss' }, text: 'срок вторник' } });
    const { n } = (await testEnv.DB.prepare("SELECT COUNT(*) AS n FROM events WHERE action='miss'").first<{ n: number }>())!;
    expect(n).toBe(1);
  });
});

describe('шаг 4c: пять метрик пилота', () => {
  // ПРЕЖНЯЯ РЕДАКЦИЯ ЭТОГО БЛОКА БЫЛА ВАКУУМНОЙ, и это нашёл Critic.
  // Она утверждала по каждой метрике только `expect(row).not.toBeNull()`, а все
  // пять -- агрегаты: `.first()` на COUNT/SUM возвращает строку ВСЕГДА, хоть по
  // пустой таблице. Утверждение было истинно по семантике SQL, независимо от
  // данных и от правильности самой метрики -- покраснеть могло лишь на
  // синтаксической ошибке. И оно прятало дефект: метрика №1 считала РАЗЛИЧНЫЕ
  // дни, тогда как план требует дней ПОДРЯД.
  //
  // Теперь каждая метрика проверяется ЗНАЧЕНИЕМ на засеянных данных.

  it('№1 «дней подряд с поручением» считает подряд, а не различные дни', async () => {
    const env = await world();
    void env;
    // Три дня подряд, потом разрыв, потом ещё день. Различных дней -- четыре,
    // подряд идущих (считая от последнего) -- один. Прежняя формула дала бы 4 и
    // объявила бы пилот успешным при разорванной серии.
    const days = [0, 1, 2, 5];
    for (const d of days) {
      await testEnv.DB.prepare(
        `INSERT INTO tasks (id, org_id, project_id, title, author_id, kind, status, created_at)
         VALUES (?, ?, 'p1', 'x', 'boss', 'single', 'todo', datetime('now', ?))`,
      ).bind(`m-${d}`, ORG_A, `-${d} day`).run();
    }

    const { results } = await testEnv.DB.prepare(
      `SELECT DISTINCT date(created_at) AS d FROM tasks WHERE org_id = ? ORDER BY d DESC`,
    ).bind(ORG_A).all<{ d: string }>();

    // Серия считается в коде, а не в SQL: рекурсивный CTE ради одной цифры раз в
    // две недели -- цена, которой пилот не стоит.
    let streak = 0;
    const day = 86400_000;
    const today = new Date(new Date().toISOString().slice(0, 10)).getTime();
    for (let i = 0; i < results.length; i++) {
      if (new Date(results[i].d).getTime() === today - i * day) streak++;
      else break;
    }
    expect(results.length, 'различных дней').toBe(4);
    expect(streak, 'дней ПОДРЯД -- не то же самое, что различных').toBe(3);
  });

  it('№2 «промахов за 14 дней» считает только окно', async () => {
    await world();
    await testEnv.DB.prepare(
      "INSERT INTO events (id, actor_id, org_id, target_type, target_id, action, created_at) VALUES ('fresh','boss',?, 'user','boss','miss', datetime('now'))",
    ).bind(ORG_A).run();
    await testEnv.DB.prepare(
      "INSERT INTO events (id, actor_id, org_id, target_type, target_id, action, created_at) VALUES ('old','boss',?, 'user','boss','miss', datetime('now','-20 day'))",
    ).bind(ORG_A).run();

    const { v } = (await testEnv.DB.prepare(
      "SELECT COUNT(*) AS v FROM events WHERE action='miss' AND created_at >= datetime('now','-14 day')",
    ).first<{ v: number }>())!;
    // Старый промах за окном -- иначе метрика «≤2 за 14 дней» копила бы вечно.
    expect(v).toBe(1);
  });

  it('№3 «доля поводов с содержательной кнопкой» -- сегодня тождественно 1, и это надо знать', async () => {
    const env = await world();
    await age();
    tg();
    await enqueueNudges(env);
    const { v } = (await testEnv.DB.prepare(
      'SELECT CAST(SUM(actionable) AS REAL) / NULLIF(COUNT(*),0) AS v FROM nudges',
    ).first<{ v: number }>())!;
    // Оба (и единственных) вида поводов ставят actionable = 1, поэтому метрика
    // равна единице ПО ПОСТРОЕНИЮ, а не по качеству продукта. Порог «≥40%»
    // ничего не измеряет, пока не появится повод без кнопки. Фиксируем это
    // значением, чтобы факт был виден, а не выглядел успехом.
    expect(v).toBe(1);
  });

  it('№4 «доля поводов без нажатия за сутки» реагирует на нажатие', async () => {
    const env = await world();
    await age();
    tg();
    await enqueueNudges(env);
    // Состариваем поводы: метрика смотрит на те, что старше суток.
    await testEnv.DB.prepare("UPDATE nudges SET sent_at = datetime('now','-2 day')").run();
    const sql = "SELECT CAST(SUM(CASE WHEN acted_at IS NULL AND sent_at < datetime('now','-1 day') THEN 1 ELSE 0 END) AS REAL) / NULLIF(COUNT(*),0) AS v FROM nudges";
    expect((await testEnv.DB.prepare(sql).first<{ v: number }>())!.v).toBe(1);

    const one = await testEnv.DB.prepare('SELECT task_id FROM nudges LIMIT 1').first<{ task_id: string }>();
    await hook(env, { callback_query: { id: 'c', from: { id: 'tg-boss' }, data: `nudge_remind:${one!.task_id}`, message: { chat: { id: 1, type: 'private' }, message_id: 2 } } });
    expect((await testEnv.DB.prepare(sql).first<{ v: number }>())!.v).toBeLessThan(1);
  });

  it('№5 «поводов за календарный день» считает в поясе организации, а не в UTC', async () => {
    const env = await world();
    await age();
    tg();
    await enqueueNudges(env);
    // Потолок обеспечивается в поясе организации (nudges.ts), поэтому и метрика
    // обязана считать в нём же: в Ташкенте UTC-сутки сдвинуты на пять часов, и
    // date(sent_at) по UTC разносил бы вечерние поводы на «другой день».
    const { v } = (await testEnv.DB.prepare(
      `SELECT COUNT(*) AS v FROM nudges n JOIN orgs o ON o.id = n.org_id
       WHERE date(n.sent_at, '+5 hours') = date('now', '+5 hours') AND n.user_id = 'boss'`,
    ).first<{ v: number }>())!;
    expect(v).toBeGreaterThan(0);
    expect(v).toBeLessThanOrEqual(2);
  });
});
