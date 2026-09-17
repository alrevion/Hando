// Дымовой тест харнесса: доказывает, что тесты идут против настоящей D1 с
// применёнными миграциями, а не против объекта, подменяющего базу.
import { env } from 'cloudflare:test';
import { describe, expect, it } from 'vitest';

describe('тестовая база — настоящая D1', () => {
  it('миграции применены: есть все таблицы схемы 0001-0023', async () => {
    const { results } = await env.DB.prepare(
      "SELECT name FROM sqlite_master WHERE type='table' AND name NOT LIKE 'sqlite_%' AND name NOT LIKE 'd1_%' ORDER BY name",
    ).all<{ name: string }>();
    expect(results.map((r: { name: string }) => r.name)).toEqual([
      'answer_cache',
      'attachments',
      'drafts',
      'events',
      'intent_cache',
      'login_links',
      'notifications',
      'nudges',
      'org_memberships',
      'orgs',
      'parse_stats',
      'project_memberships',
      'projects',
      'reminders',
      'task_assignees',
      'tasks',
      'users',
    ]);
  });

  it('колонки поздних миграций на месте, а снятые contract-релизом -- ушли', async () => {
    const { results } = await env.DB.prepare('PRAGMA table_info(tasks)').all<{ name: string }>();
    const cols = results.map((r: { name: string }) => r.name);
    for (const c of ['priority', 'depends_on_task_id', 'confirmed_at', 'content_blocks', 'kind', 'author_id', 'source']) {
      expect(cols).toContain(c);
    }
    // Contract-релиз снял «кто делает» и три по-задачных таймера: и то и другое
    // переехало на строки адресатов. Проверка на ОТСУТСТВИЕ обязательна --
    // иначе колонка, случайно возвращённая в пересборке, жила бы незамеченной и
    // код снова начал бы писать в два места.
    for (const c of ['responsible_user_id', 'last_escalated_at', 'reminder_sent_at', 'review_reminded_at']) {
      expect(cols, `${c} обязана была уйти из tasks`).not.toContain(c);
    }
    const { results: aCols } = await env.DB.prepare('PRAGMA table_info(task_assignees)').all<{ name: string }>();
    for (const c of ['last_escalated_at', 'reminder_sent_at', 'review_reminded_at', 'due_at', 'state']) {
      expect(aCols.map((r: { name: string }) => r.name)).toContain(c);
    }
  });

  it('СУБД настоящая: нарушение CHECK роняет запрос', async () => {
    // Подделка по регуляркам такого не умеет — это и есть разница.
    // CHECK на роли переехал с шага 2b в org_memberships: users роли не хранит.
    await env.DB.prepare("INSERT INTO orgs (id, name) VALUES ('o1','O')").run();
    await env.DB.prepare("INSERT INTO users (id, name) VALUES ('u1','X')").run();
    await expect(
      env.DB.prepare("INSERT INTO org_memberships (id, org_id, user_id, role) VALUES ('m1','o1','u1','не-роль')").run(),
    ).rejects.toThrow();
    // А member -- допустимая роль с шага 2b (ADR-5).
    await env.DB.prepare("INSERT INTO org_memberships (id, org_id, user_id, role) VALUES ('m2','o1','u1','member')").run();
  });

  it('номеров телефонов в базе нет вовсе (0034): их пришлось бы хранить в РУз', async () => {
    const { results } = await env.DB.prepare('PRAGMA table_info(users)').all<{ name: string }>();
    expect(results.map((r: { name: string }) => r.name)).not.toContain('phone');
    // Индексы пересборки на месте: вход по Telegram ищет человека по ним.
    const idx = await env.DB.prepare("SELECT name FROM sqlite_master WHERE type='index' AND tbl_name='users' AND name LIKE 'idx_%' ORDER BY name").all<{ name: string }>();
    expect(idx.results.map((r: { name: string }) => r.name)).toEqual(['idx_users_invite', 'idx_users_pending_signup', 'idx_users_telegram']);
  });

  it('СУБД настоящая: events принимает новые target_type', async () => {
    // Пересборка 2b расширила CHECK: 'assignee' нужен шагу 3.
    await env.DB.prepare("INSERT INTO events (id, actor_id, target_type, target_id, action) VALUES ('e1',NULL,'assignee','x','accepted')").run();
    await expect(
      env.DB.prepare("INSERT INTO events (id, actor_id, target_type, target_id, action) VALUES ('e2',NULL,'выдумка','x','a')").run(),
    ).rejects.toThrow();
  });
});
