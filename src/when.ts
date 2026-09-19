// Срок и повтор -- из НАМЕРЕНИЯ, которое вернула модель.
//
// Модель описывает, что сказано: «через 2 дня утром», «каждый понедельник»,
// «после 12». Календарь считает код: модели плохо считают даты (в замерах
// длительности решались верно в 13-16% случаев, частая ошибка -- сдвиг на
// день), а у нас есть пояс, график и конец рабочего дня, которых она не знает.
import { localIso, localToday } from './parse';
import { dayEnd, hm, weekEndDay, type OrgSchedule } from './schedule';
import { MONTH_MIN } from './assignees';

export type Part = 'morning' | 'noon' | 'afternoon' | 'evening' | 'end_of_day';

export type When = {
  kind: 'in' | 'today' | 'tomorrow' | 'after_tomorrow' | 'weekday' | 'date' | 'day_of_month' | 'end_of_week' | 'end_of_month';
  amount: number | null;
  unit: 'minutes' | 'hours' | 'days' | 'weeks' | 'months' | null;
  /** 1 = понедельник ... 7 = воскресенье. */
  weekday: number | null;
  day: number | null;
  month: number | null;
  /** «15:30»; null -- по части дня или конец дня. */
  time: string | null;
  part: Part | null;
};

export type Repeat = {
  every: 'day' | 'week' | 'month' | 'n_days' | 'n_weeks';
  n: number | null;
  weekday: number | null;
  day: number | null;
  time: string | null;
  part: Part | null;
};

export type Sched = Pick<OrgSchedule, 'timezone' | 'always_on' | 'work_days' | 'work_end' | 'lunch_start' | 'quiet_from' | 'quiet_to'>;
type Ymd = { y: number; m: number; d: number };

const HHMM = /^([01]?\d|2[0-3]):([0-5]\d)$/;

/** Час дня: названный, по части дня или конец дня. «В обед» -- начало обеда по графику. */
function clock(w: { time: string | null; part: Part | null }, s: Sched): string {
  if (w.time && HHMM.test(w.time)) return w.time;
  switch (w.part) {
    case 'morning': return '09:00';
    case 'noon': return s.lunch_start ?? '13:00';
    case 'afternoon': return '15:00';
    case 'evening': return '19:00';
    default: return dayEnd(s as OrgSchedule);
  }
}

function at(day: Ymd, hhmm: string, tz: string): string {
  const mins = hm(hhmm);
  return new Date(Date.parse(localIso(day.y, day.m, day.d, Math.floor(mins / 60), tz)) + (mins % 60) * 60_000).toISOString();
}

function shift(t: Ymd, days: number): Ymd {
  const d = new Date(Date.UTC(t.y, t.m - 1, t.d) + days * 864e5);
  return { y: d.getUTCFullYear(), m: d.getUTCMonth() + 1, d: d.getUTCDate() };
}

/** День недели местной даты: 1 = пн ... 7 = вс. */
const weekdayOf = (t: Ymd) => ((new Date(Date.UTC(t.y, t.m - 1, t.d)).getUTCDay() + 6) % 7) + 1;

const lastDay = (y: number, m: number) => new Date(Date.UTC(y, m, 0)).getUTCDate();

/** Ближайшее число месяца: в этом месяце, если ещё не прошло, иначе в следующем. 31-е в сентябре -- 30-е. */
function nextDayOfMonth(t: Ymd, day: number, allowToday: boolean): Ymd {
  const clamp = (y: number, m: number) => ({ y, m, d: Math.min(day, lastDay(y, m)) });
  const here = clamp(t.y, t.m);
  // Сравнивается НАЗВАННОЕ число: «к 31-му», сказанное 30 сентября, -- это
  // 31 октября, а не сегодня, хотя сентябрьское 31-е и сжалось до 30-го.
  if (here.d > t.d || (allowToday && day === t.d)) return here;
  return t.m === 12 ? clamp(t.y + 1, 1) : clamp(t.y, t.m + 1);
}

/** Ближайший такой день недели. Сказанное в пятницу «в пятницу» -- следующая, как и в правилах. */
function nextWeekday(t: Ymd, weekday: number, allowToday: boolean): Ymd {
  const delta = (weekday - weekdayOf(t) + 7) % 7;
  return shift(t, delta === 0 && !allowToday ? 7 : delta);
}

export function resolveWhen(w: When | null, now: Date, s: Sched): string | null {
  if (!w) return null;
  const tz = s.timezone;
  const today = localToday(now, tz);
  const n = Math.max(1, Math.round(w.amount ?? 1));

  if (w.kind === 'in') {
    // Минуты и часы -- точный момент от сейчас; дни, недели, месяцы -- день.
    if (w.unit === 'minutes') return new Date(now.getTime() + n * 60_000).toISOString();
    if (w.unit === 'hours') return new Date(now.getTime() + n * 3_600_000).toISOString();
    if (w.unit === 'months') {
      const m0 = today.m - 1 + n;
      const y = today.y + Math.floor(m0 / 12), m = (m0 % 12) + 1;
      return at({ y, m, d: Math.min(today.d, lastDay(y, m)) }, clock(w, s), tz);
    }
    return at(shift(today, n * (w.unit === 'weeks' ? 7 : 1)), clock(w, s), tz);
  }

  const hhmm = clock(w, s);
  // Сегодняшний день годится, только если его час ещё впереди: «до конца
  // недели», сказанное в пятницу вечером, -- следующая пятница, а не срок,
  // просроченный с рождения.
  const todayOk = Date.parse(at(today, hhmm, tz)) > now.getTime();
  let day: Ymd;
  switch (w.kind) {
    case 'tomorrow': day = shift(today, 1); break;
    case 'after_tomorrow': day = shift(today, 2); break;
    case 'weekday': day = nextWeekday(today, w.weekday ?? 1, false); break;
    case 'day_of_month': day = nextDayOfMonth(today, w.day ?? today.d, todayOk); break;
    case 'end_of_month': day = nextDayOfMonth(today, 31, todayOk); break;
    case 'end_of_week': day = nextWeekday(today, weekEndDay(s as OrgSchedule), todayOk); break;
    case 'date': {
      // Число без месяца -- то же, что «к 3-му»: ближайшее, а не через год.
      if (!w.month) { day = nextDayOfMonth(today, w.day ?? today.d, todayOk); break; }
      const m = w.month, d = w.day ?? today.d;
      // Без года: прошедшая в этом году дата -- это следующий год.
      const y = m < today.m || (m === today.m && d < today.d) ? today.y + 1 : today.y;
      day = { y, m, d: Math.min(d, lastDay(y, m)) };
      break;
    }
    default: day = today;
  }
  // «В 10 вечера», когда уже 23:00, -- завтра. Названная дата (25 сентября)
  // остаётся как сказана, даже прошедшей: переносить её за человека нельзя.
  if (w.kind === 'today' && !todayOk) day = shift(today, 1);
  return at(day, hhmm, tz);
}

/**
 * Повтор: шаг в минутах (месяц -- календарный, MONTH_MIN) и первый срок.
 * Первый срок нужен всегда: повтор без срока не напоминает ни разу.
 */
export function resolveRepeat(r: Repeat | null, now: Date, s: Sched): { minutes: number; first: string } | null {
  if (!r) return null;
  const n = Math.max(1, Math.round(r.n ?? 1));
  const minutes = r.every === 'day' ? 1440
    : r.every === 'week' ? 7 * 1440
      : r.every === 'month' ? MONTH_MIN
        : r.every === 'n_weeks' ? n * 7 * 1440
          : n * 1440;
  const tz = s.timezone;
  const today = localToday(now, tz);
  const hhmm = clock(r, s);
  const todayAt = at(today, hhmm, tz);
  const ahead = Date.parse(todayAt) > now.getTime();
  let day: Ymd;
  if ((r.every === 'week' || r.every === 'n_weeks') && r.weekday) day = nextWeekday(today, r.weekday, ahead);
  else if (r.every === 'month' && r.day) day = nextDayOfMonth(today, r.day, ahead);
  else day = ahead ? today : shift(today, 1);
  return { minutes, first: at(day, hhmm, tz) };
}
