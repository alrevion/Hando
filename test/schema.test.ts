// Дымовой тест харнесса: доказывает, что тесты идут против настоящей D1 с
// применёнными миграциями, а не против объекта, подменяющего базу.
import { env } from 'cloudflare:test';
import { describe, expect, it } from 'vitest';

describe('тестовая база — настоящая D1', () => {
  it('миграции применены: есть все таблицы схемы 0001-0008', async () => {
    const { results } = await env.DB.prepare(
      "SELECT name FROM sqlite_master WHERE type='table' AND name NOT LIKE 'sqlite_%' AND name NOT LIKE 'd1_%' ORDER BY name",
    ).all<{ name: string }>();
    expect(results.map((r) => r.name)).toEqual([
      'attachments',
      'events',
      'project_memberships',
      'projects',
      'tasks',
      'users',
    ]);
  });

  it('колонки поздних миграций на месте', async () => {
    const { results } = await env.DB.prepare('PRAGMA table_info(tasks)').all<{ name: string }>();
    const cols = results.map((r) => r.name);
    for (const c of ['priority', 'depends_on_task_id', 'reminder_sent_at', 'review_reminded_at', 'confirmed_at', 'content_blocks']) {
      expect(cols).toContain(c);
    }
  });

  it('СУБД настоящая: нарушение CHECK роняет запрос', async () => {
    // Подделка по регуляркам такого не умеет — это и есть разница.
    await expect(
      env.DB.prepare("INSERT INTO users (id, phone, name, role) VALUES ('u1','+1','X','не-роль')").run(),
    ).rejects.toThrow();
  });

  it('СУБД настоящая: UNIQUE на телефоне работает', async () => {
    await env.DB.prepare("INSERT INTO users (id, phone, name, role) VALUES ('u2','+998900000001','A','admin')").run();
    await expect(
      env.DB.prepare("INSERT INTO users (id, phone, name, role) VALUES ('u3','+998900000001','B','admin')").run(),
    ).rejects.toThrow();
  });
});
