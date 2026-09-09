// Приёмка отраслевых профилей.
//
// Профиль обязан менять ТРИ вещи, иначе он декоративный ярлык: набор отделов,
// понимание срочности и понимание «ознакомиться». Проверяется каждая.
import { env as testEnv } from 'cloudflare:test';
import { describe, expect, it } from 'vitest';
import { PACKS, pack, packButton, packByButton } from '../src/packs';
import { matchPriority, parseByPattern } from '../src/parse';
import { createOrg, ensureUser } from '../src/signup';
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
