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

// Организация по умолчанию. Тесты, которым мультитенантность не интересна,
// живут целиком в ней и про org не знают вовсе.
export const ORG_A = 'org-a';
export const ORG_B = 'org-b';

type FakeData = {
  // orgs у пользователя -- список организаций, в которых он состоит. По
  // умолчанию только ORG_A. Пользователь с ['org-a','org-b'] -- та самая
  // фикстура двойного членства, без которой тест изоляции обесценен: код вида
  // EXISTS(... WHERE user_id = ?) без AND org_id = ? проходит старую фикстуру
  // зелёным, потому что там человек принадлежал ровно одной организации.
  users: Array<{ id: string; phone: string; name: string; role: string; telegram_username?: string; telegram_user_id?: string | null; orgs?: string[] }>;
  memberships: Array<{ project_id: string; user_id: string; org_id?: string }>;
  tasks: Array<Record<string, unknown>>;
  projects?: Array<{ id: string; telegram_chat_id: string; created_by?: string; archived_at?: string; org_id?: string }>;
  attachments?: Array<{ id: string; task_id: string; uploaded_by: string; telegram_message_id: string; telegram_file_id: string; filename: string; mime_type: string; size_bytes: number; org_id?: string }>;
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

  // Обе организации заводятся всегда: тест изоляции обязан иметь куда целиться,
  // а лишняя пустая организация ничему не мешает. org-pilot уже создан
  // миграцией 0010 -- поэтому здесь только a и b.
  for (const org of [ORG_A, ORG_B]) {
    // quiet_hours = 0: иначе набор зависел бы от того, в какое время суток его
    // запустили -- прогон в 22:30 по Ташкенту не отправлял бы ничего. Саму
    // тишину проверяет step4.test.ts на фиксированных моментах времени.
    stmts.push(db.prepare('INSERT INTO orgs (id, name, quiet_hours) VALUES (?,?,0)').bind(org, org));
  }

  for (const u of data.users) {
    const orgs = u.orgs ?? [ORG_A];
    stmts.push(
      // current_org_id -- первая из перечисленных: у человека с двумя членствами
      // без него resolveOrgId вернул бы null и он бы просто не вошёл.
      // users.role снята пересборкой 2b: роль живёт в членстве.
      // telegram_user_id проставлен по умолчанию: с шага 4a уведомления уходят
      // В ЛИЧКУ (ADR-4), и человек без подключённого бота ничего не получает --
      // сообщение честно ждёт в очереди. Тестам нужен подключённый человек,
      // поэтому id выводится из его собственного. Кому нужен НЕподключённый --
      // передаёт telegram_user_id: null явно.
      db.prepare("INSERT INTO users (id, phone, name, telegram_username, telegram_user_id, current_org_id, onboarded_at) VALUES (?,?,?,?,?,?,datetime('now'))")
        .bind(u.id, u.phone, u.name, u.telegram_username ?? null,
          u.telegram_user_id === undefined ? `tg-${u.id}` : u.telegram_user_id, orgs[0]),
    );
    for (const org of orgs) {
      stmts.push(
        // confirmed_at проставлен: это ДЕЙСТВУЮЩИЙ сотрудник, а не заявка на
        // вступление. Заявки заводятся тестами регистрации явно, с NULL.
        db.prepare("INSERT INTO org_memberships (id, org_id, user_id, role, confirmed_at) VALUES (?,?,?,?,datetime('now'))")
          .bind(`${org}:${u.id}`, org, u.id, u.role),
      );
    }
  }

  // Проекты: явные из фикстуры плюс те, на которые ссылаются задачи и членства.
  const projects = new Map<string, { id: string; chat: string; by: string; archived: string | null; org: string }>();
  for (const p of data.projects ?? []) projects.set(p.id, { id: p.id, chat: p.telegram_chat_id, by: p.created_by ?? '__seed', archived: p.archived_at ?? null, org: p.org_id ?? ORG_A });
  for (const t of data.tasks) {
    const pid = t.project_id as string | undefined;
    if (pid && !projects.has(pid)) projects.set(pid, { id: pid, chat: '-100000', by: '__seed', archived: null, org: (t.org_id as string) ?? ORG_A });
  }
  for (const m of data.memberships) {
    if (!projects.has(m.project_id)) projects.set(m.project_id, { id: m.project_id, chat: '-100000', by: '__seed', archived: null, org: m.org_id ?? ORG_A });
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
    // Досозданный человек получает членство в ORG_A: иначе строка, на которую
    // ссылается задача, принадлежала бы никому и org-предикаты вели бы себя
    // непредсказуемо.
    stmts.push(db.prepare("INSERT INTO users (id, phone, name, telegram_user_id, current_org_id, onboarded_at) VALUES (?,?,?,?,?,datetime('now'))").bind(id, `+00${phone++}`, id, `tg-${id}`, ORG_A));
    stmts.push(db.prepare("INSERT INTO org_memberships (id, org_id, user_id, role, confirmed_at) VALUES (?,?,?,?,datetime('now'))").bind(`${ORG_A}:${id}`, ORG_A, id, 'admin'));
  }
  for (const p of projects.values()) {
    stmts.push(db.prepare('INSERT INTO projects (id, org_id, name, created_by, telegram_chat_id, archived_at) VALUES (?,?,?,?,?,?)').bind(p.id, p.org, p.id, p.by, p.chat, p.archived));
  }
  for (const m of data.memberships) {
    const org = m.org_id ?? projects.get(m.project_id)?.org ?? ORG_A;
    stmts.push(db.prepare('INSERT INTO project_memberships (id, project_id, user_id, org_id) VALUES (?,?,?,?)').bind(`${m.project_id}:${m.user_id}`, m.project_id, m.user_id, org));
  }
  for (const t of data.tasks) {
    const resp = (t.responsible_user_id as string) ?? '__seed';
    stmts.push(
      db.prepare(
        // responsible_user_id снят contract-релизом: «кто делает» -- строка
        // адресата, которая заводится ниже. Фикстура по-прежнему принимает
        // responsible_user_id: это удобный способ сказать «один адресат».
        // author_id: гейт confirm/reject -- авторство, а не роль. По умолчанию
        // автор = адресат, чтобы задача была подтверждаемой.
        `INSERT INTO tasks (id, org_id, project_id, title, description, author_id, kind, status, deadline, done_at, confirmed_at, telegram_message_id, priority, depends_on_task_id)
         VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?,?)`,
      ).bind(
        t.id, (t.org_id as string) ?? projects.get(t.project_id as string)?.org ?? ORG_A,
        t.project_id, (t.title as string) ?? 'T', (t.description as string) ?? '',
        (t.author_id as string) ?? resp, (t.kind as string) ?? 'single',
        (t.status as string) ?? 'todo', (t.deadline as string) ?? null, (t.done_at as string) ?? null,
        (t.confirmed_at as string) ?? null, (t.telegram_message_id as string) ?? null,
        (t.priority as string) ?? 'medium', (t.depends_on_task_id as string) ?? null,
      ),
    );
  }
  for (const a of data.attachments ?? []) {
    stmts.push(
      db.prepare(
        'INSERT INTO attachments (id, org_id, task_id, telegram_file_id, telegram_message_id, filename, mime_type, size_bytes, uploaded_by) VALUES (?,?,?,?,?,?,?,?,?)',
      ).bind(a.id, a.org_id ?? ORG_A, a.task_id, a.telegram_file_id, a.telegram_message_id, a.filename, a.mime_type, a.size_bytes, a.uploaded_by),
    );
  }

  // Строка адресата на каждую задачу: с шага 3 «кто делает» живёт в
  // task_assignees, и без неё move/decline/confirm упрутся в «ты не адресат».
  // Состояние выводится из статуса задачи -- ровно как в бэкфилле миграции 0012,
  // иначе фикстура и прод разошлись бы в смысле одних и тех же данных.
  for (const t of data.tasks) {
    const st = (t.status as string) ?? 'todo';
    const state = t.confirmed_at ? 'confirmed'
      : st === 'done' ? 'done'
      : st === 'in_progress' ? 'accepted'
      : st === 'archived' && t.done_at ? 'done'
      : 'pending';
    stmts.push(
      db.prepare(
        'INSERT INTO task_assignees (id, task_id, user_id, org_id, state, done_at, due_at) VALUES (?,?,?,?,?,?,?)',
      ).bind(
        `as-${t.id}`, t.id, (t.responsible_user_id as string) ?? '__seed',
        (t.org_id as string) ?? projects.get(t.project_id as string)?.org ?? ORG_A,
        state, (t.done_at as string) ?? null, (t.deadline as string) ?? null,
      ),
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
    MCP_ORG_ID: ORG_A,
    TELEGRAM_WEBHOOK_SECRET: 'tg-secret',
    // Пустой ключ намеренно: тесты разбора не должны ходить в сеть. Пустой
    // означает «только паттерны», а не падение -- см. parseTask.
    GROQ_API_KEY: '',
    GROQ_STT_MODEL: 'whisper-large-v3-turbo',
    GROQ_LLM_MODEL: 'openai/gpt-oss-120b',
  };
}

// orgId по умолчанию ORG_A. Тест изоляции выдаёт токен ORG_A и целится в
// идентификаторы ORG_B -- в том числе от лица человека, состоящего в обеих.
export const cookie = async (id: string, role: string, orgId: string = ORG_A) =>
  `session=${await mintSession(SECRET, { sub: id, role: role as never, org_id: orgId })}`;


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
