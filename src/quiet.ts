// Тихие часы (шаг 4d плана).
//
// 20:00-08:00 и воскресенье В ПОЯСЕ ОРГАНИЗАЦИИ. Пояс критичен, а не
// косметичен: cron Workers идёт в UTC, Ташкент UTC+5, и без пересчёта «тихо
// с 20:00 до 08:00» дало бы молчание с 01:00 до 13:00 по месту и сообщения
// в 03:00 -- ровно наоборот задуманному.
//
// Проверка живёт в ЕДИНСТВЕННОЙ точке отправки (outbox), а не у каждого
// вызывающего: иначе «тихо» стало бы свойством конкретных сообщений, и любой
// новый путь отправки обходил бы его молча.

import { hm, localHm, type OrgSchedule } from './schedule';

/**
 * Час и день недели в поясе организации.
 * Intl.DateTimeFormat есть в workerd и знает базу зон -- своей таблицы смещений
 * не держим: она разошлась бы с переводом часов.
 */
export function localParts(at: Date, timeZone: string): { hour: number; weekday: number } {
  const fmt = new Intl.DateTimeFormat('en-US', {
    timeZone, hour: 'numeric', hour12: false, weekday: 'short',
  });
  const parts = fmt.formatToParts(at);
  const hour = Number(parts.find((p) => p.type === 'hour')?.value ?? '0');
  const wd = parts.find((p) => p.type === 'weekday')?.value ?? 'Mon';
  const weekday = ['Sun', 'Mon', 'Tue', 'Wed', 'Thu', 'Fri', 'Sat'].indexOf(wd);
  // hour12:false отдаёт 24 вместо 0 в некоторых реализациях -- нормализуем.
  return { hour: hour === 24 ? 0 : hour, weekday };
}

/** Окно тишины задано: одинаковые «с» и «до» (00:00-00:00) значат «тишины нет». */
export const quietOn = (s: Pick<OrgSchedule, 'quiet_from' | 'quiet_to'>) => s.quiet_from !== s.quiet_to;

/**
 * Тихо ли сейчас. Окно -- настройка пространства (по умолчанию 22:00-08:00) и
 * действует и у 24/7: раньше у семьи тишины не было вовсе, и «Просрочено»
 * шло круглые сутки. У пространства с графиком тихо ещё и всё воскресенье.
 *
 * `urgent` пробивает тишину: это напоминание к сроку, который сам назначен на
 * это время («напомни в 23:30»), -- иначе оно пришло бы после срока.
 */
export function isQuiet(at: Date, s: Pick<OrgSchedule, 'timezone' | 'quiet_from' | 'quiet_to' | 'always_on'>, urgent = false): boolean {
  if (urgent) return false;
  if (!s.always_on && localParts(at, s.timezone).weekday === 0) return true;
  if (!quietOn(s)) return false;
  const m = localHm(at, s.timezone).minutes;
  const from = hm(s.quiet_from), to = hm(s.quiet_to);
  // Окно через полночь (22:00-08:00) и внутри суток (13:00-15:00) -- оба законны.
  return from < to ? m >= from && m < to : m >= from || m < to;
}
