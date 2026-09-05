// Приёмка шага 4c: личный слой -- поводы, потолок, метрики.
//
// Пять принятых метрик записаны здесь как SQL: они и есть приёмка пилота, и
// проверять надо не «есть ли код», а считаются ли они вообще на живой схеме.
import { env as testEnv } from 'cloudflare:test';
import { afterEach, describe, expect, it } from 'vitest';
import { apiRoutes } from '../src/routes';
import { enqueueNudges } from '../src/nudges';
import { drainOutbox } from '../src/outbox';
import { botApp } from '../src/bot';
import { cookie, envWith, ORG_A, stubTelegram } from './fixture';
import type { Env } from '../src/types';

let restore: { mockRestore(): void } | null = null;
afterEach(() => { restore?.mockRestore(); restore = null; });
const tg = () => (restore = stubTelegram()) as ReturnType<typeof stubTelegram>;
const calls = (spy: ReturnType<typeof stubTelegram>) => spy.mock.calls as unknown as [string, { body?: string }][];

const boss = { id: 'boss', phone: '+1', name: 'Директор', role: 'creator' };
const w1 = { id: 'w1', phone: '+2', name: 'Работник', role: 'admin' };
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
  });

  it('/промах пишет events.action = miss -- знаменатель метрики', async () => {
    const env = await world();
    tg();
    await hook(env, { message: { chat: { id: 1, type: 'private' }, from: { id: 'tg-boss' }, text: '/промах' } });
    const { n } = (await testEnv.DB.prepare("SELECT COUNT(*) AS n FROM events WHERE action='miss'").first<{ n: number }>())!;
    expect(n).toBe(1);
  });
});

describe('шаг 4c: пять метрик считаются на живой схеме', () => {
  it('каждая метрика выполняется и возвращает число', async () => {
    const env = await world();
    await age();
    tg();
    await enqueueNudges(env);
    await apiRoutes.request('/projects/p1/tasks', {
      method: 'POST', headers: { Cookie: await cookie('boss', 'creator', ORG_A), 'Content-Type': 'application/json' },
      body: JSON.stringify({ title: 'Сегодняшняя', responsible_user_id: 'w1' }),
    }, env);

    // Метрики -- это и есть приёмка пилота. Проверяем не значения (их даст
    // только живой пилот), а что каждая СЧИТАЕТСЯ на текущей схеме: метрика,
    // падающая с ошибкой SQL через две недели, обесценивает весь замер.
    const metrics: [string, string][] = [
      ['дней подряд с ≥1 поручением',
       "SELECT COUNT(DISTINCT date(created_at)) AS v FROM tasks WHERE org_id = 'org-a' AND created_at >= datetime('now','-10 day')"],
      ['промахов за 14 дней',
       "SELECT COUNT(*) AS v FROM events WHERE action='miss' AND created_at >= datetime('now','-14 day')"],
      ['доля поводов с содержательной кнопкой',
       'SELECT CAST(SUM(actionable) AS REAL) / NULLIF(COUNT(*),0) AS v FROM nudges'],
      ['доля поводов без нажатия за сутки',
       "SELECT CAST(SUM(CASE WHEN acted_at IS NULL AND sent_at < datetime('now','-1 day') THEN 1 ELSE 0 END) AS REAL) / NULLIF(COUNT(*),0) AS v FROM nudges"],
      ['поводов за календарный день',
       "SELECT COUNT(*) AS v FROM nudges WHERE date(sent_at) = date('now')"],
    ];
    for (const [name, sql] of metrics) {
      const row = await testEnv.DB.prepare(sql).first<{ v: number | null }>();
      expect(row, `метрика «${name}» не посчиталась`).not.toBeNull();
    }

    // Потолок «≤2 в календарный день» -- единственная метрика, которую можно
    // проверить значением уже сейчас.
    const cap = await testEnv.DB.prepare("SELECT COUNT(*) AS v FROM nudges WHERE user_id='boss' AND date(sent_at) = date('now')").first<{ v: number }>();
    expect(cap!.v).toBeLessThanOrEqual(2);
  });
});
