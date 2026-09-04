// Remote MCP server: lets an AI assistant create/inspect Sayn tasks by name.
//
// Transport: the MCP SDK's own Web-Standard Streamable HTTP transport, run
// STATELESS (sessionIdGenerator undefined, JSON responses). It speaks fetch
// Request/Response, so it drops straight into this stateless Worker with no
// Durable Objects and no `agents` framework -- see the report for why McpAgent
// was not used.
//
// Every tool executes by internally invoking the SAME `apiRoutes` the UI uses,
// authenticated as MCP_USER_ID via a minted session cookie. So MCP-originated
// actions reuse all existing validation / access-control / audit-log (`events`)
// logic and are attributed to that real user, exactly like a UI action.
import { Hono } from 'hono';
import { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import { WebStandardStreamableHTTPServerTransport } from '@modelcontextprotocol/sdk/server/webStandardStreamableHttp.js';
import { z } from 'zod';
import type { CallToolResult } from '@modelcontextprotocol/sdk/types.js';
import type { Env, Role } from './types';
import { apiRoutes } from './routes';
import { mintSession, safeEqual, SESSION_COOKIE } from './auth';

const enc = new TextEncoder();

// Constant-time bearer check, reusing auth.ts's safeEqual (no `===` on secrets).
// Accepts the token via the Authorization header (preferred) OR a `?token=`
// query param -- some remote-MCP UIs (e.g. Claude's "Add custom connector"
// dialog) only offer a URL field with no way to set a custom header, so the
// query param is the only way to use this server from those clients.
function bearerOk(header: string | undefined, queryToken: string | undefined, secret: string): boolean {
  if (!secret) return false;
  const headerToken = header?.match(/^Bearer\s+(.+)$/)?.[1];
  if (headerToken && safeEqual(enc.encode(headerToken), enc.encode(secret))) return true;
  if (queryToken && safeEqual(enc.encode(queryToken), enc.encode(secret))) return true;
  return false;
}

// --- calling the real Sayn API, as MCP_USER_ID -----------------------------

// Mint a session cookie for the configured user using their REAL role from the
// DB (so visibility/access match what that user would see logging in).
async function mintUserCookie(env: Env, userId: string): Promise<string | null> {
  const user = await env.DB.prepare('SELECT id, role FROM users WHERE id = ?').bind(userId).first<{ id: string; role: Role }>();
  if (!user) return null;
  const token = await mintSession(env.SESSION_SECRET, { sub: user.id, role: user.role });
  return `${SESSION_COOKIE}=${token}`;
}

async function callApi(env: Env, cookie: string, path: string, init: RequestInit = {}): Promise<Response> {
  const headers = new Headers(init.headers);
  headers.set('Cookie', cookie);
  if (init.body) headers.set('Content-Type', 'application/json');
  return apiRoutes.request(path, { ...init, headers }, env);
}

// --- tool results ----------------------------------------------------------

type ToolOut = { text: string; isError?: boolean };
const ok = (text: string): ToolOut => ({ text });
const fail = (text: string): ToolOut => ({ text, isError: true });
const toResult = (o: ToolOut): CallToolResult => ({ content: [{ type: 'text', text: o.text }], isError: o.isError });

// Resolve MCP_USER_ID -> a session cookie, or a tool error if unconfigured.
async function authCookie(env: Env): Promise<{ cookie: string } | ToolOut> {
  if (!env.MCP_USER_ID) return fail('MCP_USER_ID is not configured on the server');
  const cookie = await mintUserCookie(env, env.MCP_USER_ID);
  return cookie ? { cookie } : fail(`MCP_USER_ID "${env.MCP_USER_ID}" is not a Sayn user`);
}

// --- name/id resolution ----------------------------------------------------

// Match `ref` against a list by exact id, else case-insensitive unique name.
// On miss/ambiguity, error out listing the real options so the caller can retry.
function resolveRef<T extends { id: string; name: string }>(rows: T[], ref: string, kind: string): T | ToolOut {
  ref = ref.trim();
  const byId = rows.find((r) => r.id === ref);
  if (byId) return byId;
  const matches = rows.filter((r) => r.name.toLowerCase() === ref.toLowerCase());
  if (matches.length === 1) return matches[0];
  const names = rows.map((r) => r.name).join(', ') || '(none)';
  if (matches.length === 0) return fail(`no ${kind} matches "${ref}". Available ${kind}s: ${names}`);
  return fail(`${kind} "${ref}" is ambiguous. Available ${kind}s: ${names}`);
}

async function fetchProjects(env: Env, cookie: string): Promise<{ id: string; name: string }[] | ToolOut> {
  const res = await callApi(env, cookie, '/projects');
  if (!res.ok) return fail(`could not list projects (${res.status})`);
  return (await res.json()) as { id: string; name: string }[];
}

async function fetchUsers(env: Env, cookie: string): Promise<{ id: string; name: string; role: Role }[] | ToolOut> {
  const res = await callApi(env, cookie, '/users');
  if (!res.ok) return fail(`could not list users (${res.status})`);
  return (await res.json()) as { id: string; name: string; role: Role }[];
}

// --- tool implementations --------------------------------------------------

async function listProjects(env: Env): Promise<ToolOut> {
  const auth = await authCookie(env);
  if ('text' in auth) return auth;
  const projects = await fetchProjects(env, auth.cookie);
  if ('text' in projects) return projects;
  return ok(JSON.stringify(projects.map((p) => ({ id: p.id, name: p.name }))));
}

async function listUsers(env: Env): Promise<ToolOut> {
  const auth = await authCookie(env);
  if ('text' in auth) return auth;
  const users = await fetchUsers(env, auth.cookie);
  if ('text' in users) return users;
  return ok(JSON.stringify(users));
}

async function listTasks(env: Env, projectRef: string): Promise<ToolOut> {
  const auth = await authCookie(env);
  if ('text' in auth) return auth;
  const projects = await fetchProjects(env, auth.cookie);
  if ('text' in projects) return projects;
  const project = resolveRef(projects, projectRef, 'project');
  if ('text' in project) return project;

  const res = await callApi(env, auth.cookie, `/projects/${project.id}/tasks`);
  if (!res.ok) return fail(`could not list tasks (${res.status})`);
  const tasks = (await res.json()) as { id: string; title: string; status: string; responsible_user_id: string; deadline: string | null }[];

  const users = await fetchUsers(env, auth.cookie);
  const nameById = new Map('text' in users ? [] : users.map((u) => [u.id, u.name] as const));
  return ok(
    JSON.stringify(
      tasks.map((t) => ({
        id: t.id,
        title: t.title,
        status: t.status,
        responsible: nameById.get(t.responsible_user_id) ?? t.responsible_user_id,
        deadline: t.deadline ?? null,
      })),
    ),
  );
}

async function createTask(
  env: Env,
  args: { project: string; title: string; description?: string; responsible: string; deadline?: string },
): Promise<ToolOut> {
  const auth = await authCookie(env);
  if ('text' in auth) return auth;

  const projects = await fetchProjects(env, auth.cookie);
  if ('text' in projects) return projects;
  const project = resolveRef(projects, args.project, 'project');
  if ('text' in project) return project;

  const users = await fetchUsers(env, auth.cookie);
  if ('text' in users) return users;
  const person = resolveRef(users, args.responsible, 'person');
  if ('text' in person) return person;

  const res = await callApi(env, auth.cookie, `/projects/${project.id}/tasks`, {
    method: 'POST',
    body: JSON.stringify({
      title: args.title,
      description: args.description ?? '',
      responsible_user_id: person.id,
      deadline: args.deadline,
    }),
  });
  if (!res.ok) return fail(`create task failed (${res.status}): ${await res.text()}`);
  const { id } = (await res.json()) as { id: string };
  return ok(
    `Created task "${args.title}" (id ${id}) in project "${project.name}", assigned to ${person.name}${args.deadline ? `, due ${args.deadline}` : ''}.`,
  );
}

// --- MCP server (built per request; stateless, so nothing is shared) --------

function buildServer(env: Env): McpServer {
  const server = new McpServer({ name: 'sayn', version: '1.0.0' });

  server.registerTool(
    'list_projects',
    { description: 'List the Sayn projects visible to the configured user. No params. Returns [{id, name}].', inputSchema: {} },
    async () => toResult(await listProjects(env)),
  );

  server.registerTool(
    'list_users',
    { description: 'List people in Sayn so you can pick who a task responsible person should be. No params. Returns [{id, name, role}].', inputSchema: {} },
    async () => toResult(await listUsers(env)),
  );

  server.registerTool(
    'list_tasks',
    {
      description: 'List current tasks on a project board (to avoid duplicates / check board state before adding). Returns [{id, title, status, responsible, deadline}].',
      inputSchema: { project: z.string().describe('project name (case-insensitive) or id') },
    },
    async ({ project }) => toResult(await listTasks(env, project)),
  );

  server.registerTool(
    'create_task',
    {
      description: 'Create a task on a Sayn project board. Resolves project and responsible by name (case-insensitive) or id; errors listing the real options if not found or ambiguous.',
      inputSchema: {
        project: z.string().describe('project name (case-insensitive) or id'),
        title: z.string().describe('task title'),
        description: z.string().optional().describe('optional task description'),
        responsible: z.string().describe('responsible person: name (case-insensitive) or id'),
        deadline: z.string().optional().describe('optional deadline as an ISO date, e.g. 2026-08-01'),
      },
    },
    async (args) => toResult(await createTask(env, args)),
  );

  return server;
}

// --- HTTP surface: bearer gate + stateless Streamable HTTP ------------------

export const mcpApp = new Hono<{ Bindings: Env }>();

mcpApp.all('/', async (c) => {
  if (!bearerOk(c.req.header('Authorization'), c.req.query('token'), c.env.MCP_API_TOKEN)) {
    return c.json({ error: 'unauthorized' }, 401);
  }
  const server = buildServer(c.env);
  const transport = new WebStandardStreamableHTTPServerTransport({
    sessionIdGenerator: undefined, // stateless: no session store, no Durable Object
    enableJsonResponse: true, // plain JSON request/response (no SSE) -- fits this Worker
  });
  await server.connect(transport);
  return transport.handleRequest(c.req.raw);
});
