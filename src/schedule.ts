// График работы организации и всё, что от него считается (раздел 21).
//
// Лист без зависимостей: его читают outbox, cron, разбор фраз и бот. Пояс --
// у организации, и все «сейчас» переводятся в её местное время через Intl:
// своей таблицы смещений нет, она разошлась бы с переводом часов.
import type { Env } from './types';

export type OrgSchedule = {
  id: string;
  timezone: string;
  /** Дни недели 1..7 (пн..вс) через запятую. */
  work_days: string;
  work_start: string;
  work_end: string;
  lunch_start: string | null;
  lunch_end: string | null;
  /** 24/7: семья, личные дела. Графика нет, ночного пола тоже. */
  always_on: number;
  digest_enabled: number;
  /** NULL -- в начало рабочего дня. */
  digest_time: string | null;
  quiet_hours: number;
};

/** Колонки графика для SELECT с алиасом таблицы: одна строка на все запросы. */
export function scheduleCols(t: string): string {
  return `COALESCE(${t}.timezone, 'Asia/Tashkent') AS timezone, ${t}.work_days, ${t}.work_start, ${t}.work_end, ` +
    `${t}.lunch_start, ${t}.lunch_end, ${t}.always_on, ${t}.digest_enabled, ${t}.digest_time, COALESCE(${t}.quiet_hours, 1) AS quiet_hours`;
}

const DEFAULT: Omit<OrgSchedule, 'id'> = {
  timezone: 'Asia/Tashkent', work_days: '1,2,3,4,5', work_start: '09:00', work_end: '18:00',
  lunch_start: '13:00', lunch_end: '14:00', always_on: 0, digest_enabled: 1, digest_time: null, quiet_hours: 1,
};

export async function loadSchedule(env: Env, orgId: string): Promise<OrgSchedule> {
  const row = await env.DB.prepare(`SELECT id, ${scheduleCols('orgs')} FROM orgs WHERE id = ?`).bind(orgId).first<OrgSchedule>();
  return row ?? { id: orgId, ...DEFAULT };
}

/** «09:30» -> минуты от полуночи. */
export function hm(s: string): number {
  const [h, m] = s.split(':').map(Number);
  return (h || 0) * 60 + (m || 0);
}

/** Местные день недели (1=пн..7=вс), минуты от полуночи и ключ дня YYYY-MM-DD. */
export function localHm(at: Date, timeZone: string): { weekday: number; minutes: number; dayKey: string } {
  const parts = new Intl.DateTimeFormat('en-US', { timeZone, hour: 'numeric', minute: 'numeric', hour12: false, weekday: 'short' })
    .formatToParts(at);
  const get = (t: string) => parts.find((p) => p.type === t)?.value ?? '0';
  const hour = Number(get('hour')) % 24;
  const wd = ['Mon', 'Tue', 'Wed', 'Thu', 'Fri', 'Sat', 'Sun'].indexOf(get('weekday')) + 1;
  return { weekday: wd || 1, minutes: hour * 60 + Number(get('minute')), dayKey: new Intl.DateTimeFormat('en-CA', { timeZone }).format(at) };
}

export function isWorkDay(s: OrgSchedule, at: Date): boolean {
  if (s.always_on) return true;
  return s.work_days.split(',').map(Number).includes(localHm(at, s.timezone).weekday);
}

/** Рабочее ли сейчас время: день из графика, между началом и концом, не обед. */
export function inWorkHours(s: OrgSchedule, at: Date): boolean {
  if (s.always_on) return true;
  if (!isWorkDay(s, at)) return false;
  const m = localHm(at, s.timezone).minutes;
  if (m < hm(s.work_start) || m >= hm(s.work_end)) return false;
  if (s.lunch_start && s.lunch_end && m >= hm(s.lunch_start) && m < hm(s.lunch_end)) return false;
  return true;
}

/** Конец дня для «до завтра» и кнопок срока: конец рабочего дня, у 24/7 -- 23:59. */
export function dayEnd(s: OrgSchedule): string {
  return s.always_on ? '23:59' : s.work_end;
}

/** Час сводки: свой или начало рабочего дня. */
export function digestAt(s: OrgSchedule): string {
  return s.digest_time ?? (s.always_on ? '09:00' : s.work_start);
}

export function sameLocalDay(iso: string, at: Date, timeZone: string): boolean {
  const fmt = new Intl.DateTimeFormat('en-CA', { timeZone });
  return fmt.format(new Date(iso)) === fmt.format(at);
}
