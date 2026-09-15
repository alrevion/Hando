// Жалоба владельца: наговорил «Каждого 18 числа каждого месяца мне нужно
// оплачивать мобильный интернет», получил черновик БЕЗ повтора и без срока. Потом
// наговорил «Надо в содержании изменить: не оппонентскую плату, а абонентскую» --
// и бот завёл ВТОРОЙ черновик с темой «Изменить содержание».
//
// Три поломки, по одной на блок.
import { env as testEnv } from 'cloudflare:test';
import { afterEach, describe, expect, it } from 'vitest';
import { botApp } from '../src/bot';
import { matchDeadline, matchRepeat, parseTask, swapWords } from '../src/parse';
import { MONTH_MIN, nextRound } from '../src/assignees';
import { envWith, stubTelegram } from './fixture';
import type { Env } from '../src/types';

let restore: { mockRestore(): void } | null = null;
afterEach(() => { restore?.mockRestore(); restore = null; });

const PHRASE = 'Каждого 18 числа каждого месяца мне нужно оплачивать мобильный интернет. Запиши это в напоминание.';
// 15 сентября 2026, полдень по Ташкенту.
const NOW = new Date('2026-09-15T07:00:00.000Z');
const TZ = 'Asia/Tashkent';

describe('«каждого 18 числа каждого месяца»', () => {
  it('разбор видит и повтор, и число месяца', () => {
    expect(matchRepeat(PHRASE).days).toBe(30);
    const when = matchDeadline(PHRASE, NOW, TZ);
    expect(when.iso).not.toBeNull();
    // Ближайшее 18-е -- в этом же месяце, число ещё не прошло.
    expect(new Date(when.iso!).toLocaleDateString('ru-RU', { timeZone: TZ, day: 'numeric', month: 'numeric' })).toBe('18.09');
  });

  it('падеж неважен: «каждый месяц» и «каждого месяца» -- одно и то же', () => {
    expect(matchRepeat('платить за свет каждый месяц').days).toBe(30);
    expect(matchRepeat('платить за свет каждого месяца').days).toBe(30);
  });

  it('голое число без «числа» -- не срок: это и количество, и час', () => {
    expect(matchDeadline('купить 18 яиц', NOW, TZ).iso).toBeNull();
  });

  it('фраза из жалобы целиком -- черновик себе С ПОВТОРОМ и сроком', async () => {
    // Раньше без «повтора» и «срока» фраза не узнавалась как поручение себе и
    // уходила в модель: та возвращала тему и содержание, но ни повтора, ни
    // срока в её ответе нет вовсе. Теперь признаки узнаются, и фраза остаётся
    // в разборе, который знает часы организации.
    const env = { ...testEnv, GROQ_API_KEY: '' } as unknown as Env;
    const draft = await parseTask(env, PHRASE, [{ id: 'me', name: 'Тимур Абдуллаев' }], 'me', TZ, NOW);
    expect(draft.source).toBe('pattern');
    expect(draft.assigneeIds).toEqual(['me']);
    expect(draft.repeatMin).toBe(MONTH_MIN);
    expect(new Date(draft.deadline!).toLocaleDateString('ru-RU', { timeZone: TZ, day: 'numeric', month: 'numeric' })).toBe('18.09');
  });
});

describe('«не оппонентскую плату, а абонентскую» -- замена слова', () => {
  const FIX = 'Надо в содержании изменить что? Не оппонентскую плату, а абонентскую плату.';

  it('меняет фразу целиком там, где она стоит', () => {
    expect(swapWords(FIX, 'Оплачивать оппонентскую плату за услуги каждый месяц.'))
      .toBe('Оплачивать абонентскую плату за услуги каждый месяц.');
  });

  it('если фразы целиком нет -- меняет отличающееся слово', () => {
    // В тексте другой падеж второго слова, но первое совпадает.
    expect(swapWords(FIX, 'Оппонентскую платёжку внести до 18-го')).toBe('Абонентскую платёжку внести до 18-го');
  });

  it('заменять нечего -- null, а не порча текста', () => {
    expect(swapWords(FIX, 'Купить молоко')).toBeNull();
    expect(swapWords('подготовить отчёт', 'Подготовить отчёт')).toBeNull();
  });
});

describe('поправка голосом БЕЗ ответа на карточку', () => {
  const world = () => envWith({
    users: [{ id: 'boss', phone: '+1', name: 'Тимур Абдуллаев', role: 'creator' }],
    memberships: [{ project_id: 'p1', user_id: 'boss' }],
    projects: [{ id: 'p1', telegram_chat_id: '-100999', created_by: 'boss' }],
    tasks: [],
  });
  const say = (env: Env, text: string) =>
    botApp.request('/webhook', { method: 'POST', headers: { 'x-telegram-bot-api-secret-token': 'tg-secret', 'Content-Type': 'application/json' },
      body: JSON.stringify({ message: { chat: { id: 'tg-boss', type: 'private' }, from: { id: 'tg-boss', first_name: 'Т' }, text } }) }, env);
  const drafts = async () =>
    (await testEnv.DB.prepare("SELECT title, description FROM drafts WHERE author_id = 'boss' ORDER BY created_at")
      .all<{ title: string; description: string | null }>()).results;

  it('правит СВЕЖИЙ черновик, а не заводит второй', async () => {
    const env = await world();
    restore = stubTelegram();
    await say(env, 'Тимуру оплачивать оппонентскую плату за интернет каждого 18 числа');
    await testEnv.DB.prepare("UPDATE drafts SET description = 'Оплачивать оппонентскую плату за интернет'").run();

    await say(env, 'Надо в содержании изменить что? Не оппонентскую плату, а абонентскую плату.');

    const rows = await drafts();
    expect(rows).toHaveLength(1);
    expect(rows[0].description).toBe('Оплачивать абонентскую плату за интернет');
  });

  it('обычное поручение с «заменить» чужой черновик НЕ трогает', async () => {
    const env = await world();
    restore = stubTelegram();
    await say(env, 'Тимуру оплатить интернет каждого 18 числа');
    const before = await drafts();

    await say(env, 'Тимуру заменить картридж в принтере');

    const rows = await drafts();
    // Первый черновик цел, а картридж -- отдельный черновик.
    expect(rows[0]).toEqual(before[0]);
    expect(rows).toHaveLength(2);
  });
});

describe('«каждый месяц» -- календарный, а не плюс 30 суток', () => {
  const at = (iso: string) => Date.parse(iso);

  it('18-е остаётся 18-м', () => {
    const next = nextRound(at('2026-09-18T13:00:00Z'), MONTH_MIN, at('2026-09-18T14:00:00Z'));
    expect(next.toISOString()).toBe('2026-10-18T13:00:00.000Z');
  });

  it('31-е в коротком месяце прижимается к последнему дню, а не уезжает на 1-е', () => {
    const next = nextRound(at('2026-01-31T13:00:00Z'), MONTH_MIN, at('2026-01-31T14:00:00Z'));
    expect(next.toISOString()).toBe('2026-02-28T13:00:00.000Z');
  });

  it('закрыли с опозданием в три месяца -- ближайшее 18-е в будущем, не просроченное', () => {
    const next = nextRound(at('2026-06-18T13:00:00Z'), MONTH_MIN, at('2026-09-20T00:00:00Z'));
    expect(next.toISOString()).toBe('2026-10-18T13:00:00.000Z');
  });

  it('другие интервалы -- по-прежнему минутами', () => {
    const next = nextRound(at('2026-09-15T10:00:00Z'), 2 * 1440, at('2026-09-15T11:00:00Z'));
    expect(next.toISOString()).toBe('2026-09-17T10:00:00.000Z');
  });
});
