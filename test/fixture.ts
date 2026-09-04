// Общая фикстура тестов: настоящая D1 в workerd, настоящая цепочка middleware.
//
// Прежняя редакция использовала fakeDB -- диспетчер по регуляркам на тексте SQL.
// Он не мог провалиться на пропущенном условии: `/FROM users WHERE id/` возвращал
// пользователя независимо от остального WHERE, поэтому `AND org_id = ?` был для
// него невидим, как и его отсутствие. Тест изоляции на таком харнессе зелёный на
// дырявом проде -- см. шаг -1 плана.
import { env as testEnv } from 'cloudflare:test';
import { vi } from 'vitest';
import { mintSession } from '../src/auth';
import type { Env } from '../src/types';

export const SECRET = 'test-secret';

type FakeData = {
  users: Array<{ id: string; phone: string; name: string; role: string; telegram_username?: string }>;
  memberships: Array<{ project_id: string; user_id: string }>;
  tasks: Array<Record<string, unknown>>;
  projects?: Array<{ id: string; telegram_chat_id: string; created_by?: string; archived_at?: string }>;
  attachments?: Array<{ id: string; task_id: string; uploaded_by: string; telegram_message_id: string; telegram_file_id: string; filename: string; mime_type: string; size_bytes: number }>;
};

// Засевает фикстуру в настоящую D1. Изоляция хранилища у vitest-pool-workers
// откатывает записи между тестами, поэтому каждый тест начинает с чистой схемы.
//
// Недостающие цели внешних ключей (проект, на который ссылается задача;
// автор проекта) досоздаются автоматически: фикстуры писались под подделку,
// где ссылочной целостности не было. Это осознанно -- набор проверяет, КТО
// куда доберётся, а целостность схемы покрыта schema.test.ts.
export async function envWith(data: FakeData): Promise<Env> {
  const db = testEnv.DB;
  const stmts: D1PreparedStatement[] = [];
  const userIds = new Set(data.users.map((u) => u.id));

  for (const u of data.users) {
    stmts.push(
      db.prepare('INSERT INTO users (id, phone, name, role, telegram_username) VALUES (?,?,?,?,?)')
        .bind(u.id, u.phone, u.name, u.role, u.telegram_username ?? null),
    );
  }

  // Проекты: явные из фикстуры плюс те, на которые ссылаются задачи и членства.
  const projects = new Map<string, { id: string; chat: string; by: string; archived: string | null }>();
  for (const p of data.projects ?? []) projects.set(p.id, { id: p.id, chat: p.telegram_chat_id, by: p.created_by ?? '__seed', archived: p.archived_at ?? null });
  for (const t of data.tasks) {
    const pid = t.project_id as string | undefined;
    if (pid && !projects.has(pid)) projects.set(pid, { id: pid, chat: '-100000', by: '__seed', archived: null });
  }
  for (const m of data.memberships) {
    if (!projects.has(m.project_id)) projects.set(m.project_id, { id: m.project_id, chat: '-100000', by: '__seed', archived: null });
  }

  // Все пользователи, на которых ссылаются строки, но которых нет в фикстуре
  // (created_by проекта, uploaded_by вложения, ответственный за задачу).
  // Настоящая D1 проверяет внешние ключи -- подделка не проверяла.
  const referenced = new Set<string>();
  for (const p of projects.values()) referenced.add(p.by);
  for (const t of data.tasks) referenced.add((t.responsible_user_id as string) ?? '__seed');
  for (const a of data.attachments ?? []) referenced.add(a.uploaded_by);
  let phone = 0;
  for (const id of referenced) {
    if (userIds.has(id)) continue;
    stmts.push(db.prepare('INSERT INTO users (id, phone, name, role) VALUES (?,?,?,?)').bind(id, `+00${phone++}`, id, 'admin'));
  }
  for (const p of projects.values()) {
    stmts.push(db.prepare('INSERT INTO projects (id, name, created_by, telegram_chat_id, archived_at) VALUES (?,?,?,?,?)').bind(p.id, p.id, p.by, p.chat, p.archived));
  }
  for (const m of data.memberships) {
    stmts.push(db.prepare('INSERT INTO project_memberships (id, project_id, user_id) VALUES (?,?,?)').bind(`${m.project_id}:${m.user_id}`, m.project_id, m.user_id));
  }
  for (const t of data.tasks) {
    const resp = (t.responsible_user_id as string) ?? '__seed';
    stmts.push(
      db.prepare(
        `INSERT INTO tasks (id, project_id, title, description, responsible_user_id, status, deadline, done_at, confirmed_at, telegram_message_id, priority, depends_on_task_id)
         VALUES (?,?,?,?,?,?,?,?,?,?,?,?)`,
      ).bind(
        t.id, t.project_id, (t.title as string) ?? 'T', (t.description as string) ?? '', resp,
        (t.status as string) ?? 'todo', (t.deadline as string) ?? null, (t.done_at as string) ?? null,
        (t.confirmed_at as string) ?? null, (t.telegram_message_id as string) ?? null,
        (t.priority as string) ?? 'medium', (t.depends_on_task_id as string) ?? null,
      ),
    );
  }
  for (const a of data.attachments ?? []) {
    stmts.push(
      db.prepare(
        'INSERT INTO attachments (id, task_id, telegram_file_id, telegram_message_id, filename, mime_type, size_bytes, uploaded_by) VALUES (?,?,?,?,?,?,?,?)',
      ).bind(a.id, a.task_id, a.telegram_file_id, a.telegram_message_id, a.filename, a.mime_type, a.size_bytes, a.uploaded_by),
    );
  }

  if (stmts.length) await db.batch(stmts);

  return {
    DB: db,
    ASSETS: {} as Fetcher,
    AUTH_API_URL: 'https://auth.example',
    AUTH_API_KEY: 'k',
    TELEGRAM_BOT_TOKEN: 't',
    TELEGRAM_STORAGE_CHAT_ID: '-100555',
    SESSION_SECRET: SECRET,
    MCP_API_TOKEN: 'mcp-token',
    MCP_USER_ID: 'mcp-user',
  };
}

export const cookie = async (id: string, role: string) => `session=${await mintSession(SECRET, { sub: id, role: role as never })}`;


// Ни один тест не должен ходить в Telegram. Заглушка отвечает так, как отвечает
// Bot API на sendMessage/sendDocument, и возвращает счётчик вызовов -- по нему
// проверяется, что уведомление вообще отправлялось.
export function stubTelegram(fileId = 'file-1') {
  return vi.spyOn(globalThis, 'fetch').mockImplementation(async (input) => {
    const url = String(input);
    if (url.includes('/sendDocument')) {
      return new Response(
        JSON.stringify({ ok: true, result: { message_id: 42, document: { file_id: fileId } } }),
        { status: 200 },
      );
    }
    return new Response(JSON.stringify({ ok: true, result: { message_id: 1 } }), { status: 200 });
  });
}
