// Приёмка шага 1, часть вторая: поведение outbox и равенство путей.
//
// Структурная половина (единственный писатель статуса) -- test/single-writer.test.ts.
import { env as testEnv } from 'cloudflare:test';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { apiRoutes } from '../src/routes';
import { scheduled } from '../src/scheduled';
import { drainOutbox } from '../src/outbox';
import { cookie, envWith, stubTelegram } from './fixture';

let restore: { mockRestore(): void } | null = null;
afterEach(() => {
  restore?.mockRestore();
  restore = null;
});
const tg = () => (restore = stubTelegram()) as ReturnType<typeof stubTelegram>;

const boss = { id: 's1', phone: '+1', name: 'Босс', role: 'super_admin' };
const worker = { id: 'w1', phone: '+2', name: 'Работник', role: 'admin' };
const team = { users: [boss, worker], memberships: [{ project_id: 'p1', user_id: 's1' }, { project_id: 'p1', user_id: 'w1' }] };

const notes = (taskId: string) =>
  testEnv.DB.prepare('SELECT id, kind, sent_at, attempts, payload FROM notifications WHERE task_id = ? ORDER BY scheduled_at')
    .bind(taskId)
    .all<{ id: string; kind: string; sent_at: string | null; attempts: number; payload: string }>();

const sends = (spy: ReturnType<typeof stubTelegram>) =>
  (spy.mock.calls as unknown as [string, { body?: string }][]).filter(([url]) => url.includes('/sendMessage'));

describe('шаг 1: outbox', () => {
  it('переход кладёт РОВНО одну строку в notifications и отправляет её один раз', async () => {
    const env = await envWith({ ...team, tasks: [{ id: 't1', project_id: 'p1', status: 'todo', responsible_user_id: 'w1' }] });
    const spy = tg();
    const res = await apiRoutes.request('/tasks/t1/move', {
      method: 'POST', headers: { Cookie: await cookie('w1', 'admin'), 'Content-Type': 'application/json' },
      body: JSON.stringify({ to: 'in_progress' }),
    }, env);
    expect(res.status).toBe(200);

    const after = (await notes('t1')).results;
    expect(after).toHaveLength(1);
    expect(after[0].sent_at).not.toBeNull();
    expect(sends(spy)).toHaveLength(1);

    // Повторный проход не создаёт дубля: дедупликация по sent_at, а не по
    // «мы вроде уже отправляли».
    expect(await drainOutbox(env)).toBe(0);
    expect(sends(spy)).toHaveLength(1);
    expect((await notes('t1')).results).toHaveLength(1);
  });

  it('не дошедшая отправка НЕ помечается sent_at, и следующий проход досылает её без дубля', async () => {
    const env = await envWith({ ...team, tasks: [{ id: 't1', project_id: 'p1', status: 'todo', responsible_user_id: 'w1' }] });

    // Telegram отвечает ошибкой -> sendMessage возвращает null.
    const down = vi.spyOn(globalThis, 'fetch').mockResolvedValue(new Response('nope', { status: 500 }));
    await apiRoutes.request('/tasks/t1/move', {
      method: 'POST', headers: { Cookie: await cookie('w1', 'admin'), 'Content-Type': 'application/json' },
      body: JSON.stringify({ to: 'in_progress' }),
    }, env);
    down.mockRestore();

    const pending = (await notes('t1')).results;
    // Состояние задачи изменилось, сообщение -- нет. Это и есть та развилка,
    // ради которой существует outbox: раньше здесь терялось уведомление.
    expect((await testEnv.DB.prepare("SELECT status FROM tasks WHERE id='t1'").first<{ status: string }>())!.status).toBe('in_progress');
    expect(pending).toHaveLength(1);
    expect(pending[0].sent_at).toBeNull();
    expect(pending[0].attempts).toBe(1);

    const spy = tg();
    expect(await drainOutbox(env)).toBe(1);
    expect(sends(spy)).toHaveLength(1);
    const done = (await notes('t1')).results;
    expect(done).toHaveLength(1);
    expect(done[0].sent_at).not.toBeNull();
  });

  it('id отслеживаемого сообщения проставляет проход отправки, а не переход', async () => {
    const env = await envWith({ ...team, tasks: [{ id: 't1', project_id: 'p1', status: 'todo', responsible_user_id: 'w1' }] });
    const down = vi.spyOn(globalThis, 'fetch').mockResolvedValue(new Response('nope', { status: 500 }));
    await apiRoutes.request('/tasks/t1/move', {
      method: 'POST', headers: { Cookie: await cookie('w1', 'admin'), 'Content-Type': 'application/json' },
      body: JSON.stringify({ to: 'in_progress' }),
    }, env);
    down.mockRestore();
    // Сообщения нет -- значит и id взяться неоткуда. Прежний код записал бы null
    // и потерял бы связь с сообщением навсегда.
    expect((await testEnv.DB.prepare("SELECT telegram_message_id FROM tasks WHERE id='t1'").first<{ telegram_message_id: string | null }>())!.telegram_message_id).toBeNull();

    tg();
    await drainOutbox(env);
    expect((await testEnv.DB.prepare("SELECT telegram_message_id FROM tasks WHERE id='t1'").first<{ telegram_message_id: string | null }>())!.telegram_message_id).toBe('1');
  });
});

describe('шаг 1: путь API и путь cron дают одинаковую строку', () => {
  it('архивирование через API и автоархив по cron оставляют неотличимую задачу', async () => {
    const day = 24 * 3600 * 1000;
    const stale = new Date(Date.now() - 8 * day).toISOString();
    const env = await envWith({
      ...team,
      tasks: [
        { id: 'api', project_id: 'p1', status: 'done', responsible_user_id: 'w1', done_at: stale },
        { id: 'cron', project_id: 'p1', status: 'done', responsible_user_id: 'w1', done_at: stale },
      ],
    });
    tg();

    await apiRoutes.request('/tasks/api', { method: 'DELETE', headers: { Cookie: await cookie('s1', 'super_admin') } }, env);
    await scheduled({} as ScheduledController, env, {} as ExecutionContext);

    const row = (id: string) =>
      testEnv.DB.prepare('SELECT status, done_at, confirmed_at, telegram_message_id FROM tasks WHERE id = ?').bind(id).first<Record<string, unknown>>();
    const viaApi = await row('api');
    const viaCron = await row('cron');
    expect(viaApi!.status).toBe('archived');
    // Единственная функция перехода -- значит и колонки должны совпасть, а не
    // «примерно совпасть». До шага 1 два пути гасили разные поля.
    expect(viaCron).toEqual(viaApi);

    const actions = async (id: string) =>
      (await testEnv.DB.prepare("SELECT action, actor_id FROM events WHERE target_id = ? AND target_type='task'").bind(id).all<{ action: string; actor_id: string | null }>()).results;
    // Действия названы по-разному намеренно (ручное «deleted» против системного
    // «archived»), но актор отличает их однозначно: система -- это null.
    expect((await actions('api'))[0]).toMatchObject({ action: 'deleted', actor_id: 's1' });
    expect((await actions('cron'))[0]).toMatchObject({ action: 'archived', actor_id: null });
  });

  it('после закрытия ни один проход cron не шлёт по задаче сообщений', async () => {
    const env = await envWith({
      ...team,
      tasks: [
        // Просроченная и «давно готовая» -- то есть подходящая под эскалацию,
        // напоминание и напоминание о проверке, если бы не статус.
        { id: 'closed', project_id: 'p1', status: 'archived', responsible_user_id: 'w1', deadline: '2020-01-01T00:00:00.000Z', done_at: '2020-01-02T00:00:00.000Z' },
      ],
    });
    const spy = tg();
    await scheduled({} as ScheduledController, env, {} as ExecutionContext);
    expect(sends(spy)).toHaveLength(0);
    expect((await notes('closed')).results).toHaveLength(0);
  });
});
