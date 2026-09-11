// Приёмка разбора фраз и медиа.
//
// Слой паттернов проверяется БЕЗ сети: GROQ_API_KEY в фикстуре пуст намеренно.
// Всё, что здесь зелёное, работает бесплатно и мгновенно -- это и есть замер,
// ради которого в плане стоял порог-гейт шага 4b.
import { env as testEnv } from 'cloudflare:test';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { botApp } from '../src/bot';
import { learnAlias, matchDeadline, matchPeople, parseByPattern, parseTask } from '../src/parse';
import { extractMedia } from '../src/media';
import { envWith, stubTelegram } from './fixture';
import type { Env } from '../src/types';

let restore: { mockRestore(): void } | null = null;
afterEach(() => { restore?.mockRestore(); restore = null; vi.useRealTimers(); });
const tg = () => (restore = stubTelegram()) as ReturnType<typeof stubTelegram>;
const sent = (spy: ReturnType<typeof stubTelegram>) =>
  (spy.mock.calls as unknown as [string, { body?: string }][])
    .filter(([u]) => u.includes('/sendMessage'))
    .map(([, i]) => JSON.parse(String(i.body)).text as string);

// Имена с фамилиями, как в жизни. Односложные («Азиз») прятали дефект: имя
// сравнивалось целиком, «азизкаримо» не совпадало с «Азизу», и в проде по
// имени не находился никто -- а тесты были зелёные.
const PEOPLE = [
  { id: 'u-aziz', name: 'Азиз Каримов' },
  { id: 'u-bek', name: 'Бек Юсупов' },
  { id: 'u-maria', name: 'Мария Ли' },
  { id: 'u-alex', name: 'Алексей Смирнов' },
];
const TZ = 'Asia/Tashkent';
// Среда, 2 сентября 2026, 10:00 в Ташкенте (05:00 UTC).
const NOW = new Date('2026-09-02T05:00:00Z');

describe('имена: падежи без морфологии', () => {
  it('дательный падеж узнаётся по основе', () => {
    for (const [phrase, id] of [
      ['Азизу подготовить отчёт', 'u-aziz'],
      ['Беку закупить бумагу', 'u-bek'],
      ['Марии составить график', 'u-maria'],
      ['Алексею позвонить в банк', 'u-alex'],
    ] as const) {
      expect(matchPeople(phrase, PEOPLE).ids, phrase).toEqual([id]);
    }
  });

  it('короткое имя не цепляет длинное', () => {
    // «Ася» не должна совпасть с «Асланом»: порог основы -- не меньше четырёх.
    const people = [{ id: 'a', name: 'Ася' }, { id: 'b', name: 'Аслан' }];
    expect(matchPeople('Аслану купить краску', people).ids).toEqual(['b']);
  });

  it('имя не ловит ДРУГОГО человека, чьё имя начинается так же', () => {
    // «Азизбеку» -- это Азизбек, а не Азиз в дательном падеже. Падежное
    // окончание короткое, поэтому длина слова ограничена длиной имени + 2.
    // Без этого ограничения поручение Азизбеку уходило бы Азизу.
    const people = [{ id: 'a', name: 'Азиз' }, { id: 'b', name: 'Азизбек' }];
    expect(matchPeople('Азизбеку подготовить смету', people).ids).toEqual(['b']);
    expect(matchPeople('Азизбеку подготовить смету', people).ambiguous).toEqual([]);
  });

  it('двое похожих -- ПЕРЕСПРОС, а не догадка', () => {
    // Поручение, ушедшее не тому, дороже одного вопроса. Правило взято у Evi.
    const people = [{ id: 'a1', name: 'Азиз' }, { id: 'a2', name: 'Азиза' }];
    const res = matchPeople('Азизу сделать отчёт', people);
    expect(res.ids).toEqual([]);
    expect(res.ambiguous).toEqual(['Азизу']);
  });

  it('несколько адресатов -- рассылка', () => {
    expect(matchPeople('Азизу и Беку подготовить смету', PEOPLE).ids).toEqual(['u-aziz', 'u-bek']);
  });
});

describe('сроки в поясе организации', () => {
  const iso = (phrase: string) => matchDeadline(phrase, NOW, TZ).iso;
  const localDay = (s: string | null) =>
    s === null ? null : new Date(s).toLocaleDateString('en-CA', { timeZone: TZ });

  it('завтра и послезавтра считаются от МЕСТНОГО дня', () => {
    // В UTC на момент NOW ещё 2 сентября, в Ташкенте тоже -- но при 20:00 UTC
    // они разъедутся. Пояс здесь не косметика.
    expect(localDay(iso('завтра позвонить'))).toBe('2026-09-03');
    expect(localDay(iso('послезавтра сдать'))).toBe('2026-09-04');
    expect(localDay(iso('сегодня закрыть'))).toBe('2026-09-02');
  });

  it('день недели -- ближайший будущий, а не сегодняшний', () => {
    // NOW -- среда. «В среду» означает следующую: сказанное сегодня про сегодня
    // обычно значит «через неделю».
    expect(localDay(iso('в пятницу сдать'))).toBe('2026-09-04');
    expect(localDay(iso('в среду сдать'))).toBe('2026-09-09');
    expect(localDay(iso('до понедельника'))).toBe('2026-09-07');
  });

  it('через N дней и недель', () => {
    expect(localDay(iso('через 3 дня'))).toBe('2026-09-05');
    expect(localDay(iso('через 2 недели'))).toBe('2026-09-16');
  });

  it('число месяца, уже прошедшее, переносится на следующий', () => {
    expect(localDay(iso('до 20-го'))).toBe('2026-09-20');
    expect(localDay(iso('к 1 числу'))).toBe('2026-10-01');
  });

  it('когда в UTC и в Ташкенте РАЗНЫЕ дни, считается местный', () => {
    // 2026-09-02 20:00 UTC -- это уже 3 сентября 01:00 в Ташкенте. «Завтра» для
    // директора означает 4-е, а расчёт по UTC дал бы 3-е: человек получил бы
    // срок на сегодня. Пять часов в сутки эти два ответа расходятся.
    const night = new Date('2026-09-02T20:00:00Z');
    const iso = matchDeadline('завтра сдать', night, TZ).iso;
    expect(new Date(iso!).toLocaleDateString('en-CA', { timeZone: TZ })).toBe('2026-09-04');
  });

  it('нет срока -- null, а не «сегодня»', () => {
    // Поручения без срока нормальны, и подставлять его молча нельзя.
    expect(iso('подготовить отчёт')).toBeNull();
  });
});

describe('разбор целиком, без обращения к сети', () => {
  const parse = (phrase: string) => parseByPattern(phrase, PEOPLE, 'u-self', NOW, TZ);

  it('«Азизу до пятницы подготовить отчёт по закупкам»', () => {
    const d = parse('Азизу до пятницы подготовить отчёт по закупкам')!;
    expect(d.assigneeIds).toEqual(['u-aziz']);
    expect(d.title).toBe('Подготовить отчёт по закупкам');
    expect(new Date(d.deadline!).toLocaleDateString('en-CA', { timeZone: TZ })).toBe('2026-09-04');
    expect(d.kind).toBe('single');
    expect(d.source).toBe('pattern');
  });

  it('«напомни мне завтра позвонить в банк» -- задача себе', () => {
    const d = parse('напомни мне завтра позвонить в банк')!;
    // Личный слой -- это адресат, совпадающий с автором, а не отдельная сущность.
    expect(d.assigneeIds).toEqual(['u-self']);
    expect(d.title).toBe('Позвонить в банк');
  });

  it('рассылка на двоих становится kind=each', () => {
    const d = parse('Азизу и Беку подготовить смету к понедельнику')!;
    expect(d.assigneeIds).toEqual(['u-aziz', 'u-bek']);
    expect(d.kind).toBe('each');
  });

  it('«ознакомить» становится kind=ack', () => {
    const d = parse('Азизу и Беку ознакомиться с новым расписанием')!;
    expect(d.kind).toBe('ack');
  });

  // ПРАВИЛО ИЗМЕНЕНО ОСОЗНАННО. Раньше фраза без адресата уходила модели, и
  // «подготовить отчёт до пятницы» возвращалось сырым текстом БЕЗ срока -- то
  // есть без напоминания. Названный срок сам по себе достаточно уверенный
  // признак: это поручение себе, ровно то, ради чего пишут боту в личку.
  it('срок без адресата -- поручение себе, а не пас модели', () => {
    const d = parse('подготовить отчёт до пятницы')!;
    expect(d).not.toBeNull();
    expect(d.assigneeIds).toEqual(['u-self']);
    expect(d.deadline).not.toBeNull();
    expect(d.title).toBe('Подготовить отчёт');
  });

  it('ни адресата, ни срока -- паттерны сдаются, дальше решает модель', () => {
    expect(parse('подготовить отчёт по поставщикам')).toBeNull();
  });

  it('осталась пустота -- это не поручение', () => {
    expect(parse('Азизу завтра')).toBeNull();
  });
});

describe('разбор НИКОГДА не отвечает «не понимаю»', () => {
  it('без ключа и без адресата задача всё равно создаётся -- на себя', async () => {
    // Правило Evi дословно. Человек продиктовал мысль, и она обязана
    // превратиться хоть во что-то, что можно поправить руками.
    const env = { GROQ_API_KEY: '' } as Env;
    const d = await parseTask(env, 'разобраться с поставщиком', PEOPLE, 'u-self', TZ, NOW);
    expect(d.source).toBe('fallback');
    expect(d.assigneeIds).toEqual(['u-self']);
    // Заголовок с заглавной -- как и на разборе паттернами: в списке эти
    // задачи стоят вперемешку, и разнобой был бы виден сразу.
    expect(d.title).toBe('Разобраться с поставщиком');
  });

  it('слово про срочность не остаётся в названии и на запасном пути', async () => {
    const env = { GROQ_API_KEY: '' } as Env;
    const d = await parseTask(env, 'не срочно разобрать архив', PEOPLE, 'u-self', TZ, NOW);
    expect(d.priority).toBe('low');
    // Оно уже стало полем -- в названии читалось бы дважды.
    expect(d.title).toBe('Разобрать архив');
  });
});

describe('медиа: какие виды понимаются', () => {
  it('голос, кружочек, аудио и видео -- со звуком; фото и файл -- без', () => {
    const cases = [
      [{ voice: { file_id: 'f1', file_size: 100 } }, 'voice', true],
      [{ video_note: { file_id: 'f2', file_size: 200 } }, 'video_note', true],
      [{ audio: { file_id: 'f3', file_size: 300 } }, 'audio', true],
      [{ video: { file_id: 'f4', file_size: 400 } }, 'video', true],
      [{ photo: [{ file_id: 'small', file_size: 10 }, { file_id: 'big', file_size: 900 }] }, 'photo', false],
      [{ document: { file_id: 'f6', file_size: 500, file_name: 'смета.xlsx' } }, 'document', false],
    ] as const;
    for (const [msg, kind, hasAudio] of cases) {
      const m = extractMedia(msg as never)!;
      expect(m.kind, JSON.stringify(msg)).toBe(kind);
      expect(m.hasAudio, kind).toBe(hasAudio);
    }
  });

  it('у фото берётся САМЫЙ КРУПНЫЙ размер, а не превью', () => {
    // Мельче -- это превью. Сохранить превью вместо снимка значит потерять
    // оригинал безвозвратно: у бота другого источника нет.
    const m = extractMedia({ photo: [{ file_id: 'small', file_size: 10 }, { file_id: 'big', file_size: 900 }] } as never)!;
    expect(m.fileId).toBe('big');
  });

  it('пустое сообщение -- не медиа', () => {
    expect(extractMedia({ text: 'привет' } as never)).toBeNull();
  });
});

describe('бот: поручение из фразы, из фото и из кружочка', () => {
  const world = () =>
    envWith({
      users: [
        { id: 'boss', phone: '+1', name: 'Директор', role: 'creator' },
        { id: 'u-aziz', phone: '+2', name: 'Азиз', role: 'admin' },
      ],
      memberships: [{ project_id: 'p1', user_id: 'boss' }, { project_id: 'p1', user_id: 'u-aziz' }],
      projects: [{ id: 'p1', telegram_chat_id: '-100999', created_by: 'boss' }],
      tasks: [],
    });
  const hook = (env: Env, update: unknown) =>
    botApp.request('/webhook', {
      method: 'POST',
      headers: { 'x-telegram-bot-api-secret-token': 'tg-secret', 'Content-Type': 'application/json' },
      body: JSON.stringify(update),
    }, env);
  const from = { id: 'tg-boss', first_name: 'Директор' };

  // Подтверждение -- нажатие «Создать» под карточкой черновика.
  const confirm = async (env: Env) => {
    const d = (await testEnv.DB.prepare('SELECT id FROM drafts').first<{ id: string }>())!;
    await hook(env, { callback_query: { id: 'cb', from, data: `dc:${d.id}`, message: { chat: { id: 'tg-boss' }, message_id: 1 } } });
  };

  it('текстом: сначала черновик, задача -- только после «Создать»', async () => {
    const env = await world();
    const spy = tg();
    await hook(env, { message: { chat: { id: 'tg-boss', type: 'private' }, from, text: 'Азизу завтра подготовить отчёт' } });

    // Задачи ещё нет: разбор показан человеку, и он решает.
    expect((await testEnv.DB.prepare('SELECT COUNT(*) AS n FROM tasks').first<{ n: number }>())!.n).toBe(0);
    const card = sent(spy).at(-1)!;
    expect(card).toContain('Черновик');
    expect(card).toContain('Подготовить отчёт');
    expect(card).toContain('Азиз');

    await confirm(env);
    const task = await testEnv.DB.prepare('SELECT title, kind, source, deadline FROM tasks').first<{ title: string; kind: string; source: string; deadline: string }>();
    expect(task!.title).toBe('Подготовить отчёт');
    expect(task!.source).toBe('bot'); // разобрано паттернами, без обращения к сети
    expect(task!.deadline).not.toBeNull();

    const a = await testEnv.DB.prepare('SELECT user_id FROM task_assignees').first<{ user_id: string }>();
    expect(a!.user_id).toBe('u-aziz');
    // Черновик исчез: он был путём к задаче, а не второй копией.
    expect((await testEnv.DB.prepare('SELECT COUNT(*) AS n FROM drafts').first<{ n: number }>())!.n).toBe(0);
  });

  it('фото с подписью: черновик с вложением, после «Создать» файл приложен к задаче', async () => {
    const env = await world();
    tg();
    await hook(env, {
      message: {
        chat: { id: 'tg-boss', type: 'private' }, from,
        photo: [{ file_id: 'ph-small', file_size: 10 }, { file_id: 'ph-big', file_size: 5000 }],
        caption: 'Азизу завтра починить это',
      },
    });
    await confirm(env);
    const task = await testEnv.DB.prepare('SELECT id, title FROM tasks').first<{ id: string; title: string }>();
    expect(task!.title).toBe('Починить это');
    const att = await testEnv.DB.prepare('SELECT filename, mime_type FROM attachments WHERE task_id = ?').bind(task!.id).first<{ filename: string; mime_type: string }>();
    expect(att).toMatchObject({ filename: 'photo.jpg', mime_type: 'image/jpeg' });
  });

  it('файл без подписи заводит черновик и спрашивает, чего он касается', async () => {
    // Правило владельца: файл, присланный после создания задачи, -- это уже
    // НОВАЯ задача. Раньше бот просил подпись и не создавал ничего, и файл
    // оставался висеть в чате сам по себе.
    const env = await world();
    const spy = tg();
    await hook(env, { message: { chat: { id: 'tg-boss', type: 'private' }, from: { id: 'tg-boss', first_name: 'Д' }, photo: [{ file_id: 'ph1', file_size: 1000 }] } });
    const row = await testEnv.DB.prepare('SELECT title, media FROM drafts').first<{ title: string; media: string }>();
    expect(row!.title).toBe('');
    expect(JSON.parse(row!.media)).toHaveLength(1);
    expect(sent(spy).at(-1)).toContain('чего это касается');

    // Ответ на этот вопрос дополняет ТОТ ЖЕ черновик, а не заводит второй:
    // иначе файл остался бы висеть в черновике без темы.
    await hook(env, { message: { chat: { id: 'tg-boss', type: 'private' }, from: { id: 'tg-boss', first_name: 'Д' }, text: 'это накладные, Азизу проверить до вторника' } });
    const { results } = await testEnv.DB.prepare('SELECT title, media FROM drafts').all<{ title: string; media: string }>();
    expect(results).toHaveLength(1);
    expect(results[0].title).toContain('акладные');
    expect(JSON.parse(results[0].media)).toHaveLength(1);
  });

  it('кружочек больше 20 МБ: говорим прямо, а не молчим', async () => {
    const env = await world();
    const spy = tg();
    await hook(env, { message: { chat: { id: 'tg-boss', type: 'private' }, from, video_note: { file_id: 'vn', file_size: 25 * 1024 * 1024 } } });
    // 20 МБ -- потолок getFile у Telegram, не наш выбор. Человек должен узнать,
    // что делать, а не гадать, почему бот промолчал.
    expect(sent(spy).join(' ')).toContain('20 МБ');
  });

  it('неоднозначное имя: переспрашиваем и НЕ создаём задачу', async () => {
    const env = await envWith({
      users: [
        { id: 'boss', phone: '+1', name: 'Директор', role: 'creator' },
        { id: 'a1', phone: '+2', name: 'Азиз', role: 'admin' },
        { id: 'a2', phone: '+3', name: 'Азиза', role: 'admin' },
      ],
      memberships: [{ project_id: 'p1', user_id: 'boss' }, { project_id: 'p1', user_id: 'a1' }, { project_id: 'p1', user_id: 'a2' }],
      projects: [{ id: 'p1', telegram_chat_id: '-100999', created_by: 'boss' }],
      tasks: [],
    });
    const spy = tg();
    await hook(env, { message: { chat: { id: 'tg-boss', type: 'private' }, from, text: 'Азизу завтра сдать отчёт' } });
    expect(sent(spy).join(' ')).toContain('Кого именно');
    const { n } = (await testEnv.DB.prepare('SELECT COUNT(*) AS n FROM tasks').first<{ n: number }>())!;
    expect(n).toBe(0);
  });
});

describe('имя и фамилия -- обе формы обращения', () => {
  const parse = (t: string) => parseByPattern(t, PEOPLE, 'u-self', NOW, TZ);

  it('по имени в дательном падеже', () => {
    expect(parse('Азизу подготовить отчёт до пятницы')!.assigneeIds).toEqual(['u-aziz']);
  });

  it('по фамилии', () => {
    expect(parse('Каримову подготовить отчёт до пятницы')!.assigneeIds).toEqual(['u-aziz']);
  });

  it('имя выкидывается из заголовка, а не остаётся в нём', () => {
    const d = parse('Азизу подготовить отчёт до пятницы')!;
    expect(d.title).toBe('Подготовить отчёт');
  });

  it('двое с одинаковым именем -- переспрос, а не догадка', () => {
    const two = [...PEOPLE, { id: 'u-aziz2', name: 'Азиз Рахимов' }];
    const d = parseByPattern('Азизу подготовить отчёт', two, 'u-self', NOW, TZ)!;
    expect(d.ambiguous).toEqual(['Азизу']);
    expect(d.assigneeIds).toEqual([]);
  });
});

describe('срочность из слов', () => {
  const parse = (t: string) => parseByPattern(t, PEOPLE, 'u-self', NOW, TZ)!;

  it('«срочно» поднимает, «не срочно» опускает', () => {
    expect(parse('Азизу срочно подготовить отчёт').priority).toBe('urgent');
    // Порядок проверки обязателен: «не срочно» содержит «срочно» подстрокой, и
    // при обратном порядке всё несрочное стало бы срочным.
    expect(parse('Азизу не срочно подготовить отчёт').priority).toBe('low');
    expect(parse('Азизу несрочно подготовить отчёт').priority).toBe('low');
  });

  it('без слов о срочности -- средняя', () => {
    expect(parse('Азизу подготовить отчёт').priority).toBe('medium');
  });

  it('слово срочности не остаётся в заголовке', () => {
    // «срочно позвонить в банк» -- это задача «позвонить в банк» со
    // срочностью, а не задача с этим словом в названии.
    expect(parse('Азизу срочно позвонить в банк').title).toBe('Позвонить в банк');
  });

  it('«сроки» и «срочность» в сути задачи не считаются признаком', () => {
    // Ловушка того же рода, что «ср» внутри «срочно» у дней недели.
    expect(parse('Азизу уточнить сроки поставки').priority).toBe('medium');
  });
});


// Обучение вместо второго запроса к модели: слово, которым назвали человека,
// запоминается один раз и дальше ловится правилами.
describe('псевдоним из поправки', () => {
  const world = () =>
    envWith({
      users: [
        { id: 'boss', phone: '+1', name: 'Директор', role: 'creator' },
        { id: 'u-aziz', phone: '+2', name: 'Азиз Каримов', role: 'admin' },
        { id: 'u-bek', phone: '+3', name: 'Бекзод Юсупов', role: 'admin' },
      ],
      memberships: [{ project_id: 'p1', user_id: 'boss' }, { project_id: 'p1', user_id: 'u-aziz' }, { project_id: 'p1', user_id: 'u-bek' }],
      projects: [{ id: 'p1', telegram_chat_id: '-100999', created_by: 'boss' }],
      tasks: [],
    });
  const people = [
    { id: 'u-aziz', name: 'Азиз Каримов' },
    { id: 'u-bek', name: 'Бекзод Юсупов' },
  ];

  it('одно непонятое слово -- запоминается, и следующая фраза разбирается без модели', async () => {
    const env = await world();
    // Правила «Беку» не знают: основа «бекзо» не совпадает.
    expect(matchPeople('Беку купить бумагу', people).ids).toEqual([]);

    expect(await learnAlias(env, 'не Азизу, а Беку', people, 'u-bek')).toBe('беку');
    const saved = await testEnv.DB.prepare("SELECT aliases FROM users WHERE id='u-bek'").first<{ aliases: string }>();
    expect(JSON.parse(saved!.aliases)).toEqual(['беку']);

    // Теперь то же слово ловится правилами -- модель не нужна.
    const learned = [{ id: 'u-aziz', name: 'Азиз Каримов' }, { id: 'u-bek', name: 'Бекзод Юсупов', aliases: ['беку'] }];
    const draft = parseByPattern('Беку купить бумагу до пятницы', learned, 'boss', new Date('2026-09-11T09:00:00.000Z'), 'Asia/Tashkent');
    expect(draft!.assigneeIds).toEqual(['u-bek']);
    expect(draft!.title).toBe('Купить бумагу');
  });

  it('два непонятых слова -- не учим: это уже догадка', async () => {
    const env = await world();
    expect(await learnAlias(env, 'отдай это Беку Юсупу', people, 'u-bek')).toBe(null);
    const saved = await testEnv.DB.prepare("SELECT aliases FROM users WHERE id='u-bek'").first<{ aliases: string | null }>();
    expect(saved!.aliases).toBe(null);
  });

  it('человека узнали правилами -- учить нечего', async () => {
    const env = await world();
    expect(await learnAlias(env, 'не Азизу, а Бекзоду', people, 'u-bek')).toBe(null);
  });
});
