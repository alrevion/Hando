// Разбор фразы в поручение: паттерны, затем нейросеть.
//
// Порядок не декоративный. Люди формулируют поручения узким набором форм:
// «Азизу до пятницы подготовить отчёт», «напомни мне завтра позвонить в банк».
// Имя в дательном падеже, слово даты, остальное -- суть. Это разбирается в
// воркере за микросекунды и бесплатно.
//
// Нейросеть -- ДЕФОЛТ, а не крайний случай. Правило взято у Evi (core/app/
// router.py) дословно: разбор НИКОГДА не отвечает «не понимаю». Не сошлись
// паттерны -- идём в модель; не ответила модель -- отдаём задачу без адресата и
// срока, но отдаём.
//
// Чего здесь СОЗНАТЕЛЬНО нет: семантического кэша на эмбеддингах, как в Evi. Там
// он окупается, потому что вопросы повторяются («когда каникулы?»). Поручения не
// повторяются: имена и даты разные, кэш промахнётся почти всегда.
import type { Env } from './types';

export type Person = { id: string; name: string; aliases?: string[] };

export type Draft = {
  title: string;
  assigneeIds: string[];
  deadline: string | null;
  kind: 'single' | 'each' | 'ack';
  /** Чем разобрано -- для замера порога-гейта шага 4b. */
  source: 'pattern' | 'llm' | 'fallback';
  /** Имена, которые разрешились неоднозначно: спрашиваем, а не гадаем. */
  ambiguous: string[];
};

// ------------------------------------------------------------------ имена

/**
 * Совпадение слова с именем по общей основе.
 *
 * Морфологию русского не реализуем: падежные окончания короткие, а основа
 * устойчива. «Азизу»/«Азиз», «Марии»/«Мария», «Алексею»/«Алексей» -- общая
 * основа 4-6 символов. Порог -- вся длина имени минус одна буква, но не меньше
 * четырёх: иначе «Ася» совпадёт с «Асланом».
 */
function stemMatches(word: string, name: string): boolean {
  const w = word.toLowerCase().replace(/[^а-яёa-z]/gi, '');
  const n = name.toLowerCase().replace(/[^а-яёa-z]/gi, '');
  if (!w || !n) return false;
  // Основа: имя целиком для коротких, минус последняя буква для длинных.
  // «Бек» -> «бек» ловит «беку»; «Мария» -> «мари» ловит «марии».
  // Отрезать больше нельзя: «Ася» -> «ас» поймало бы «Аслана».
  const stem = n.length <= 4 ? n : n.slice(0, -1);
  if (!w.startsWith(stem)) return false;
  // Падежное окончание короткое. Без этого ограничения «Азиз» ловил бы
  // «Азизбека» -- другого человека, а не другую форму того же имени.
  return w.length <= n.length + 2;
}

/**
 * Находит адресатов среди слов фразы.
 *
 * Слово, подходящее ДВУМ людям сразу, уходит в `ambiguous` и НЕ становится
 * адресатом. Два завуча по имени Азиз -- это переспрос, а не догадка: поручение,
 * ушедшее не тому, хуже вопроса «какому именно Азизу?».
 */
export function matchPeople(text: string, people: Person[]): { ids: string[]; ambiguous: string[]; usedWords: Set<string> } {
  const words = text.split(/\s+/).filter(Boolean);
  const ids: string[] = [];
  const ambiguous: string[] = [];
  const usedWords = new Set<string>();

  for (const word of words) {
    const hits = people.filter((p) => [p.name, ...(p.aliases ?? [])].some((n) => stemMatches(word, n)));
    if (hits.length === 1) {
      if (!ids.includes(hits[0].id)) ids.push(hits[0].id);
      usedWords.add(word);
    } else if (hits.length > 1) {
      ambiguous.push(word);
      usedWords.add(word);
    }
  }
  return { ids, ambiguous, usedWords };
}

// ------------------------------------------------------------------ сроки

// Полное слово ИЛИ сокращение. Сокращения обязаны стоять за границами слова:
// без них «ср» совпало бы внутри «срочно» и «сроки», а «вс» -- внутри «всё».
// Индекс массива -- номер дня недели у getUTCDay().
const WEEKDAYS = [
  'воскресень[а-яё]*|вс',
  'понедельник[а-яё]*|пн',
  'вторник[а-яё]*|вт',
  'сред[а-яё]*|ср',
  'четверг[а-яё]*|чт',
  'пятниц[а-яё]*|пт',
  'суббот[а-яё]*|сб',
];

/**
 * Срок из фразы. Возвращает ISO и слова, которые его задали (их надо убрать из
 * заголовка -- «до пятницы» не часть сути поручения).
 *
 * Считается В ПОЯСЕ ОРГАНИЗАЦИИ: «завтра» у директора в Ташкенте и у сервера в
 * UTC -- разные дни пять часов в сутки.
 */
export function matchDeadline(text: string, now: Date, timeZone: string): { iso: string | null; usedWords: Set<string> } {
  const used = new Set<string>();
  const lower = text.toLowerCase();

  // Дата считается ЧЕРЕЗ Intl, а не через new Date(toLocaleString(...)).
  //
  // Прежний вариант делал круг «строка местного времени -> Date», и результат
  // зависел от пояса САМОГО рантайма: локально тесты идут в Asia/Tashkent, и
  // преобразование было пустой операцией -- код работал по совпадению, а мутация
  // «считать в UTC» не ловилась ничем. В проде воркер идёт в UTC, где тот же код
  // ведёт себя иначе. Intl с явным timeZone от пояса рантайма не зависит вовсе.
  const parts = (at: Date) => {
    const f = new Intl.DateTimeFormat('en-CA', {
      timeZone, year: 'numeric', month: '2-digit', day: '2-digit',
      hour: '2-digit', minute: '2-digit', second: '2-digit', hour12: false,
    });
    const o = Object.fromEntries(f.formatToParts(at).map((x) => [x.type, x.value])) as Record<string, string>;
    return { y: +o.year, m: +o.month, d: +o.day, h: +o.hour % 24, mi: +o.minute, s: +o.second };
  };
  // Смещение пояса НА ЭТОТ момент: стенные часы минус мировое время.
  const offsetMs = (at: Date) => {
    const p = parts(at);
    return Date.UTC(p.y, p.m - 1, p.d, p.h, p.mi, p.s) - at.getTime();
  };

  const today = parts(now);
  // Полночь местного дня, выраженная в UTC-мерах: с ней удобно считать «+N дней».
  const midnight = new Date(Date.UTC(today.y, today.m - 1, today.d));

  /** Местные Y/M/D + час -> настоящий момент времени. */
  const at = (d: Date, hour = 18) => {
    const wall = Date.UTC(d.getUTCFullYear(), d.getUTCMonth(), d.getUTCDate(), hour);
    // Смещение берётся на приблизительный момент, затем уточняется: у поясов с
    // переводом часов смещение до и после полуночи может отличаться.
    const rough = new Date(wall - offsetMs(new Date(wall)));
    return new Date(wall - offsetMs(rough)).toISOString();
  };
  const mark = (...ws: string[]) => ws.forEach((w) => used.add(w));

  let base: Date | null = null;
  // Порядок важен: «послезавтра» содержит «завтра» как подстроку.
  if (word('сегодня').test(lower)) { base = midnight; mark('сегодня'); }
  else if (word('послезавтра').test(lower)) { base = new Date(midnight.getTime() + 2 * 864e5); mark('послезавтра'); }
  else if (word('завтра').test(lower)) { base = new Date(midnight.getTime() + 864e5); mark('завтра'); }

  if (!base) {
    const days = lower.match(/через\s+(\d+)\s*(дн|день|дня|недел)[а-яё]*/i);
    if (days) {
      const n = Number(days[1]) * (days[2].startsWith('недел') ? 7 : 1);
      base = new Date(midnight.getTime() + n * 864e5);
      mark(...days[0].split(/\s+/));
    }
  }

  if (!base) {
    for (let i = 0; i < WEEKDAYS.length; i++) {
      // Границы слова -- явные (B/E), а не \\b: в JS \\b определена через ASCII и
      // на кириллице не работает. Без них «ср» совпадало бы внутри «срочно».
      const re = new RegExp(`${B}(?:(?:в|во|до|к)\\s+)?(?:${WEEKDAYS[i]})${E}`, 'i');
      const m = lower.match(re);
      if (!m) continue;
      // Ближайший такой день недели, считая от завтра: «в пятницу», сказанное в
      // пятницу, означает следующую, а не сегодня.
      const cur = midnight.getUTCDay();
      const delta = ((i - cur + 7) % 7) || 7;
      base = new Date(midnight.getTime() + delta * 864e5);
      // m[0] может начинаться со знака препинания, съеденного границей B.
      mark(...m[0].split(/\s+/).map((w) => w.replace(/^[^а-яё\w]+/i, '')).filter(Boolean));
      break;
    }
  }

  if (!base) {
    const dom = lower.match(/(?:до|к)\s+(\d{1,2})[-\s]*(?:го|числ[а-яё]*)/i);
    if (dom) {
      const day = Number(dom[1]);
      const d = new Date(midnight);
      d.setUTCDate(day);
      // Число уже прошло -- значит следующий месяц.
      if (d < midnight) d.setUTCMonth(d.getUTCMonth() + 1);
      base = d;
      mark(...dom[0].split(/\s+/));
    }
  }

  if (!base) return { iso: null, usedWords: used };

  // Время суток, если названо: «к 9 утра», «в 15:00».
  const time = lower.match(/(?:в|к|до)\s+(\d{1,2})(?::(\d{2}))?\s*(утра|дня|вечера)?/);
  if (time) {
    let h = Number(time[1]);
    if (time[3] === 'вечера' && h < 12) h += 12;
    if (time[3] === 'дня' && h < 12) h += 12;
    if (h >= 0 && h <= 23) {
      mark(...time[0].split(/\s+/));
      const wall = Date.UTC(base.getUTCFullYear(), base.getUTCMonth(), base.getUTCDate(), h, Number(time[2] ?? 0));
      const rough = new Date(wall - offsetMs(new Date(wall)));
      return { iso: new Date(wall - offsetMs(rough)).toISOString(), usedWords: used };
    }
  }
  return { iso: at(base), usedWords: used };
}

// ------------------------------------------------------------------ слой паттернов

const LEAD_NOISE = /^(?:пожалуйста|слушай|короче|так|ну|и|а)\s+/i;

// ВАЖНО про регулярки ниже: в JS `\b` и `\w` определены ЧЕРЕЗ ASCII, поэтому
// `\bзавтра\b` не совпадает НИКОГДА, а `пятниц\w*` обрывается на «ы».
// Границы слова задаются явно: начало строки, пробел или знак препинания.
const B = '(?:^|[\\s,.;:!?«»"\'()-])';
const E = '(?=$|[\\s,.;:!?«»"\'()-])';
const word = (alts: string) => new RegExp(`${B}(?:${alts})${E}`, 'i');

const SELF = word('мне|себе|я');
const ACK_MARKERS = word('ознаком[а-яё]*|прочит[а-яё]*|прочти|к сведению|довед[а-яё]*|объявлени[а-яё]*|приказ[а-яё]*');

/**
 * Разбор паттернами. null -- не хватило уверенности, дальше решает модель.
 *
 * Уверенность требуется в АДРЕСАТЕ: задача без исполнителя бессмысленна, а
 * угадывать его нельзя. Срок необязателен -- поручения без срока нормальны.
 */
export function parseByPattern(text: string, people: Person[], selfId: string, now: Date, timeZone: string): Draft | null {
  const clean = text.replace(LEAD_NOISE, '').trim();
  const { ids, ambiguous, usedWords } = matchPeople(clean, people);
  const { iso, usedWords: dateWords } = matchDeadline(clean, now, timeZone);

  // «напомни мне завтра...» -- поручение себе. Оно же личный слой: адресат
  // совпадает с автором, отдельной сущности для этого нет по замыслу.
  // Неоднозначность проверяется ПЕРВОЙ. Прежде она стояла после выхода по
  // «адресата нет» -- а при двух подходящих людях адресатов как раз ноль, и до
  // переспроса управление не доходило: фраза уезжала в модель, та тоже не могла
  // выбрать, и задача молча создавалась на самого автора.
  if (ambiguous.length > 0) {
    return { title: '', assigneeIds: [], deadline: iso, kind: 'single', source: 'pattern', ambiguous };
  }

  // Адресат не назван, но назван СРОК -- это напоминание себе: «сдать отчёт в
  // пятницу». Ровно то, ради чего человек пишет боту в личку, и то, из-за чего
  // раньше фраза уезжала в модель: та возвращала пустоту, и оставался сырой
  // текст без срока -- то есть без напоминания вообще.
  const isSelf = ids.length === 0 && (SELF.test(clean) || iso !== null);
  const assignees = isSelf ? [selfId] : ids;
  if (assignees.length === 0) return null; // ни адресата, ни срока -- решает модель

  // Заголовок -- то, что осталось: убираем имена, слова даты и служебные слова.
  const drop = new Set([...usedWords, ...dateWords].map((w) => w.toLowerCase()));
  const title = clean
    .split(/\s+/)
    // Предлоги НЕ выкидываются огулом: «в банк» -- часть сути поручения. Те,
    // что относились к сроку («до пятницы»), уже вычеркнуты как слова даты.
    .filter((w) => !drop.has(w.toLowerCase()) && !/^(?:напомни|поручи|скажи|передай|мне|себе|я)$/i.test(w))
    .join(' ')
    .replace(/\s+/g, ' ')
    .trim();
  if (title.length < 3) return null; // осталась пустота -- это не поручение

  return {
    title: title[0].toUpperCase() + title.slice(1),
    assigneeIds: assignees,
    deadline: iso,
    kind: ACK_MARKERS.test(clean) ? 'ack' : assignees.length > 1 ? 'each' : 'single',
    source: 'pattern',
    ambiguous: [],
  };
}

// ------------------------------------------------------------------ нейросеть

const GROQ = 'https://api.groq.com/openai/v1';

/** Разбор моделью. null -- сеть не ответила; вызывающий отдаёт fallback. */
export async function parseByLlm(env: Env, text: string, people: Person[], model: string): Promise<Draft | null> {
  const roster = people.map((p) => `${p.id}=${p.name}`).join('; ');
  const prompt = [
    'Разбери поручение в JSON. Отвечай ТОЛЬКО JSON, без пояснений.',
    'Поля: title (суть без имён и дат), assignee_ids (массив id из списка), deadline (ISO 8601 или null), kind ("single"|"each"|"ack").',
    'kind="ack" если это объявление/приказ «ознакомиться», а не задача.',
    `Люди: ${roster}`,
    `Фраза: ${text}`,
  ].join('\n');

  try {
    const res = await fetch(`${GROQ}/chat/completions`, {
      method: 'POST',
      headers: { Authorization: `Bearer ${env.GROQ_API_KEY}`, 'Content-Type': 'application/json' },
      body: JSON.stringify({
        model,
        messages: [{ role: 'user', content: prompt }],
        temperature: 0,
        response_format: { type: 'json_object' },
      }),
    });
    if (!res.ok) return null;
    const data = (await res.json()) as { choices?: { message?: { content?: string } }[] };
    const raw = data.choices?.[0]?.message?.content;
    if (!raw) return null;
    const parsed = JSON.parse(raw) as { title?: string; assignee_ids?: string[]; deadline?: string | null; kind?: string };

    // Модель могла выдумать id -- сверяем со справочником. Без этой проверки
    // адресатом стал бы несуществующий человек, и задача упала бы на валидации
    // уже в маршруте, потеряв текст.
    const known = new Set(people.map((p) => p.id));
    const ids = (parsed.assignee_ids ?? []).filter((id) => known.has(id));
    if (!parsed.title || ids.length === 0) return null;
    return {
      title: parsed.title.trim(),
      assigneeIds: ids,
      deadline: parsed.deadline ?? null,
      kind: parsed.kind === 'each' || parsed.kind === 'ack' ? parsed.kind : ids.length > 1 ? 'each' : 'single',
      source: 'llm',
      ambiguous: [],
    };
  } catch {
    return null;
  }
}

/**
 * Полный разбор: паттерны -> модель -> fallback.
 *
 * Fallback -- задача на самого себя с исходным текстом. Он существует, чтобы
 * разбор НИКОГДА не отвечал «не понимаю»: человек продиктовал мысль, и она
 * обязана превратиться хоть во что-то, что можно поправить руками.
 */
export async function parseTask(
  env: Env,
  text: string,
  people: Person[],
  selfId: string,
  timeZone: string,
  now: Date = new Date(),
): Promise<Draft> {
  const byPattern = parseByPattern(text, people, selfId, now, timeZone);
  if (byPattern && byPattern.ambiguous.length > 0) return byPattern;
  if (byPattern) return byPattern;

  const model = env.GROQ_LLM_MODEL || 'openai/gpt-oss-120b';
  const byLlm = env.GROQ_API_KEY ? await parseByLlm(env, text, people, model) : null;
  if (byLlm) return byLlm;

  return {
    title: text.trim().slice(0, 200) || 'Без названия',
    assigneeIds: [selfId],
    deadline: null,
    kind: 'single',
    source: 'fallback',
    ambiguous: [],
  };
}

/** Расшифровка голоса/видео. Groq принимает mp4 и ogg без перекодирования. */
export async function transcribe(env: Env, audio: Blob, filename: string): Promise<string | null> {
  if (!env.GROQ_API_KEY) return null;
  const form = new FormData();
  form.append('file', audio, filename);
  form.append('model', env.GROQ_STT_MODEL || 'whisper-large-v3-turbo');
  form.append('language', 'ru');
  form.append('response_format', 'json');
  try {
    const res = await fetch(`${GROQ}/audio/transcriptions`, {
      method: 'POST',
      headers: { Authorization: `Bearer ${env.GROQ_API_KEY}` },
      body: form,
    });
    if (!res.ok) return null;
    const data = (await res.json()) as { text?: string };
    return data.text?.trim() || null;
  } catch {
    return null;
  }
}
