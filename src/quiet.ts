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

const QUIET_FROM_HOUR = 20;
const QUIET_TO_HOUR = 8;

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

/**
 * Тихо ли сейчас. `urgent` пробивает тишину: срок, наступающий ночью, важнее
 * тишины -- иначе предупреждение придёт уже после провала.
 */
export function isQuiet(at: Date, timeZone: string, urgent = false): boolean {
  if (urgent) return false;
  const { hour, weekday } = localParts(at, timeZone);
  if (weekday === 0) return true; // воскресенье целиком
  return hour >= QUIET_FROM_HOUR || hour < QUIET_TO_HOUR;
}
