// Приёмка авторегистрации.
//
// Главное свойство, ради которого всё и сделано так: КОД САМ ПО СЕБЕ ДОСТУПА НЕ
// ДАЁТ. Его раздают в общем чате, значит он попадёт к посторонним -- и должен
// порождать только заявку, которую подтверждает владелец. Если бы код пускал
// сразу, подтверждение было бы декорацией.
import { env as testEnv } from 'cloudflare:test';
import { afterEach, describe, expect, it } from 'vitest';
import { botApp } from '../src/bot';
import { apiRoutes } from '../src/routes';
import { approveJoin, createOrg, ensureUser, generateJoinCode, joinByCode, rejectJoin } from '../src/signup';
import { membershipRole, resolveOrgId } from '../src/auth';
import { cookie, envWith, stubTelegram } from './fixture';
import type { Env } from '../src/types';

let restore: { mockRestore(): void } | null = null;
afterEach(() => { restore?.mockRestore(); restore = null; });
const tg = () => (restore = stubTelegram()) as ReturnType<typeof stubTelegram>;
const sent = (spy: ReturnType<typeof stubTelegram>) =>
  (spy.mock.calls as unknown as [string, { body?: string }][])
    .filter(([u]) => u.includes('/sendMessage'))
    .map(([, i]) => JSON.parse(String(i.body)) as { chat_id: string; text: string; reply_markup?: unknown });

const blank = () => envWith({ users: [], memberships: [], tasks: [] });
const hook = (env: Env, update: unknown) =>
  botApp.request('/webhook', {
    method: 'POST',
    headers: { 'x-telegram-bot-api-secret-token': 'tg-secret', 'Content-Type': 'application/json' },
    body: JSON.stringify(update),
  }, env);
const msg = (id: number, text: string) => ({ message: { chat: { id, type: 'private' }, from: { id, first_name: `Ч${id}` }, text } });

describe('код вступления', () => {
  it('без похожих начертаний: ни 0/O, ни 1/I/L', () => {
    // Код диктуют голосом и переписывают с экрана. «Нолик или буква О» стоит
    // дороже, чем лишний символ алфавита.
    for (let i = 0; i < 200; i++) {
      const code = generateJoinCode();
      expect(code).toHaveLength(6);
      expect(code).not.toMatch(/[0O1IL]/);
    }
    // И он всё-таки случайный, а не константа.
    expect(new Set(Array.from({ length: 50 }, generateJoinCode)).size).toBeGreaterThan(45);
  });
});

describe('создание своей организации', () => {
  it('создатель -- владелец и плательщик, доступ сразу', async () => {
    const env = await blank();
    const uid = await ensureUser(env, 'tg-1', 'Директор', 'dir');
    const { orgId, code } = await createOrg(env, uid, 'Школа №5');

    const org = await testEnv.DB.prepare('SELECT name, join_code, owner_user_id FROM orgs WHERE id = ?').bind(orgId).first<{ name: string; join_code: string; owner_user_id: string }>();
    expect(org).toMatchObject({ name: 'Школа №5', join_code: code, owner_user_id: uid });

    // Подтверждать себя не у кого, и это не дыра: в организации больше никого.
    expect(await membershipRole(testEnv.DB, orgId, uid)).toBe('creator');
    expect(await resolveOrgId(testEnv.DB, uid)).toBe(orgId);
  });

  it('телефон не спрашивается вовсе', async () => {
    const env = await blank();
    const uid = await ensureUser(env, 'tg-2', 'Сотрудник', null);
    const row = await testEnv.DB.prepare('SELECT phone FROM users WHERE id = ?').bind(uid).first<{ phone: string | null }>();
    // Ради этого phone и стал nullable на шаге 2b.
    expect(row!.phone).toBeNull();
  });
});

describe('вступление по коду НЕ даёт доступа до подтверждения', () => {
  const setup = async () => {
    const env = await blank();
    const owner = await ensureUser(env, 'tg-owner', 'Владелец', null);
    const { orgId, code } = await createOrg(env, owner, 'Кафе');
    const joiner = await ensureUser(env, 'tg-joiner', 'Новичок', null);
    return { env, owner, orgId, code, joiner };
  };

  it('заявка создана, но роли нет и организация не резолвится', async () => {
    const { env, orgId, code, joiner } = await setup();
    const res = await joinByCode(env, joiner, code);
    expect(res.ok).toBe(true);

    // Строка есть...
    const m = await testEnv.DB.prepare('SELECT role, confirmed_at FROM org_memberships WHERE org_id = ? AND user_id = ?').bind(orgId, joiner).first<{ role: string; confirmed_at: string | null }>();
    expect(m).toMatchObject({ role: 'member', confirmed_at: null });
    // ...но доступа она НЕ даёт. Это и есть смысл подтверждения.
    expect(await membershipRole(testEnv.DB, orgId, joiner)).toBeNull();
    expect(await resolveOrgId(testEnv.DB, joiner)).toBeNull();
  });

  it('до подтверждения API отвечает 401, после -- пускает', async () => {
    const { env, owner, orgId, code, joiner } = await setup();
    await joinByCode(env, joiner, code);

    const c = await cookie(joiner, 'member', orgId);
    expect((await apiRoutes.request('/projects', { headers: { Cookie: c } }, env)).status).toBe(401);

    expect(await approveJoin(env, owner, orgId, joiner)).toBe(true);
    expect((await apiRoutes.request('/projects', { headers: { Cookie: c } }, env)).status).toBe(200);
  });

  it('код регистрозависимым не является, пробелы не мешают', async () => {
    const { env, code, joiner } = await setup();
    expect((await joinByCode(env, joiner, `  ${code.toLowerCase()} `)).ok).toBe(true);
  });

  it('неизвестный код не подсказывает, какие организации есть', async () => {
    const { env, joiner } = await setup();
    const res = await joinByCode(env, joiner, 'ZZZZZZ');
    expect(res).toEqual({ ok: false, reason: 'unknown_code' });
  });

  it('повторная заявка не плодит строк', async () => {
    const { env, orgId, code, joiner } = await setup();
    await joinByCode(env, joiner, code);
    expect(await joinByCode(env, joiner, code)).toEqual({ ok: false, reason: 'already_pending' });
    const { n } = (await testEnv.DB.prepare('SELECT COUNT(*) AS n FROM org_memberships WHERE org_id = ? AND user_id = ?').bind(orgId, joiner).first<{ n: number }>())!;
    expect(n).toBe(1);
  });
});

describe('подтверждает только владелец', () => {
  it('посторонний с кнопкой не подтверждает: её можно переслать', async () => {
    const env = await blank();
    const owner = await ensureUser(env, 'tg-o', 'Владелец', null);
    const { orgId, code } = await createOrg(env, owner, 'Кафе');
    const joiner = await ensureUser(env, 'tg-j', 'Новичок', null);
    await joinByCode(env, joiner, code);

    // Чужак вообще не в этой организации.
    const stranger = await ensureUser(env, 'tg-s', 'Посторонний', null);
    expect(await approveJoin(env, stranger, orgId, joiner)).toBe(false);
    expect(await membershipRole(testEnv.DB, orgId, joiner)).toBeNull();

    // Рядовой сотрудник этой же организации -- тоже нет.
    await approveJoin(env, owner, orgId, joiner);
    const plain = await ensureUser(env, 'tg-p', 'Рядовой', null);
    await joinByCode(env, plain, code);
    await approveJoin(env, owner, orgId, plain);
    const another = await ensureUser(env, 'tg-a', 'Ещё один', null);
    await joinByCode(env, another, code);
    expect(await approveJoin(env, plain, orgId, another)).toBe(false);
  });

  it('отклонение удаляет заявку, и человек может подать её снова', async () => {
    const env = await blank();
    const owner = await ensureUser(env, 'tg-o2', 'Владелец', null);
    const { orgId, code } = await createOrg(env, owner, 'Кафе');
    const joiner = await ensureUser(env, 'tg-j2', 'Новичок', null);
    await joinByCode(env, joiner, code);

    expect(await rejectJoin(env, owner, orgId, joiner)).toBe(true);
    const { n } = (await testEnv.DB.prepare('SELECT COUNT(*) AS n FROM org_memberships WHERE org_id = ? AND user_id = ?').bind(orgId, joiner).first<{ n: number }>())!;
    expect(n).toBe(0);
    expect((await joinByCode(env, joiner, code)).ok).toBe(true);
  });

  it('подтверждение НЕ перебрасывает человека из его текущей организации', async () => {
    const env = await blank();
    const me = await ensureUser(env, 'tg-me', 'Я', null);
    const { orgId: mine } = await createOrg(env, me, 'Моя фирма');

    const owner = await ensureUser(env, 'tg-o3', 'Чужой владелец', null);
    const { orgId: theirs, code } = await createOrg(env, owner, 'Их фирма');
    await joinByCode(env, me, code);
    await approveJoin(env, owner, theirs, me);

    // Липкий контекст остаётся на моей организации: подтверждение четвёртой не
    // должно перебрасывать человека туда без спроса.
    expect(await resolveOrgId(testEnv.DB, me)).toBe(mine);
    // Но членство в их фирме действует.
    expect(await membershipRole(testEnv.DB, theirs, me)).toBe('member');
  });
});

describe('регистрация целиком через бота', () => {
  it('директор создаёт, сотрудник вступает, директор подтверждает', async () => {
    const env = await blank();
    const spy = tg();

    await hook(env, msg(101, '/создать Школа №7'));
    const code = sent(spy).map((m) => m.text).join(' ').match(/[A-Z2-9]{6}/)![0];

    await hook(env, msg(202, `/вступить ${code}`));
    const afterJoin = sent(spy);
    // Владельцу пришла заявка с кнопками -- это единственный путь подтверждения.
    const request = afterJoin.find((m) => m.chat_id === '101' && m.text.includes('просится'));
    expect(request?.reply_markup).toBeDefined();

    // До подтверждения сотрудник ничего не видит.
    const before = await testEnv.DB.prepare("SELECT id FROM users WHERE telegram_user_id = '202'").first<{ id: string }>();
    expect(await resolveOrgId(testEnv.DB, before!.id)).toBeNull();

    const org = await testEnv.DB.prepare("SELECT id FROM orgs WHERE join_code = ?").bind(code).first<{ id: string }>();
    await hook(env, { callback_query: { id: 'cb1', from: { id: 101 }, data: `join_ok:${org!.id}:${before!.id}`, message: { chat: { id: 101 }, message_id: 5 } } });

    expect(await resolveOrgId(testEnv.DB, before!.id)).toBe(org!.id);
    // И сотруднику сказали, что его приняли.
    expect(sent(spy).some((m) => m.chat_id === '202' && m.text.includes('приняли'))).toBe(true);
  });
});
