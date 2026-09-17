// Находки консенсус-ревью по очереди отправки.
//
// Все три дефекта ниже жили при 167 зелёных тестах, и это факт о наборе, а не о
// коде: он проверял ОДНУ строку в очереди и ОДИН проход. Ни очередь под
// нагрузкой, ни параллельность, ни недоставляемый получатель не проверялись
// вообще.
import { env as testEnv } from 'cloudflare:test';
import { afterEach, describe, expect, it } from 'vitest';
import { drainOutbox } from '../src/outbox';
import { envWith, ORG_A, stubTelegram } from './fixture';
import type { Env } from '../src/types';

let restore: { mockRestore(): void } | null = null;
afterEach(() => { restore?.mockRestore(); restore = null; });
const tg = () => (restore = stubTelegram()) as ReturnType<typeof stubTelegram>;
const sends = (spy: ReturnType<typeof stubTelegram>) =>
  (spy.mock.calls as unknown as [string][]).filter(([u]) => u.includes('/sendMessage'));

const world = () =>
  envWith({
    users: [
      { id: 'boss', name: 'Босс', role: 'creator' },
      { id: 'ok', name: 'Подключённый', role: 'admin' },
      // Бота не подключал: адрес не резолвится, строка недоставляема.
      { id: 'nobot', name: 'Без бота', role: 'admin', telegram_user_id: null },
    ],
    memberships: [{ project_id: 'p1', user_id: 'boss' }, { project_id: 'p1', user_id: 'ok' }, { project_id: 'p1', user_id: 'nobot' }],
    projects: [{ id: 'p1', telegram_chat_id: '-100999', created_by: 'boss' }],
    tasks: [{ id: 't1', project_id: 'p1', status: 'todo', responsible_user_id: 'ok', author_id: 'boss' }],
  });

const queue = async (recipient: string, text: string, n = 1) => {
  for (let i = 0; i < n; i++) {
    await testEnv.DB.prepare(
      "INSERT INTO notifications (id, task_id, assignee_id, org_id, kind, payload) VALUES (?, 't1', ?, ?, 'test', ?)",
    ).bind(`n-${recipient}-${i}-${Math.random()}`, recipient, ORG_A,
      JSON.stringify({ recipient_user_id: recipient, text, delete_message_id: null, track: false })).run();
  }
};

describe('ревью: очередь не встаёт от недоставляемого получателя', () => {
  it('55 строк неподключённому человеку НЕ блокируют доставку остальным', async () => {
    const env = await world();
    // Выборка берёт первые BATCH=50 по scheduled_at. Пока эти 50 недоставляемы
    // и не гаснут, всё, что за ними, не выбирается ВООБЩЕ -- в том числе срочные
    // эскалации, которые обязаны пробивать тихие часы.
    await queue('nobot', 'кому-то, кто не подключил бота', 55);
    await queue('ok', 'а это должно дойти');

    const spy = tg();
    // Первый проход упирается в стену недоставляемых...
    for (let i = 0; i < 12; i++) await drainOutbox(env);
    // ...но attempts растёт, и после порога они выпадают из выборки.
    expect(sends(spy).length).toBeGreaterThan(0);

    const delivered = await testEnv.DB.prepare(
      "SELECT COUNT(*) AS n FROM notifications WHERE assignee_id = 'ok' AND sent_at IS NOT NULL",
    ).first<{ n: number }>();
    expect(delivered!.n, 'строка подключённому так и не доставлена').toBe(1);
  });
});

describe('ревью: параллельные проходы не дублируют отправку', () => {
  it('два одновременных drainOutbox шлют каждое сообщение ОДИН раз', async () => {
    const env = await world();
    await queue('ok', 'ровно один раз', 3);

    const spy = tg();
    // drainOutbox зовётся из каждого мутирующего роута, из обеих веток бота и
    // из cron. Рассылка на 14 человек -- это 14 нажатий «Принял» в минуту,
    // то есть конкуренция здесь норма, а не край.
    const [a, b] = await Promise.all([drainOutbox(env), drainOutbox(env)]);

    expect(sends(spy)).toHaveLength(3);
    expect(a + b).toBe(3);
    const pending = await testEnv.DB.prepare('SELECT COUNT(*) AS n FROM notifications WHERE sent_at IS NULL').first<{ n: number }>();
    expect(pending!.n).toBe(0);
  });
});

describe('ревью: недоставленное возвращается в очередь, но не навечно', () => {
  it('упавшая отправка снимает клейм, а после порога строка выпадает', async () => {
    const env = await world();
    await queue('ok', 'телеграм лежит');

    // Telegram отвечает ошибкой: строка обязана вернуться в очередь.
    const down = { mockRestore() {} };
    restore = down;
    const spy = (await import('vitest')).vi.spyOn(globalThis, 'fetch').mockResolvedValue(new Response('nope', { status: 500 }));
    for (let i = 0; i < 12; i++) await drainOutbox(env as Env);
    spy.mockRestore();

    const row = await testEnv.DB.prepare('SELECT sent_at, attempts FROM notifications').first<{ sent_at: string | null; attempts: number }>();
    // Не помечена отправленной (её не отправили)...
    expect(row!.sent_at).toBeNull();
    // ...но и не крутится вечно: после порога выборка её не берёт.
    expect(row!.attempts).toBeGreaterThanOrEqual(10);
  });
});
