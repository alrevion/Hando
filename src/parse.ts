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
import { pack } from './packs';

/** «пятница, 12 сентября, 18:00» в поясе организации. */
export function formatWhen(iso: string, timeZone: string): string {
  const d = new Date(iso);
  if (Number.isNaN(d.getTime())) return iso;
  const day = new Intl.DateTimeFormat('ru-RU', { timeZone, weekday: 'long', day: 'numeric', month: 'long' }).format(d);
  const time = new Intl.DateTimeFormat('ru-RU', { timeZone, hour: '2-digit', minute: '2-digit', hour12: false }).format(d);
  return `${day}, ${time}`;
}

export type Person = { id: string; name: string; aliases?: string[] };

export type Draft = {
  title: string;
  /** Через сколько МИНУТ задача возвращается. null -- разовая. */
  repeatMin?: number | null;
  /** Пункты списка, если фраза их перечисляет. */
  checklist?: string[] | null;
  /** Подробности сверх темы: их отделяет модель, см. splitTitle. */
  description?: string | null;
  assigneeIds: string[];
  deadline: string | null;
  /** Важность из самой фразы; medium -- когда о ней не сказали. */
  priority: 'urgent' | 'medium' | 'low';
  /** Названа ли важность словами. Если нет -- черновик предложит кнопки. */
  priorityExplicit: boolean;
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

/** Формы, по которым можно назвать человека: имя, фамилия, целиком, прозвища. */
function nameForms(p: Person): string[] {
  return [p.name, ...p.name.split(/\s+/).filter(Boolean), ...(p.aliases ?? [])];
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
    // Имя сравнивается ПО ЧАСТЯМ, а не целиком.
    //
    // Раньше сравнение шло с «Азиз Каримов» как с одним словом: пробел
    // выбрасывался, основой становилось «азизкаримо», и «Азизу» не совпадало
    // НИ С КЕМ. В тестах этого не было видно -- там имена односложные
    // («Азиз»), -- а в проде у всех имя и фамилия, и по имени не находился
    // вообще никто: каждое поручение молча уезжало автору.
    const hits = people.filter((p) => nameForms(p).some((n) => stemMatches(word, n)));
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

/**
 * Запоминает слово, которым человека назвали в поправке.
 *
 * Правка «не Азизу, а Беку» проходит через модель ровно потому, что «Беку» не
 * совпало ни с «Бекзод», ни с его фамилией. Модель сказала, кто это, -- значит
 * следующий раз можно обойтись без неё: слово ложится в псевдонимы человека, и
 * дальше его ловят правила. Это и есть «первый случай -- новый, остальные из
 * памяти», только без всякой векторной базы.
 *
 * Правило намеренно узкое: учим, ТОЛЬКО когда после вычёркивания известных слов
 * осталось ровно одно непонятое. Два кандидата -- уже догадка, а поручение, ушедшее
 * не тому, дороже несохранённого прозвища.
 *
 * ponytail: форма запоминается как сказана («беку»), склонения множатся отдельными
 * строками. Приводить к основе -- отдельная работа, она нужна, только если список
 * начнёт упираться в потолок.
 */
export async function learnAlias(env: Env, correction: string, people: Person[], assigneeId: string): Promise<string | null> {
  const clean = correction.replace(LEAD_NOISE, '').trim();
  const who = matchPeople(clean, people);
  // Человека уже узнали правилами -- учить нечему.
  if (who.ids.includes(assigneeId)) return null;

  // Обе стороны чистятся ОДИНАКОВО: matchPeople кладёт в usedWords слово как
  // есть, вместе с запятой, и «азизу,» не совпало бы с «азизу» -- вычеркнутое
  // имя вернулось бы вторым кандидатом, и учить было бы нечего.
  const bare = (w: string) => w.toLowerCase().replace(/^[^а-яёa-z0-9]+|[^а-яёa-z0-9]+$/gi, '');
  const known = new Set([...who.usedWords].map(bare));
  const rest = clean.split(/\s+/)
    .map(bare)
    .filter((w) => w.length >= 2 && w.length <= 20 && !/\d/.test(w) && !known.has(w) && !ALIAS_NOISE.test(w));
  const uniq = [...new Set(rest)];
  if (uniq.length !== 1) return null;

  const alias = uniq[0];
  const row = await env.DB.prepare('SELECT aliases FROM users WHERE id = ?').bind(assigneeId).first<{ aliases: string | null }>();
  let list: string[] = [];
  try { list = row?.aliases ? (JSON.parse(row.aliases) as string[]) : []; } catch { list = []; }
  if (list.some((a) => a.toLowerCase() === alias)) return null;
  // Потолок -- чтобы список не рос вечно от опечаток: новое вытесняет старое.
  const next = [...list, alias].slice(-10);
  await env.DB.prepare('UPDATE users SET aliases = ? WHERE id = ?').bind(JSON.stringify(next), assigneeId).run();
  return alias;
}

// Слова поправки, которые прозвищем быть не могут.
const ALIAS_NOISE = /^(?:не|а|и|это|тогда|лучше|вместо|давай|пусть|поручи|поручить|назначь|переназначь|отдай|передай|him|её|его|ему|ей|там|же|то|но|да|нет|надо|нужно|срок|важно|важность|задача|поручение)$/i;

// ------------------------------------------------------------------ сроки

// Полное слово ИЛИ сокращение. Сокращения обязаны стоять за границами слова:
// без них «ср» совпало бы внутри «срочно» и «сроки», а «вс» -- внутри «всё».
// Индекс массива -- номер дня недели у getUTCDay().
// Родительный падеж: «2 октября», «до 15 марта». Индекс + 1 = номер месяца.
const MONTHS_GEN = ['января', 'февраля', 'марта', 'апреля', 'мая', 'июня', 'июля', 'августа', 'сентября', 'октября', 'ноября', 'декабря'];

// «к трём», «до пяти вечера», «к часу». Голос почти всегда даёт числительное
// словом, а не цифрой -- без этого «завтра до трёх часов дня» теряло время.
const HOUR_WORDS: Record<string, number> = {
  'часу': 1, 'одного': 1, 'двух': 2, 'трёх': 3, 'трех': 3, 'четырёх': 4, 'четырех': 4,
  'пяти': 5, 'шести': 6, 'семи': 7, 'восьми': 8, 'девяти': 9, 'десяти': 10,
  'одиннадцати': 11, 'двенадцати': 12,
};

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

/**
 * Разбор момента на местные Y/M/D/h/m/s в заданном поясе.
 *
 * Через Intl, а не через new Date(toLocaleString(...)): прежний круг «строка
 * местного времени -> Date» зависел от пояса САМОГО рантайма -- локально тесты
 * идут в Asia/Tashkent, и преобразование было пустой операцией, а в проде
 * воркер идёт в UTC, где тот же код ведёт себя иначе.
 */
function localParts(at: Date, timeZone: string) {
  const f = new Intl.DateTimeFormat('en-CA', {
    timeZone, year: 'numeric', month: '2-digit', day: '2-digit',
    hour: '2-digit', minute: '2-digit', second: '2-digit', hour12: false,
  });
  const o = Object.fromEntries(f.formatToParts(at).map((x) => [x.type, x.value])) as Record<string, string>;
  return { y: +o.year, m: +o.month, d: +o.day, h: +o.hour % 24, mi: +o.minute, s: +o.second };
}

/** Смещение пояса НА ЭТОТ момент: стенные часы минус мировое время. */
function offsetMsAt(at: Date, timeZone: string): number {
  const p = localParts(at, timeZone);
  return Date.UTC(p.y, p.m - 1, p.d, p.h, p.mi, p.s) - at.getTime();
}

/**
 * Местные год/месяц/день/час в поясе организации -> настоящий момент (ISO).
 *
 * Смещение берётся на приблизительный момент и затем уточняется: у поясов с
 * переводом часов смещение до и после полуночи может отличаться.
 */
export function localIso(y: number, m: number, d: number, hour: number, timeZone: string): string {
  const wall = Date.UTC(y, m - 1, d, hour);
  const rough = new Date(wall - offsetMsAt(new Date(wall), timeZone));
  return new Date(wall - offsetMsAt(rough, timeZone)).toISOString();
}

/** Сегодняшняя местная дата в поясе организации. */
export function localToday(now: Date, timeZone: string): { y: number; m: number; d: number } {
  const p = localParts(now, timeZone);
  return { y: p.y, m: p.m, d: p.d };
}

export function matchDeadline(
  text: string, now: Date, timeZone: string,
  /** Конец дня для «до завтра»/«в пятницу»: конец рабочего дня организации, у 24/7 -- 23:59. */
  dayEnd = '18:00',
  /** Последний рабочий день недели (1=пн..7=вс): «в конце недели» -- это он. */
  weekEnd = 5,
): { iso: string | null; usedWords: Set<string> } {
  const used = new Set<string>();
  const lower = text.toLowerCase();

  const parts = (at: Date) => localParts(at, timeZone);
  const today = parts(now);
  // Полночь местного дня, выраженная в UTC-мерах: с ней удобно считать «+N дней».
  const midnight = new Date(Date.UTC(today.y, today.m - 1, today.d));

  /** Местные Y/M/D + час -> настоящий момент времени. */
  // Объявлено ДО замыкания at: оно читает эту переменную при вызове.
  let hardEnd: string | null = null;
  const at = (d: Date, hour?: number) => {
    const [h, mi] = hour === undefined ? (hardEnd ?? dayEnd).split(':').map(Number) : [hour, 0];
    const iso = localIso(d.getUTCFullYear(), d.getUTCMonth() + 1, d.getUTCDate(), h, timeZone);
    return mi ? new Date(Date.parse(iso) + mi * 60000).toISOString() : iso;
  };
  const mark = (...ws: string[]) => ws.forEach((w) => used.add(w));

  let base: Date | null = null;
  // «ДО завтра» -- это СЕГОДНЯ до конца суток, а не завтрашний день.
  //
  // Предлог здесь меняет смысл на противоположный: «сдать до завтра» значит
  // «успеть, пока не наступило завтра». Разбор ставил срок на завтрашний
  // вечер, то есть давал лишние сутки на то, что просили сегодня. Час
  // принудительно 23:59, а не конец рабочего дня: именно в полночь наступает
  // то самое «завтра», до которого просили успеть.
  // Порядок важен: «послезавтра» содержит «завтра» как подстроку.
  if (word('сегодня').test(lower)) { base = midnight; mark('сегодня'); }
  else if (word('послезавтра').test(lower)) { base = new Date(midnight.getTime() + 2 * 864e5); mark('послезавтра'); }
  else if (/(?:^|[\s,.;:!?«»"'()-])до\s+завтра(?=$|[\s,.;:!?«»"'()-])/i.test(lower)) {
    base = midnight; hardEnd = '23:59'; mark('до', 'завтра');
  }
  else if (word('завтра').test(lower)) { base = new Date(midnight.getTime() + 864e5); mark('завтра'); }

  // СРОК-ОКОШКО: «в течение недели», «до конца месяца», «на этой неделе».
  //
  // Раньше такая фраза не совпадала ни с чем, и задача рождалась БЕЗ срока --
  // то есть без единого напоминания, хотя человек срок назвал. «В течение
  // недели» -- это обещание успеть до её конца, поэтому берётся последний
  // момент окна, а не середина: раньше напомнить можно, позже -- уже поздно.
  if (!base) {
    // Два оборота, а не один: «в течение/до конца/за» принимают и дни, и
    // недели, и месяцы, а голое «на» -- только недели и месяцы. «На день» в
    // речи почти всегда не срок («на день рождения»), а «на неделе» -- срок.
    const win = lower.match(
      /(?:в\s+течени[ея]|до\s+конца|за)\s+(?:(\d+|дв[ае]|двух|тр[иёе]х?|четыр[её]х?|пят[иь]|пар[ыу])\s+)?(дня|дней|день|недел[а-яё]*|месяц[а-яё]*)/i,
    ) ?? lower.match(
      /на\s+(?:эт[а-яё]+\s+)?()(недел[а-яё]*|месяц[а-яё]*)/i,
    );
    if (win) {
      const WORDS: Record<string, number> = {
        два: 2, две: 2, двух: 2, три: 3, трёх: 3, трех: 3, трие: 3,
        четыре: 4, четырёх: 4, четырех: 4, пять: 5, пяти: 5, пары: 2, пару: 2,
      };
      const count = WORDS[win[1] ?? ''] ?? (win[1] ? Number(win[1]) : 1);
      const unit = win[2].toLowerCase();
      if (unit.startsWith('месяц')) {
        // Конец месяца -- нулевой день следующего, то есть его последний день.
        const d = new Date(Date.UTC(today.y, today.m - 1 + count, 0));
        base = d;
      } else if (unit.startsWith('недел')) {
        // Одна неделя без числа -- ближайшая пятница, как кнопка «В конце
        // недели». Две и больше -- ровно столько недель вперёд.
        // Конец недели -- последний РАБОЧИЙ день организации, а не всегда
        // пятница: у семьи с графиком 24/7 это воскресенье, у магазина
        // суббота. weekEnd приходит 1..7, индекс от понедельника -- на единицу
        // меньше.
        base = count > 1
          ? new Date(midnight.getTime() + count * 7 * 864e5)
          : new Date(midnight.getTime() + ((weekEnd - 1 - ((midnight.getUTCDay() + 6) % 7) + 7) % 7) * 864e5);
      } else {
        base = new Date(midnight.getTime() + (count - 1) * 864e5);
      }
      mark(...win[0].split(/\s+/));
    }
  }

  if (!base) {
    const days = lower.match(/через\s+(\d+)\s*(дн|день|дня|недел)[а-яё]*/i);
    if (days) {
      const n = Number(days[1]) * (days[2].startsWith('недел') ? 7 : 1);
      base = new Date(midnight.getTime() + n * 864e5);
      mark(...days[0].split(/\s+/));
    }
  }

  if (!base) {
    // «2 октября», «до 15 марта», «к 2 октября 2026 года». Год необязателен:
    // без него берётся ближайший такой день вперёд -- дата, которая в этом
    // году уже прошла, означает следующий год.
    const m = lower.match(new RegExp(
      `(?:(?:до|к|на|в)\\s+)?(\\d{1,2})(?:-?го)?\\s+(${MONTHS_GEN.join('|')})(?:\\s+(\\d{4})(?:\\s*г(?:ода|\\.)?)?)?`, 'i'));
    if (m) {
      const day = Number(m[1]);
      const month = MONTHS_GEN.indexOf(m[2].toLowerCase()) + 1;
      const year = m[3] ? Number(m[3]) : today.y;
      let d = new Date(Date.UTC(year, month - 1, day));
      if (!m[3] && d < midnight) d = new Date(Date.UTC(year + 1, month - 1, day));
      base = d;
      mark(...m[0].split(/\s+/));
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

  // Время суток, если названо: «к 9 утра», «в 15:00», «до трёх часов дня».
  // Отрицательный просмотр вперёд: «до 5-го числа» и «до 2 октября» -- это
  // ДАТЫ, а не пять и два часа утра; раньше они давали срок 05:00 и 02:00.
  const time = lower.match(new RegExp(
    `(?:^|\\s)(?:в|к|до)\\s+(\\d{1,2}|${Object.keys(HOUR_WORDS).join('|')})(?::(\\d{2}))?` +
    `(?![-\\s]*(?:го|числ|${MONTHS_GEN.join('|')}))\\s*(?:час[а-яё]*)?\\s*(утра|дня|вечера|ночи)?`, 'i'));

  // Время без даты -- это сегодня; если сегодня уже прошло -- завтра.
  const dateSaid = base !== null;
  if (!base && time) base = midnight;
  if (!base) return { iso: null, usedWords: used };

  if (time) {
    const byWord = !/^\d/.test(time[1]);
    let h = byWord ? HOUR_WORDS[time[1].toLowerCase()] : Number(time[1]);
    const q = time[3]?.toLowerCase();
    if ((q === 'вечера' || q === 'дня') && h < 12) h += 12;
    // «к трём» и «к 3» без уточнения в рабочем разговоре -- это 15:00, а не
    // три ночи; «в 3:30» с минутами -- тоже. Утро называют словом: «в 6 утра».
    else if (!q && h >= 1 && h <= 6) h += 12;
    if (h >= 0 && h <= 23) {
      mark(...time[0].trim().split(/\s+/));
      const minute = Number(time[2] ?? 0);
      const wall = Date.UTC(base.getUTCFullYear(), base.getUTCMonth(), base.getUTCDate(), h, minute);
      let iso = localIso(
        new Date(wall).getUTCFullYear(), new Date(wall).getUTCMonth() + 1, new Date(wall).getUTCDate(),
        h, timeZone,
      );
      // Минуты у «в 15:30» дописываются к часу, посчитанному в поясе.
      iso = new Date(new Date(iso).getTime() + minute * 60000).toISOString();
      if (!dateSaid && new Date(iso) < now) iso = new Date(new Date(iso).getTime() + 864e5).toISOString();
      return { iso, usedWords: used };
    }
  }
  return { iso: at(base), usedWords: used };
}

// ------------------------------------------------------------------ слой паттернов

// Служебное начало фразы: «напомни, что…», «нужно, чтобы…», «поставь задачу…».
// Это не суть поручения, а способ его сказать, и в названии оно не нужно.
const LEAD_NOISE = /^(?:(?:пожалуйста|слушай|короче|так|ну|и|а|запиши(?:те)?|поставь(?:те)? задачу|напомни(?:те)?(?: мне)?|напомню)[,\s]+(?:что\s+)?)+/i;

// ВАЖНО про регулярки ниже: в JS `\b` и `\w` определены ЧЕРЕЗ ASCII, поэтому
// `\bзавтра\b` не совпадает НИКОГДА, а `пятниц\w*` обрывается на «ы».
// Границы слова задаются явно: начало строки, пробел или знак препинания.
const B = '(?:^|[\\s,.;:!?«»"\'()-])';
const E = '(?=$|[\\s,.;:!?«»"\'()-])';
const word = (alts: string) => new RegExp(`${B}(?:${alts})${E}`, 'i');

const SELF = word('мне|себе|я');

// СРОЧНОСТЬ ИЗ СЛОВ. Порядок проверки обязателен: «не срочно» содержит
// «срочно» как подстроку, и при обратном порядке всё несрочное стало бы
// срочным. Поэтому сначала ищем понижение, и только потом повышение.
const LOW_WORDS = word('несроч[а-яё]*|потом|когда будет время|при случае|не горит|низк[а-яё]* приоритет[а-яё]*');
const NOT_URGENT = /(?:^|[\s,.;:!?«»"'()-])не\s+срочн[а-яё]*/i;
const URGENT_WORDS = word('срочн[а-яё]*|сроч[а-яё]*|горит|немедленно|как можно скорее|асап|asap|очень важн[а-яё]*');

/**
 * Словари отрасли поверх базовых. Собираются ОДИН РАЗ на профиль и кэшируются:
 * regexp'ы строятся из данных packs.ts, а границы слова навешивает та же
 * word(), что и базовым словарям -- значит ловушка «ср» внутри «срочно»
 * закрыта для отраслевых слов тем же кодом, а не второй его копией.
 */
const PACK_RE = new Map<string, { urgent: RegExp | null; low: RegExp | null; ack: RegExp | null }>();
function packRe(packId: string | null | undefined) {
  const p = pack(packId);
  let built = PACK_RE.get(p.id);
  if (!built) {
    built = {
      urgent: p.urgent?.length ? word(p.urgent.join('|')) : null,
      low: p.low?.length ? word(p.low.join('|')) : null,
      ack: p.ack?.length ? word(p.ack.join('|')) : null,
    };
    PACK_RE.set(p.id, built);
  }
  return built;
}

/**
 * Срочность из фразы и слова, которые её задали.
 *
 * Слова возвращаются, чтобы вычеркнуть их из заголовка: «срочно позвонить в
 * банк» -- это задача «позвонить в банк» со срочностью, а не задача с этим
 * словом в названии.
 */
export function matchPriority(text: string, packId?: string | null): { priority: Draft['priority']; usedWords: Set<string> } {
  const extra = packRe(packId);
  const used = new Set<string>();
  const mark = (m: RegExpMatchArray | null) => {
    if (!m) return;
    for (const w of m[0].split(/\s+/)) {
      const clean = w.replace(/^[^а-яёa-z0-9]+|[^а-яёa-z0-9]+$/gi, '');
      if (clean) used.add(clean);
    }
  };

  const notUrgent = text.match(NOT_URGENT);
  if (notUrgent) {
    mark(notUrgent);
    return { priority: 'low', usedWords: used };
  }
  // Понижение проверяется раньше повышения и в отраслевом словаре тоже:
  // «на выходных» не должно проиграть слову «горит» из другой части фразы.
  const low = text.match(LOW_WORDS) ?? (extra.low ? text.match(extra.low) : null);
  if (low) {
    mark(low);
    return { priority: 'low', usedWords: used };
  }
  const urgent = text.match(URGENT_WORDS) ?? (extra.urgent ? text.match(extra.urgent) : null);
  if (urgent) {
    mark(urgent);
    return { priority: 'urgent', usedWords: used };
  }
  return { priority: 'medium', usedWords: used };
}
const ACK_MARKERS = word('ознаком[а-яё]*|прочит[а-яё]*|прочти|к сведению|довед[а-яё]*|объявлени[а-яё]*|приказ[а-яё]*');

/**
 * Заголовок из фразы: вычёркиваем всё, что уже стало отдельным полем.
 *
 * Общий для разбора паттернами и для запасного пути. Раньше запасной путь
 * оставлял фразу как есть, и в списке висело «не срочно разобрать архив» --
 * слово про срочность уже уехало в поле, а из названия его никто не убрал.
 */
function buildTitle(text: string, used: Set<string>[]): string {
  const drop = new Set(used.flatMap((set) => [...set].map((w) => w.toLowerCase())));
  return text
    .split(/\s+/)
    // Предлоги НЕ выкидываются огулом: «в банк» -- часть сути поручения. Те,
    // что относились к сроку («до пятницы»), уже вычеркнуты как слова даты.
    .filter((w) => !drop.has(w.toLowerCase().replace(/^[^а-яёa-z0-9]+|[^а-яёa-z0-9]+$/gi, ''))
      && !/^(?:напомни|напомню|поручи|скажи|передай|мне|себе|я|нужно|надо|необходимо|чтобы)$/i.test(w))
    .join(' ')
    .replace(/\s+/g, ' ')
    // Вычеркнутое слово оставляет за собой предлог: «подготовить кабинет к
    // проверке» -> «Подготовить кабинет к». Предлог без своего слова не значит
    // ничего, поэтому хвостовой убираем. Внутри фразы предлоги не трогаем --
    // «позвонить в банк» обязано остаться целым.
    .replace(/\s+(?:в|во|на|к|ко|до|за|из|от|по|с|со|у|при|для|об?)$/i, '')
    .trim();
}

/**
 * Разбор паттернами. null -- не хватило уверенности, дальше решает модель.
 *
 * Уверенность требуется в АДРЕСАТЕ: задача без исполнителя бессмысленна, а
 * угадывать его нельзя. Срок необязателен -- поручения без срока нормальны.
 */
export function parseByPattern(text: string, people: Person[], selfId: string, now: Date, timeZone: string, packId?: string | null, dayEnd?: string, weekEnd?: number): Draft | null {
  const clean = text.replace(LEAD_NOISE, '').trim();
  const { ids, ambiguous, usedWords } = matchPeople(clean, people);
  const { iso, usedWords: dateWords } = matchDeadline(clean, now, timeZone, dayEnd, weekEnd);
  const { priority, usedWords: priorityWords } = matchPriority(clean, packId);
  const repeat = matchRepeat(clean);

  // «напомни мне завтра...» -- поручение себе. Оно же личный слой: адресат
  // совпадает с автором, отдельной сущности для этого нет по замыслу.
  // Неоднозначность проверяется ПЕРВОЙ. Прежде она стояла после выхода по
  // «адресата нет» -- а при двух подходящих людях адресатов как раз ноль, и до
  // переспроса управление не доходило: фраза уезжала в модель, та тоже не могла
  // выбрать, и задача молча создавалась на самого автора.
  if (ambiguous.length > 0) {
    return { title: '', assigneeIds: [], deadline: iso, priority, priorityExplicit: priorityWords.size > 0, kind: 'single', source: 'pattern', ambiguous };
  }

  // Адресат не назван, но назван СРОК -- это напоминание себе: «сдать отчёт в
  // пятницу». Ровно то, ради чего человек пишет боту в личку, и то, из-за чего
  // раньше фраза уезжала в модель: та возвращала пустоту, и оставался сырой
  // текст без срока -- то есть без напоминания вообще.
  // ПОВТОР -- такой же признак поручения себе, как срок. «Цветы поливать через
  // день» человек говорит про себя, и без этого условия фраза уезжала в модель,
  // а оттуда возвращалась темой во всю длину.
  const isSelf = ids.length === 0 && (SELF.test(clean) || iso !== null || repeat.days !== null);
  const assignees = isSelf ? [selfId] : ids;
  if (assignees.length === 0) return null; // ни адресата, ни срока -- решает модель

  // Заголовок -- то, что осталось: убираем имена, слова даты и служебные слова.
  const title = buildTitle(clean, [usedWords, dateWords, priorityWords, repeat.usedWords]);
  if (title.length < 3) return null; // осталась пустота -- это не поручение

  return {
    title: title[0].toUpperCase() + title.slice(1),
    repeatMin: repeat.days === null ? null : repeat.days * 1440,
    assigneeIds: assignees,
    deadline: iso,
    priority,
    priorityExplicit: priorityWords.size > 0,
    // «Ознакомиться» в отрасли называется по-своему: приказ, инструктаж по ТБ,
    // техкарта, стоп-лист. Базовый словарь и отраслевой равноправны.
    kind: ACK_MARKERS.test(clean) || packRe(packId).ack?.test(clean) ? 'ack' : assignees.length > 1 ? 'each' : 'single',
    source: 'pattern',
    ambiguous: [],
  };
}

// ------------------------------------------------------------------ нейросеть

const GROQ = 'https://api.groq.com/openai/v1';

/** Разбор моделью. null -- сеть не ответила; вызывающий отдаёт fallback. */
export async function parseByLlm(env: Env, text: string, people: Person[], model: string, packId?: string | null, selfId?: string): Promise<Draft | null> {
  const roster = people.map((p) => `${p.id}=${p.name}`).join('; ');
  const prompt = [
    'Разбери поручение в JSON. Отвечай ТОЛЬКО JSON, без пояснений.',
    'Поля: title (суть поручения: 2-6 слов, повелительная форма, без имён, дат и слов о важности -- «Подготовить отчёт», а не «Артуру нужно подготовить отчёт до пятницы»), description (остальные подробности из фразы одной-двумя фразами, или пустая строка), assignee_ids (массив id из списка), deadline (ISO 8601 или null), kind ("single"|"each"|"ack").',
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
    const parsed = JSON.parse(raw) as { title?: string; description?: string; assignee_ids?: string[]; deadline?: string | null; kind?: string };

    // Модель могла выдумать id -- сверяем со справочником. Без этой проверки
    // адресатом стал бы несуществующий человек, и задача упала бы на валидации
    // уже в маршруте, потеряв текст.
    const known = new Set(people.map((p) => p.id));
    const named = (parsed.assignee_ids ?? []).filter((id) => known.has(id));
    // Адресата не назвали -- значит себе. Прежде такая фраза («нужно сходить в
    // комитет») возвращала null и уезжала в запасной путь, а тот кладёт ВСЮ
    // фразу в тему: ровно то, на что жаловались -- «всё уходит в тему».
    const ids = named.length > 0 ? named : selfId ? [selfId] : [];
    if (!parsed.title || ids.length === 0) return null;
    return {
      title: parsed.title.trim(),
      description: parsed.description?.trim() || null,
      assigneeIds: ids,
      deadline: parsed.deadline ?? null,
      // Модель о важности не спрашивается: словарь надёжнее и дешевле.
      priority: matchPriority(text, packId).priority,
      priorityExplicit: matchPriority(text, packId).usedWords.size > 0,
      kind: parsed.kind === 'each' || parsed.kind === 'ack' ? parsed.kind : ids.length > 1 ? 'each' : 'single',
      source: 'llm',
      ambiguous: [],
    };
  } catch {
    return null;
  }
}

/**
 * Повторяемость из фразы: «через день», «каждый день», «еженедельно».
 *
 * Числом дней, а не расписанием: вслух люди говорят именно так, а cron-строка
 * для «поливать цветы через день» -- инструмент не по размеру задачи.
 * Возвращает и слова, которые нужно вычесть из темы: без этого «поливать цветы
 * через день» осталось бы темой целиком.
 */
export function matchRepeat(text: string): { days: number | null; usedWords: Set<string> } {
  const lower = text.toLowerCase();
  const used = new Set<string>();
  const take = (m: RegExpMatchArray, days: number) => {
    m[0].trim().split(/\s+/).forEach((w) => used.add(w));
    return { days: Math.max(1, days), usedWords: used };
  };
  // Число словом или цифрой: вслух чаще говорят «раз в три дня», чем «каждые 3».
  const N: Record<string, number> = {
    один: 1, одну: 1, два: 2, две: 2, двух: 2, три: 3, трое: 3, трёх: 3, трех: 3,
    четыре: 4, четырёх: 4, четырех: 4, пять: 5, пяти: 5, шесть: 6, семь: 7, десять: 10, четырнадцать: 14,
  };
  const num = (w: string | undefined): number => (w ? (N[w] ?? (Number(w) || 1)) : 1);
  const COUNT = String.raw`\d+|один|одну|дв[ае]|двух|тр[иоё]е?|трёх|трех|четыре|четыр[её]х|пят[иь]|шесть|семь|десять|четырнадцать`;

  // «каждые 3 дня», «раз в три дня», «через каждые два дня».
  const nDays = lower.match(new RegExp(String.raw`(?:кажд[а-яё]+|раз\s+в|через)\s+(${COUNT})\s*(?:дн[а-яё]*|день|сут[а-яё]+)`, 'i'));
  if (nDays) return take(nDays, num(nDays[1]));
  const nWeeks = lower.match(new RegExp(String.raw`(?:кажд[а-яё]+|раз\s+в|через)\s+(${COUNT})\s*недел[а-яё]*`, 'i'));
  if (nWeeks) return take(nWeeks, num(nWeeks[1]) * 7);
  const nMonths = lower.match(new RegExp(String.raw`(?:кажд[а-яё]+|раз\s+в|через)\s+(${COUNT})\s*месяц[а-яё]*`, 'i'));
  if (nMonths) return take(nMonths, num(nMonths[1]) * 30);

  // Без числа: «через день» -- это раз в два дня, «каждый день» -- раз в день.
  const every2 = lower.match(/(?:^|[\s,])через\s+день/i);
  if (every2) return take(every2, 2);
  const daily = lower.match(/(?:^|[\s,])(?:кажд[ыои][йе]\s+день|ежедневно|каждодневно|раз\s+в\s+день|ежесуточно)/i);
  if (daily) return take(daily, 1);
  const weekly = lower.match(/(?:^|[\s,])(?:кажд[уы][юе]\s+недел[юя]|еженедельно|раз\s+в\s+неделю)/i);
  if (weekly) return take(weekly, 7);
  const monthly = lower.match(/(?:^|[\s,])(?:кажд[ыи][йе]\s+месяц|ежемесячно|раз\s+в\s+месяц)/i);
  if (monthly) return take(monthly, 30);
  return { days: null, usedWords: used };
}

/** Тема длиннее этого -- уже не тема, а пересказ фразы. Шесть слов. */
const TITLE_WORDS = 6;

/**
 * Делит длинную тему на короткую тему и содержание.
 *
 * Паттерны и запасной путь собирают тему ВЫЧИТАНИЕМ: из фразы убираются имена,
 * даты и служебные слова, а остаток целиком становится темой. На фразе в
 * двадцать слов остаток -- те же двадцать слов минус пяток, и в списке такая
 * задача нечитаема. Модель здесь делает единственное, чего вычитание не умеет:
 * называет СУТЬ и отправляет подробности в отдельное поле.
 *
 * Не срабатывает -- возвращаем как было: длинная тема хуже короткой, но лучше
 * отказа разобрать.
 */
/**
 * «Мои», «мне», «у меня» в поручении ДРУГОМУ человеку.
 *
 * Автор говорит от себя, а читает адресат: «мои цветы поливать» превращается у
 * него в загадку -- чьи. Слово от первого лица и есть признак, что фразу надо
 * переписать именем автора.
 */
const FIRST_PERSON = /(?<![а-яёa-zA-Z])(мо[йяёеи]|моих|моим|моег|моей|мне|меня|у\s+меня|нам|наш)/i;

export async function splitTitle(
  env: Env, title: string, model: string,
  /** Имя автора, если поручение НЕ себе: им заменяются «мои» и «мне». */
  authorName?: string | null,
): Promise<{ title: string; description: string | null; checklist?: string[] | null }> {
  const words = title.trim().split(/\s+/);
  // Перечисление -- тоже повод позвать модель, даже если фраза короткая:
  // «купить свёклу, морковь, молоко» это шесть слов и три пункта списка.
  const enumerated = (title.match(/,/g) ?? []).length >= 2;
  const firstPerson = !!authorName && FIRST_PERSON.test(title);
  if ((words.length <= TITLE_WORDS && !enumerated && !firstPerson) || !env.GROQ_API_KEY) return { title, description: null };
  const prompt = [
    'Раздели поручение на тему, содержание и список пунктов. Отвечай ТОЛЬКО JSON, без пояснений.',
    'title: суть, 2-5 слов, повелительная форма, без дат, имён и слов о важности.',
    'description: остальные подробности из фразы, одной-двумя фразами; пустая строка, если сверх темы ничего нет.',
    'items: массив строк, ЕСЛИ фраза перечисляет вещи, которые отмечают по одной (покупки, пункты повестки, что взять с собой). Каждый пункт 1-3 слова. Пустой массив, если перечисления нет.',
    ...(firstPerson
      ? [`Автор поручения -- ${authorName}, а читать его будет другой человек. Слова «мой», «моя», «мои», «мне», «у меня» замени именем автора в нужном падеже и поставь это в description, а не в title. Пример: «мои цветы поливать» от «Лариса Сергеевна» -> title «Поливать цветы», description «Поливать цветы Ларисы Сергеевны».`]
      : []),
    `Фраза: ${title}`,
  ].join('\n');
  try {
    const res = await fetch(`${GROQ}/chat/completions`, {
      method: 'POST',
      headers: { Authorization: `Bearer ${env.GROQ_API_KEY}`, 'Content-Type': 'application/json' },
      body: JSON.stringify({ model, messages: [{ role: 'user', content: prompt }], temperature: 0, response_format: { type: 'json_object' } }),
    });
    if (!res.ok) return { title, description: null };
    const data = (await res.json()) as { choices?: { message?: { content?: string } }[] };
    const raw = data.choices?.[0]?.message?.content;
    if (!raw) return { title, description: null };
    const parsed = JSON.parse(raw) as { title?: string; description?: string; items?: unknown };
    // Пункты берём даже когда тему сократить не удалось: список полезен сам по
    // себе. Два пункта -- уже список, один -- просто уточнение темы.
    const items = Array.isArray(parsed.items)
      ? parsed.items.filter((x): x is string => typeof x === 'string' && x.trim().length > 0).map((x) => x.trim().slice(0, 100)).slice(0, 30)
      : [];
    const checklist = items.length >= 2 ? items : null;
    const short = parsed.title?.trim();
    // Короче исходного и не пустая -- иначе модель просто вернула ту же фразу.
    if (!short || short.length < 3 || short.split(/\s+/).length >= words.length) return { title, description: null, checklist };
    return { title: short[0].toUpperCase() + short.slice(1), description: parsed.description?.trim() || null, checklist };
  } catch {
    return { title, description: null };
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
  /** Профиль организации: расширяет словари срочности и ознакомления. */
  packId?: string | null,
  /** Конец дня из графика организации. */
  dayEnd?: string,
  /** Последний рабочий день недели организации (1=пн..7=вс). */
  weekEnd?: number,
): Promise<Draft> {
  const model = env.GROQ_LLM_MODEL || 'openai/gpt-oss-120b';
  const byPattern = parseByPattern(text, people, selfId, now, timeZone, packId, dayEnd, weekEnd);
  if (byPattern && byPattern.ambiguous.length > 0) return byPattern;
  // Имя автора нужно ТОЛЬКО когда поручают другому: себе «мои цветы» -- это
  // нормально и переписывать нечего.
  const authorName = people.find((p) => p.id === selfId)?.name ?? null;
  const forOther = (ids: string[]) => (ids.some((id) => id !== selfId) ? authorName : null);
  if (byPattern) return { ...byPattern, ...(await splitTitle(env, byPattern.title, model, forOther(byPattern.assigneeIds))) };

  const byLlm = env.GROQ_API_KEY ? await parseByLlm(env, text, people, model, packId, selfId) : null;
  if (byLlm) return byLlm;

  // Даже на запасном пути слово про срочность не должно остаться в названии:
  // оно уже стало полем, и в списке читалось бы дважды.
  const { priority, usedWords: priorityWords } = matchPriority(text, packId);
  const bare = buildTitle(text.trim(), [priorityWords]);
  const raw = (bare.length >= 3 ? bare[0].toUpperCase() + bare.slice(1) : text.trim()).slice(0, 200) || 'Без названия';
  return {
    // Запасной путь -- всегда задача себе, так что переписывать «мои» не надо.
    ...(await splitTitle(env, raw, model)),
    assigneeIds: [selfId],
    deadline: null,
    priority,
    priorityExplicit: priorityWords.size > 0,
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
  // Полная large-v3, а не turbo: turbo -- урезанный декодер, и на языках вне
  // первой десятки (узбекский) он ошибается заметно чаще. Секунда задержки
  // дешевле, чем поручение с перевранным именем.
  form.append('model', env.GROQ_STT_MODEL || 'whisper-large-v3');
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


// ------------------------------------------------------------ правка черновика

export type DraftFields = {
  title: string;
  assigneeIds: string[];
  deadline: string | null;
  priority: Draft['priority'];
  priorityExplicit: boolean;
};

// Слова, которыми люди ПРАВЯТ, а не диктуют заново: «Ивия -- это Ева», «не
// пятница, а вторник», «замени срок». Такая поправка меняет одно поле и никогда
// не становится новой темой -- без этого «Ивия это Ева» превратилось бы в
// поручение с темой «Ивия это».
const EDIT_MARKERS = /(?:^|[\s,])(?:это|вместо|не\s+\S+,?\s+а|замени[а-яё]*|исправ[а-яё]*|поменя[а-яё]*|измени[а-яё]*|пусть будет)(?:$|[\s,])/i;

/**
 * Поправка к черновику -- частичное обновление полей.
 *
 * Сначала то, что распознаётся само: имя, срок, важность. Затем модель, если
 * ключ есть: она понимает «Ивия -- это Ева» и «тема не та, надо «сдать отчёт»».
 * Без модели: имя/срок/важность из поправки заменяют свои поля, а если человек
 * просто прислал всю фразу заново (есть имя и есть суть) -- заменяется всё.
 */
export async function refineDraft(
  env: Env,
  current: DraftFields,
  correction: string,
  people: Person[],
  timeZone: string,
  packId?: string | null,
  now: Date = new Date(),
  dayEnd?: string,
  weekEnd?: number,
): Promise<Partial<DraftFields>> {
  const clean = correction.replace(LEAD_NOISE, '').trim();
  // «не Азизу, а Беку»: тот, кто после «не», -- прежний адресат, его ищем
  // НЕ надо, иначе черновик получил бы обоих.
  const who = matchPeople(clean.replace(/(?:^|\s)не\s+\S+,?(?=\s+а\s)/i, ' '), people);
  const when = matchDeadline(clean, now, timeZone, dayEnd, weekEnd);
  const pri = matchPriority(clean, packId);

  const patch: Partial<DraftFields> = {};
  if (who.ids.length > 0 && who.ambiguous.length === 0) patch.assigneeIds = who.ids;
  if (when.iso) patch.deadline = when.iso;
  if (pri.usedWords.size > 0) { patch.priority = pri.priority; patch.priorityExplicit = true; }

  // «Убери срок», «срок убери», «без срока» -- снять срок. Раньше такая фраза
  // не совпадала ни с одним признаком и уезжала в НАЗВАНИЕ: черновик получал
  // тему «Срок убери».
  if (!when.iso && /(?:убер[аи][а-яё]*|снят[ьи]|удал[а-яё]*)\s+срок|срок\s+(?:убер[аи][а-яё]*|снят[ьи]|не\s+нужен|не\s+надо)|без\s+срока/i.test(clean)) {
    patch.deadline = null;
  }

  // «Тема: купить бумагу», «поменяй тему на купить бумагу» -- новая тема без
  // имени и без срока. Слова-указатели съедаются, остаётся сама тема.
  const topic = clean.match(/(?:^|[\s,])(?:тем[ауы]|назван[а-яё]+|заголов[а-яё]+)\s*(?:поменя[а-яё]*|измени[а-яё]*|замени[а-яё]*)?\s*(?:на|:)?\s+(.{3,200})$/i)
    ?? clean.match(/(?:^|[\s,])(?:поменя[а-яё]*|измени[а-яё]*|замени[а-яё]*)\s+тем[ауы]\s*(?:на|:)?\s+(.{3,200})$/i);
  if (topic) {
    const t = topic[1].trim().replace(/^[«"']|[»"'.]$/g, '');
    if (t.length >= 3) patch.title = t[0].toUpperCase() + t.slice(1);
  }

  const rest = buildTitle(clean, [who.usedWords, when.usedWords, pri.usedWords]);
  const isEdit = EDIT_MARKERS.test(clean);
  // Полная фраза заново: назван человек, осталась суть, и это не «X -- это Y».
  if (!isEdit && who.ids.length > 0 && rest.split(' ').length >= 2) {
    patch.title = rest[0].toUpperCase() + rest.slice(1);
  }

  if (env.GROQ_API_KEY) {
    const byLlm = await refineByLlm(env, current, correction, people, env.GROQ_LLM_MODEL || 'openai/gpt-oss-120b');
    if (byLlm) return { ...patch, ...byLlm };
  }

  // Ничего не распозналось и это не правка -- значит человек переформулировал суть.
  if (Object.keys(patch).length === 0 && !isEdit && rest.length >= 3) {
    patch.title = rest[0].toUpperCase() + rest.slice(1);
  }
  return patch;
}

async function refineByLlm(
  env: Env,
  current: DraftFields,
  correction: string,
  people: Person[],
  model: string,
): Promise<Partial<DraftFields> | null> {
  const roster = people.map((p) => `${p.id}=${p.name}`).join('; ');
  const names = current.assigneeIds.map((id) => people.find((p) => p.id === id)?.name ?? id).join(', ');
  const prompt = [
    'Есть черновик поручения. Человек прислал поправку. Верни JSON ТОЛЬКО с полями, которые надо изменить; остальные не включай.',
    'Возможные поля: title (2-6 слов, повелительная форма, без имён и дат), assignee_ids (массив id из списка), deadline (ISO 8601 или null), priority ("urgent"|"medium"|"low").',
    `Черновик: title="${current.title}"; кому=${names || '—'}; deadline=${current.deadline ?? 'null'}; priority=${current.priority}.`,
    `Люди: ${roster}`,
    `Поправка: ${correction}`,
  ].join('\n');
  try {
    const res = await fetch(`${GROQ}/chat/completions`, {
      method: 'POST',
      headers: { Authorization: `Bearer ${env.GROQ_API_KEY}`, 'Content-Type': 'application/json' },
      body: JSON.stringify({ model, messages: [{ role: 'user', content: prompt }], temperature: 0, response_format: { type: 'json_object' } }),
    });
    if (!res.ok) return null;
    const data = (await res.json()) as { choices?: { message?: { content?: string } }[] };
    const raw = data.choices?.[0]?.message?.content;
    if (!raw) return null;
    const parsed = JSON.parse(raw) as { title?: string; assignee_ids?: string[]; deadline?: string | null; priority?: string };
    const out: Partial<DraftFields> = {};
    if (typeof parsed.title === 'string' && parsed.title.trim().length >= 3) out.title = parsed.title.trim();
    if (Array.isArray(parsed.assignee_ids)) {
      const known = new Set(people.map((p) => p.id));
      const ids = parsed.assignee_ids.filter((id) => known.has(id));
      if (ids.length > 0) out.assigneeIds = ids;
    }
    if (parsed.deadline === null || (typeof parsed.deadline === 'string' && !Number.isNaN(Date.parse(parsed.deadline)))) {
      if (parsed.deadline !== undefined) out.deadline = parsed.deadline;
    }
    if (parsed.priority === 'urgent' || parsed.priority === 'medium' || parsed.priority === 'low') {
      out.priority = parsed.priority;
      out.priorityExplicit = true;
    }
    return out;
  } catch {
    return null;
  }
}
