// Приёмка отраслевых профилей.
//
// Профиль обязан менять ТРИ вещи, иначе он декоративный ярлык: набор отделов,
// понимание срочности и понимание «ознакомиться». Проверяется каждая.
import { env as testEnv } from 'cloudflare:test';
import { describe, expect, it } from 'vitest';
import { CATEGORIES, PACKS, pack, packButton, packByButton, packsOf } from '../src/packs';
import { matchPriority, parseByPattern } from '../src/parse';
import { approveJoin, createOrg, ensureUser, joinByCode, orgDepartments } from '../src/signup';
import { membershipRole } from '../src/auth';
import { envWith } from './fixture';

const TZ = 'Asia/Tashkent';
const NOW = new Date('2026-09-07T05:00:00.000Z');
const PEOPLE = [{ id: 'u-aziz', name: 'Азиз Каримов' }];
const blank = () => envWith({ users: [], memberships: [], tasks: [] });

describe('справочник профилей', () => {
  it('идентификаторы и подписи кнопок уникальны', () => {
    // Подпись reply-кнопки -- это протокол: две одинаковые сделали бы выбор
    // неразличимым, а бот молча заводил бы не ту отрасль.
    expect(new Set(PACKS.map((p) => p.id)).size).toBe(PACKS.length);
    expect(new Set(PACKS.map(packButton)).size).toBe(PACKS.length);
  });

  it('у каждого профиля есть отделы, должности и примеры', () => {
    for (const p of PACKS) {
      expect(p.departments.length, p.id).toBeGreaterThan(0);
      expect(p.positions.length, p.id).toBeGreaterThan(0);
      expect(p.examples.length, p.id).toBeGreaterThan(0);
    }
  });

  it('кнопка и разбор нажатия сходятся', () => {
    for (const p of PACKS) expect(packByButton(packButton(p))?.id).toBe(p.id);
  });

  it('неизвестный профиль -- «Другое», а не падение', () => {
    // Организации, созданные до профилей, несут generic; выдумывать им отрасль
    // нельзя, а ронять запрос из-за незнакомой строки -- тем более.
    expect(pack('нет такого').id).toBe('generic');
    expect(pack(null).id).toBe('generic');
  });
});

describe('слова срочности зависят от отрасли', () => {
  it('«простой» горит на стройке и молчит в школе', () => {
    // На стройке простой -- это стоящая техника и уходящие деньги. В школе
    // такого слова нет вовсе, и придумывать ему смысл нельзя.
    expect(matchPriority('на объекте простой, нужно решить', 'construction').priority).toBe('urgent');
    expect(matchPriority('на объекте простой, нужно решить', 'school').priority).toBe('medium');
  });

  it('«линия стоит» -- в цеху, «пациент ждёт» -- в клинике', () => {
    expect(matchPriority('линия стоит', 'manufacturing').priority).toBe('urgent');
    expect(matchPriority('пациент ждёт в коридоре', 'clinic').priority).toBe('urgent');
    expect(matchPriority('пациент ждёт в коридоре', 'manufacturing').priority).toBe('medium');
  });

  it('отраслевое понижение не проигрывает базовому повышению', () => {
    // «На выходных» сказано про срок, «горит» -- случайное слово рядом.
    // Понижение проверяется первым, иначе всё несрочное стало бы срочным.
    expect(matchPriority('на выходных разобрать кладовку', 'family').priority).toBe('low');
  });

  it('базовый словарь работает при любом профиле', () => {
    for (const id of ['generic', 'school', 'construction']) {
      expect(matchPriority('срочно позвонить', id).priority, id).toBe('urgent');
      expect(matchPriority('не срочно позвонить', id).priority, id).toBe('low');
    }
  });

  it('вычеркнутое слово не оставляет за собой предлог', () => {
    // «подготовить кабинет к проверке» -> «проверке» уехало в срочность, и
    // без чистки оставалось «Подготовить кабинет к».
    const d = parseByPattern('Азизу подготовить кабинет к проверке', PEOPLE, 'u-self', NOW, TZ, 'school')!;
    expect(d.priority).toBe('urgent');
    expect(d.title).toBe('Подготовить кабинет');
  });

  it('предлог внутри фразы не трогается', () => {
    const d = parseByPattern('Азизу срочно позвонить в банк', PEOPLE, 'u-self', NOW, TZ, 'generic')!;
    expect(d.title).toBe('Позвонить в банк');
  });

  it('отраслевое слово не остаётся в названии задачи', () => {
    const d = parseByPattern('Азизу простой на объекте устранить', PEOPLE, 'u-self', NOW, TZ, 'construction')!;
    expect(d.priority).toBe('urgent');
    expect(d.title.toLowerCase()).not.toContain('простой');
  });
});

describe('слова ознакомления зависят от отрасли', () => {
  it('«инструктаж по ТБ» на стройке -- рассылка, а не поручение', () => {
    const d = parseByPattern('Азизу инструктаж по ТБ', PEOPLE, 'u-self', NOW, TZ, 'construction')!;
    expect(d.kind).toBe('ack');
  });

  it('«техкарта» в цеху -- рассылка; в школе это обычная задача', () => {
    // Слово должно быть ИМЕННО отраслевым: «приказ» и «ознакомиться» лежат в
    // базовом словаре и работают везде, на них разницу профилей не проверить.
    expect(parseByPattern('Азизу техкарту нового изделия', PEOPLE, 'u-self', NOW, TZ, 'manufacturing')!.kind).toBe('ack');
    expect(parseByPattern('Азизу техкарту нового изделия', PEOPLE, 'u-self', NOW, TZ, 'school')!.kind).toBe('single');
  });

  it('базовое «ознакомиться» работает при любом профиле', () => {
    for (const id of ['generic', 'school', 'construction']) {
      expect(parseByPattern('Азизу ознакомиться с расписанием', PEOPLE, 'u-self', NOW, TZ, id)!.kind, id).toBe('ack');
    }
  });
});

describe('профиль при создании организации', () => {
  it('заводит отделы профиля, а не одну доску «Задачи»', async () => {
    const env = await blank();
    const uid = await ensureUser(env, 'tg-pack', 'Директор', null);
    const { orgId, departments } = await createOrg(env, uid, 'Школа №7', 'school');

    const { results } = await testEnv.DB
      .prepare('SELECT name FROM projects WHERE org_id = ? ORDER BY created_at')
      .bind(orgId).all<{ name: string }>();
    expect(results.map((r) => r.name)).toEqual(pack('school').departments);
    expect(departments).toEqual(pack('school').departments);
  });

  it('профиль сохраняется и доходит до разбора', async () => {
    const env = await blank();
    const uid = await ensureUser(env, 'tg-pack2', 'Прораб', null);
    const { orgId } = await createOrg(env, uid, 'СтройДом', 'construction');
    const row = await testEnv.DB.prepare('SELECT industry_pack FROM orgs WHERE id = ?').bind(orgId)
      .first<{ industry_pack: string }>();
    expect(row!.industry_pack).toBe('construction');
  });

  it('без профиля -- прежнее поведение: одна доска', async () => {
    const env = await blank();
    const uid = await ensureUser(env, 'tg-pack3', 'Кто-то', null);
    const { orgId } = await createOrg(env, uid, 'Просто фирма');
    const { results } = await testEnv.DB.prepare('SELECT name FROM projects WHERE org_id = ?').bind(orgId).all<{ name: string }>();
    expect(results.map((r) => r.name)).toEqual(['Задачи']);
  });
});

describe('каталог отраслей', () => {
  it('каждая отрасль лежит в существующей категории, и пустых категорий нет', () => {
    const ids = new Set(CATEGORIES.map((c) => c.id));
    for (const p of PACKS) expect(ids.has(p.category), p.id).toBe(true);
    for (const c of CATEGORIES) expect(packsOf(c.id).length, c.id).toBeGreaterThan(0);
  });

  it('словарь категории достаётся каждой её отрасли', () => {
    // Ради этого словарь и разделён на два уровня: «пациент ждёт» написано
    // один раз в категории «Медицина» и работает во всех шести отраслях.
    for (const p of packsOf('med')) {
      expect(p.urgent, p.id).toContain('пациент ждёт');
    }
  });

  it('своё у отрасли добавляется к общему, а не заменяет его', () => {
    const dental = pack('dental');
    expect(dental.urgent).toContain('пациент ждёт');   // от категории
    expect(dental.urgent).toContain('острая боль');    // своё
  });
});

describe('приём в организацию: роль и отдел', () => {
  const setup = async (packId: string) => {
    const env = await blank();
    const owner = await ensureUser(env, 'tg-o-role', 'Владелец', null);
    const { orgId, code } = await createOrg(env, owner, 'Фирма', packId);
    const joiner = await ensureUser(env, 'tg-j-role', 'Новичок', null);
    await joinByCode(env, joiner, code);
    return { env, owner, orgId, joiner };
  };

  it('роль берётся из выбора, а не назначается «сотрудником» молча', async () => {
    const { env, owner, orgId, joiner } = await setup('generic');
    expect(await approveJoin(env, owner, orgId, joiner, 'admin')).toBe(true);
    expect(await membershipRole(testEnv.DB, orgId, joiner)).toBe('admin');
  });

  it('новичок садится В ВЫБРАННЫЙ отдел, а не в первый попавшийся', async () => {
    const { env, owner, orgId, joiner } = await setup('school');
    const depts = await orgDepartments(env, orgId);
    // Школа: «Учебная часть», «Классные руководители», ... Сажаем во второй.
    expect(await approveJoin(env, owner, orgId, joiner, 'member', depts[1].id)).toBe(true);
    const { results } = await testEnv.DB
      .prepare('SELECT project_id FROM project_memberships WHERE user_id = ? AND org_id = ?')
      .bind(joiner, orgId).all<{ project_id: string }>();
    expect(results.map((r) => r.project_id)).toEqual([depts[1].id]);
  });

  it('чужой отдел не принимается: кнопку можно переслать', async () => {
    const { env, owner, orgId, joiner } = await setup('generic');
    const other = await ensureUser(env, 'tg-other', 'Другой', null);
    const { orgId: foreignOrg } = await createOrg(env, other, 'Чужая', 'school');
    const foreign = await orgDepartments(env, foreignOrg);

    expect(await approveJoin(env, owner, orgId, joiner, 'member', foreign[0].id)).toBe(true);
    // Принят -- но в СВОЙ отдел: чужой идентификатор молча отброшен.
    const { results } = await testEnv.DB
      .prepare('SELECT project_id FROM project_memberships WHERE user_id = ? AND org_id = ?')
      .bind(joiner, orgId).all<{ project_id: string }>();
    expect(results.map((r) => r.project_id)).not.toContain(foreign[0].id);
    expect(results).toHaveLength(1);
  });

  it('владельца с кнопки не выдают', async () => {
    // Владелец у организации один, и передача владения -- отдельное осознанное
    // действие, а не выбор под уведомлением.
    const { env, owner, orgId, joiner } = await setup('generic');
    expect(await approveJoin(env, owner, orgId, joiner, 'creator')).toBe(false);
    expect(await membershipRole(testEnv.DB, orgId, joiner)).toBeNull();
  });

  it('должность из профиля сохраняется', async () => {
    const { env, owner, orgId, joiner } = await setup('school');
    const depts = await orgDepartments(env, orgId);
    await approveJoin(env, owner, orgId, joiner, 'member', depts[0].id, 'Завуч');
    const row = await testEnv.DB.prepare('SELECT position FROM org_memberships WHERE org_id = ? AND user_id = ?')
      .bind(orgId, joiner).first<{ position: string }>();
    expect(row!.position).toBe('Завуч');
    expect(pack('school').positions).toContain('Завуч');
  });
});
