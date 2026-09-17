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
    await env.DB.prepare("INSERT INTO users (id, phone, name) VALUES ('u1','+1','X')").run();
    await expect(
      env.DB.prepare("INSERT INTO org_memberships (id, org_id, user_id, role) VALUES ('m1','o1','u1','не-роль')").run(),
    ).rejects.toThrow();
    // А member -- допустимая роль с шага 2b (ADR-5).
    await env.DB.prepare("INSERT INTO org_memberships (id, org_id, user_id, role) VALUES ('m2','o1','u1','member')").run();
  });

  it('СУБД настоящая: UNIQUE на телефоне остался ГЛОБАЛЬНЫМ', async () => {
    // Человек глобальный (R1-2), поэтому UNIQUE не стал org-скоупным: один
    // телефон -- один человек, сколько бы организаций у него ни было.
    await env.DB.prepare("INSERT INTO users (id, phone, name) VALUES ('u2','+998900000001','A')").run();
    await expect(
      env.DB.prepare("INSERT INTO users (id, phone, name) VALUES ('u3','+998900000001','B')").run(),
    ).rejects.toThrow();
  });

  it('СУБД настоящая: телефон стал nullable, и NULL не конфликтует с NULL', async () => {
    // Подключение по invite_token через Telegram телефона не спрашивает --
    // до 2b NOT NULL делал такое подключение невозможным. В SQLite NULL не
    // считается дублем NULL, поэтому безтелефонных людей может быть много.
    await env.DB.prepare("INSERT INTO users (id, phone, name) VALUES ('u4',NULL,'Без телефона')").run();
    await env.DB.prepare("INSERT INTO users (id, phone, name) VALUES ('u5',NULL,'Тоже без')").run();
    const { n } = (await env.DB.prepare('SELECT COUNT(*) AS n FROM users WHERE phone IS NULL').first<{ n: number }>())!;
    expect(n).toBe(2);
  });

  it('СУБД настоящая: events принимает новые target_type', async () => {
    // Пересборка 2b расширила CHECK: 'assignee' нужен шагу 3.
    await env.DB.prepare("INSERT INTO events (id, actor_id, target_type, target_id, action) VALUES ('e1',NULL,'assignee','x','accepted')").run();
    await expect(
      env.DB.prepare("INSERT INTO events (id, actor_id, target_type, target_id, action) VALUES ('e2',NULL,'выдумка','x','a')").run(),
    ).rejects.toThrow();
  });
});
