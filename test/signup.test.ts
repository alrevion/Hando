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
import { deleteOrg, leaveOrg, myOrgs, renameOrg, switchOrg } from '../src/menu';
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

describe('регистрация целиком через бота -- КНОПКАМИ', () => {
  const press = (env: Env, tgId: number, data: string, messageId = 1) =>
    hook(env, { callback_query: { id: `cb-${data}`, from: { id: tgId, first_name: `Ч${tgId}` }, data, message: { chat: { id: tgId }, message_id: messageId } } });

  it('директор создаёт, сотрудник вступает, директор подтверждает', async () => {
    const env = await blank();
    const spy = tg();

    // /start -- единственная команда, которую человек печатает. Дальше кнопки.
    await hook(env, msg(101, '/start'));
    const first = sent(spy).at(-1)!;
    const labels = ((first as unknown as { reply_markup?: { inline_keyboard: { text: string }[][] } }).reply_markup?.inline_keyboard ?? []).flat().map((b) => b.text).join(' ');
    expect(labels).toContain('Создать организацию');

    // Нажали «Создать» -- бот спрашивает название, и только его человек печатает.
    await press(env, 101, 'm:new');
    await hook(env, msg(101, 'Школа №7'));
    const code = sent(spy).map((m) => m.text).join(' ').match(/[A-Z2-9]{6}/)![0];

    // Сотрудник: /start -> кнопка «Вступить» -> код.
    await hook(env, msg(202, '/start'));
    await press(env, 202, 'm:join');
    await hook(env, msg(202, code));

    const request = sent(spy).find((m) => m.chat_id === '101' && m.text.includes('просится'));
    expect(request?.reply_markup).toBeDefined();

    // До подтверждения сотрудник ничего не видит.
    const joiner = await testEnv.DB.prepare("SELECT id FROM users WHERE telegram_user_id = '202'").first<{ id: string }>();
    expect(await resolveOrgId(testEnv.DB, joiner!.id)).toBeNull();

    const org = await testEnv.DB.prepare('SELECT id FROM orgs WHERE join_code = ?').bind(code).first<{ id: string }>();
    await press(env, 101, `join_ok:${org!.id}:${joiner!.id}`);

    expect(await resolveOrgId(testEnv.DB, joiner!.id)).toBe(org!.id);
    expect(sent(spy).some((m) => m.chat_id === '202' && m.text.includes('приняли'))).toBe(true);
  });

  it('переключение, переименование и удаление -- кнопками', async () => {
    const env = await blank();
    tg();
    await hook(env, msg(303, '/start'));
    await press(env, 303, 'm:new');
    await hook(env, msg(303, 'Первая'));
    await press(env, 303, 'm:new');
    await hook(env, msg(303, 'Вторая'));

    const me = await testEnv.DB.prepare("SELECT id FROM users WHERE telegram_user_id = '303'").first<{ id: string }>();
    const first = await testEnv.DB.prepare("SELECT id FROM orgs WHERE name = 'Первая'").first<{ id: string }>();

    // Переключение: липкий контекст меняется.
    await press(env, 303, `m:sw:${first!.id}`);
    expect(await resolveOrgId(testEnv.DB, me!.id)).toBe(first!.id);

    // Переименование: кнопка ставит ожидание, следующее сообщение его закрывает.
    await press(env, 303, `m:ren:${first!.id}`);
    await hook(env, msg(303, 'Школа №1'));
    expect((await testEnv.DB.prepare('SELECT name FROM orgs WHERE id = ?').bind(first!.id).first<{ name: string }>())!.name).toBe('Школа №1');

    // Удаление -- через подтверждение, и МЯГКОЕ: строки остаются.
    await press(env, 303, `m:del:${first!.id}`);
    await press(env, 303, `m:delok:${first!.id}`);
    const org = await testEnv.DB.prepare('SELECT archived_at FROM orgs WHERE id = ?').bind(first!.id).first<{ archived_at: string | null }>();
    expect(org!.archived_at).not.toBeNull();
    // Человека не выбросило в никуда: контекст переехал на вторую организацию.
    const second = await testEnv.DB.prepare("SELECT id FROM orgs WHERE name = 'Вторая'").first<{ id: string }>();
    expect(await resolveOrgId(testEnv.DB, me!.id)).toBe(second!.id);
  });

  it('чужую организацию не переименовать и не удалить', async () => {
    const env = await blank();
    tg();
    await hook(env, msg(404, '/start'));
    await press(env, 404, 'm:new');
    await hook(env, msg(404, 'Чужая фирма'));
    const org = await testEnv.DB.prepare("SELECT id FROM orgs WHERE name = 'Чужая фирма'").first<{ id: string }>();

    // Посторонний знает id и жмёт кнопку переименования: сообщение с кнопкой
    // живёт в Telegram и может быть переслано.
    await hook(env, msg(505, '/start'));
    await press(env, 505, `m:ren:${org!.id}`);
    await hook(env, msg(505, 'Моя теперь'));
    expect((await testEnv.DB.prepare('SELECT name FROM orgs WHERE id = ?').bind(org!.id).first<{ name: string }>())!.name).toBe('Чужая фирма');

    await press(env, 505, `m:delok:${org!.id}`);
    expect((await testEnv.DB.prepare('SELECT archived_at FROM orgs WHERE id = ?').bind(org!.id).first<{ archived_at: string | null }>())!.archived_at).toBeNull();
  });
});


describe('права на организацию проверяются В САМИХ функциях', () => {
  // Меню отсекает чужую организацию раньше -- оно показывает только свои. Но
  // функции экспортируемые, и их однажды позовут из другого места: проверка
  // внутри них не избыточна, а последний рубеж. Тестируется она на своём уровне,
  // иначе мутация «убрать проверку» проходит незамеченной.
  const two = async () => {
    const env = await blank();
    const owner = await ensureUser(env, 'tg-own', 'Владелец', null);
    const { orgId } = await createOrg(env, owner, 'Фирма');
    const stranger = await ensureUser(env, 'tg-str', 'Посторонний', null);
    return { env, owner, orgId, stranger };
  };

  it('посторонний не переименует', async () => {
    const { env, orgId, stranger } = await two();
    expect(await renameOrg(env, stranger, orgId, 'Моя теперь')).toBe(false);
    expect((await testEnv.DB.prepare('SELECT name FROM orgs WHERE id = ?').bind(orgId).first<{ name: string }>())!.name).toBe('Фирма');
  });

  it('посторонний не переключится в чужую организацию', async () => {
    const { env, orgId, stranger } = await two();
    expect(await switchOrg(env, stranger, orgId)).toBe(false);
    expect((await testEnv.DB.prepare('SELECT current_org_id FROM users WHERE id = ?').bind(stranger).first<{ current_org_id: string | null }>())!.current_org_id).toBeNull();
  });

  it('посторонний не удалит', async () => {
    const { env, orgId, stranger } = await two();
    expect(await deleteOrg(env, stranger, orgId)).toBe(false);
  });

  it('владелец не «выходит» из своей организации -- он её удаляет', async () => {
    const { env, owner, orgId } = await two();
    // Иначе организация осталась бы без владельца и без плательщика.
    expect(await leaveOrg(env, owner, orgId)).toBe(false);
  });

  it('сотрудник выходит сам, и организация пропадает из его списка', async () => {
    const env = await blank();
    const owner = await ensureUser(env, 'tg-o9', 'Владелец', null);
    const { orgId, code } = await createOrg(env, owner, 'Фирма');
    const worker = await ensureUser(env, 'tg-w9', 'Сотрудник', null);
    await joinByCode(env, worker, code);
    await approveJoin(env, owner, orgId, worker);
    expect((await myOrgs(env, worker)).map((o) => o.id)).toEqual([orgId]);

    expect(await leaveOrg(env, worker, orgId)).toBe(true);
    expect(await myOrgs(env, worker)).toEqual([]);
  });

  it('удалённая организация исчезает из списка, но строки остаются', async () => {
    const { env, owner, orgId } = await two();
    expect(await deleteOrg(env, owner, orgId)).toBe(true);
    expect(await myOrgs(env, owner)).toEqual([]);
    // Мягкое удаление: на организацию ссылаются задачи, события и вложения --
    // вся история работы. Убирается видимость, а не труд.
    const still = await testEnv.DB.prepare('SELECT archived_at FROM orgs WHERE id = ?').bind(orgId).first<{ archived_at: string | null }>();
    expect(still!.archived_at).not.toBeNull();
  });
});
