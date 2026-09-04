// ИСКЛЮЧЕНИЕ из правила шага -1 «ни один тест не идёт против подделки D1».
//
// Этот файл — единственный, который не может выполняться в workerd:
// src/index -> src/mcp -> @modelcontextprotocol/sdk -> ajv, а ajv грузит
// ./refs/data.json как модуль, чего workerd не умеет. Поэтому он идёт в
// node-пуле (vitest.node.config.ts) и сохраняет собственную мини-подделку базы.
//
// Что это стоит, названо честно: тест «create_task пишет задачу» доказывает,
// что MCP дёргает тот же роут с минченной сессией и атрибутирует событие на
// MCP_USER_ID, но НЕ доказывает, что запись доходит до настоящей таблицы.
// Контроль доступа и схема покрыты access.test.ts и schema.test.ts против
// настоящей D1; здесь проверяется плумбинг MCP, а не база.
// Locks down the two things that actually matter for the MCP surface: the bearer
// gate on /mcp, and that a create_task tool call reaches the REAL apiRoutes and
// writes a task attributed to MCP_USER_ID (not a stub). Drives the real Worker
// (src/index) end-to-end against a tiny in-memory D1 fake -- no Workers pool,
// matching test/access.test.ts.
import { describe, expect, it, vi } from 'vitest';
import worker from '../src/index';
import type { Env } from '../src/types';

const TOKEN = 'test-mcp-token';
const OWNER = 'u_owner'; // MCP_USER_ID (a creator)

type FakeData = {
  users: Array<{ id: string; phone: string; name: string; role: string }>;
  projects: Array<{ id: string; name: string; archived_at: string | null }>;
  tasks: Array<Record<string, unknown>>;
  events: Array<Record<string, unknown>>;
};

// Dispatches the queries the MCP path issues (session mint, /projects, /users,
// task INSERT, event INSERT) by SQL shape; records writes so they're assertable.
function fakeDB(data: FakeData): Env['DB'] {
  const prepare = (sql: string) => {
    let args: unknown[] = [];
    const api = {
      bind(...a: unknown[]) {
        args = a;
        return api;
      },
      async first<T = Record<string, unknown>>(): Promise<T | null> {
        // Организационные запросы: подделка отвечает так, будто все люди состоят
        // в 'org-a'. Замок арендатора здесь НЕ проверяется -- он вынесен в
        // auth.mcpSessionClaims и проверяется против настоящей D1 в
        // test/step2a.test.ts. Здесь нужно ровно одно: чтобы MCP-путь дошёл до
        // API и записал задачу.
        if (/current_org_id FROM users/.test(sql)) return ({ current_org_id: 'org-a' } as T);
        // requireProjectAccess с шага 2a грузит проект ДО проверки роли, поэтому
        // байпас creator больше не проскакивает мимо базы.
        if (/FROM projects WHERE id/.test(sql)) {
          const p = data.projects.find((x) => x.id === args[0]);
          return p ? ({ created_by: OWNER, telegram_chat_id: '-100' } as T) : null;
        }
        if (/FROM org_memberships/.test(sql)) return ({ role: data.users.find((u) => u.id === args[1])?.role ?? 'admin' } as T);
        if (/FROM users WHERE id/.test(sql)) return (data.users.find((u) => u.id === args[0]) as T) ?? null;
        return null;
      },
      async all<T = Record<string, unknown>>(): Promise<{ results: T[] }> {
        // Порядок важен: запрос GET /users -- это `FROM users u JOIN
        // org_memberships`, поэтому проверка на org_memberships обязана быть
        // УЖЕ (по началу оператора), иначе справочник людей вернёт членства.
        if (/^SELECT org_id FROM org_memberships/.test(sql.trim())) return { results: [{ org_id: 'org-a' }] as T[] };
        if (/FROM projects/.test(sql)) return { results: data.projects.filter((p) => p.archived_at === null) as T[] };
        if (/FROM users/.test(sql)) return { results: data.users.map((u) => ({ id: u.id, name: u.name, role: u.role })) as T[] };
        if (/FROM tasks WHERE project_id/.test(sql)) return { results: data.tasks.filter((t) => t.project_id === args[0]) as T[] };
        return { results: [] as T[] };
      },
      async run() {
        // Позиции бинда, а не имена колонок: подделка разбирает SQL текстом.
        // На шаге 2a обе вставки получили org_id вторым аргументом -- и этот
        // разбор пришлось править вслед. Это цена подделки, а не особенность
        // кода: настоящая D1 связывает по именам колонок и не заметила бы.
        if (/INSERT INTO tasks/.test(sql)) {
          const [id, org_id, project_id, title, description, responsible_user_id, deadline] = args;
          data.tasks.push({ id, org_id, project_id, title, description, responsible_user_id, status: 'todo', deadline });
        } else if (/INSERT INTO events/.test(sql)) {
          const [id, actor_id, org_id, target_type, target_id, action] = args;
          data.events.push({ id, actor_id, org_id, target_type, target_id, action });
        }
        return { success: true, meta: { changes: 1 } };
      },
    };
    return api;
  };
  // batch выполняет операторы по порядку. Это НЕ модель атомарности -- откатить
  // подделка не умеет, и знать об этом надо. Здесь этого достаточно: файл
  // проверяет bearer-гейт и атрибуцию MCP, а не поведение D1. Настоящая база --
  // в workers-пуле; mcp.test.ts живёт в node-пуле из-за ajv (см. конфиги).
  const batch = async (stmts: { run(): Promise<unknown> }[]) => {
    const out = [];
    for (const st of stmts) out.push(await st.run());
    return out;
  };
  return { prepare, batch } as unknown as Env['DB'];
}

function envWith(data: FakeData): Env {
  return {
    DB: fakeDB(data),
    ASSETS: {} as Fetcher,
    AUTH_API_URL: 'https://auth.example',
    AUTH_API_KEY: 'k',
    TELEGRAM_BOT_TOKEN: 't',
    TELEGRAM_STORAGE_CHAT_ID: '-100storage',
    SESSION_SECRET: 'test-secret',
    MCP_API_TOKEN: TOKEN,
    MCP_USER_ID: OWNER,
    MCP_ORG_ID: 'org-a',
  };
}

const ctx = { waitUntil() {}, passThroughOnException() {} } as unknown as ExecutionContext;

function mcpRequest(body: unknown, auth?: string): Request {
  const headers: Record<string, string> = {
    'Content-Type': 'application/json',
    Accept: 'application/json, text/event-stream', // required by Streamable HTTP POST
  };
  if (auth) headers.Authorization = auth;
  return new Request('https://sayn.example/mcp', { method: 'POST', headers, body: JSON.stringify(body) });
}

const seed = (): FakeData => ({
  users: [
    { id: OWNER, phone: '+1', name: 'Owner', role: 'creator' },
    { id: 'u_bob', phone: '+2', name: 'Bob', role: 'admin' },
  ],
  projects: [{ id: 'p1', name: 'Alpha', archived_at: null }],
  tasks: [],
  events: [],
});

const callTool = (name: string, args: Record<string, unknown>) => ({
  jsonrpc: '2.0',
  id: 1,
  method: 'tools/call',
  params: { name, arguments: args },
});

describe('mcp /mcp endpoint', () => {
  it('rejects a request with no bearer token (401)', async () => {
    const res = await worker.fetch(mcpRequest(callTool('list_projects', {})), envWith(seed()), ctx);
    expect(res.status).toBe(401);
  });

  it('rejects a request with the wrong bearer token (401)', async () => {
    const res = await worker.fetch(mcpRequest(callTool('list_projects', {}), 'Bearer wrong'), envWith(seed()), ctx);
    expect(res.status).toBe(401);
  });

  it('create_task (correct token) writes a real task attributed to MCP_USER_ID', async () => {
    const data = seed();
    // create_task reaches the real POST /projects/:id/tasks handler, which now
    // also notifies Telegram -- stub fetch so that doesn't hit the real network.
    const fetchSpy = vi.spyOn(globalThis, 'fetch').mockResolvedValue(
      new Response(JSON.stringify({ result: { message_id: 1 } }), { status: 200 }),
    );
    // project + responsible given by name (case-insensitive) -- exercises fuzzy resolve.
    const res = await worker.fetch(
      mcpRequest(callTool('create_task', { project: 'alpha', title: 'Ship the thing', responsible: 'bob' }), `Bearer ${TOKEN}`),
      envWith(data),
      ctx,
    );
    fetchSpy.mockRestore();
    expect(res.status).toBe(200);

    const rpc = (await res.json()) as { result?: { content: { text: string }[]; isError?: boolean } };
    expect(rpc.result?.isError).toBeFalsy();
    expect(rpc.result?.content[0].text).toContain('Created task');

    // Reached real business logic: a todo task exists, assigned to Bob...
    expect(data.tasks).toHaveLength(1);
    expect(data.tasks[0]).toMatchObject({ title: 'Ship the thing', responsible_user_id: 'u_bob', status: 'todo' });
    // ...and the audit event is attributed to the configured MCP user.
    const created = data.events.find((e) => e.target_type === 'task' && e.action === 'created');
    expect(created?.actor_id).toBe(OWNER);
  });
});
