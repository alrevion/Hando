// Проход отправки для outbox (шаг 1 плана).
//
// Отделён от перехода намеренно: переход атомарен, отправка -- нет. Проход
// идемпотентен по sent_at, поэтому его можно звать и сразу после запроса
// (тогда задержка та же, что была до outbox), и из cron как страховку за то,
// что первый вызов не дошёл.
import type { Env } from './types';
import type { InlineButton } from './telegram';
import { nowIso } from './db';
import { deleteMessage, sendMessage } from './telegram';
import { isQuiet } from './quiet';
import { inWorkHours, scheduleCols, type OrgSchedule } from './schedule';

type Payload = {
  // Кому, а не куда: адрес резолвится при отправке -- см. transition.ts.
  recipient_user_id: string;
  text: string;
  delete_message_id: string | null;
  track: boolean;
  // Пробивает тихие часы: срок, наступающий ночью, важнее тишины.
  urgent?: boolean;
  // Рабочее напоминание: только в рабочее время организации (раздел 21).
  gated?: boolean;
  keyboard?: InlineButton[][] | null;
};

const BATCH = 50;
// После скольких неудач строка выпадает из выборки. Без этого один
// неотправляемый получатель НАВСЕГДА занимает место в первых BATCH строках, и
// очередь встаёт целиком -- включая срочные, которые обязаны пробивать тишину.
const MAX_ATTEMPTS = 10;

/**
 * Отправляет все неотправленные уведомления. Возвращает число доставленных.
 * Строка помечается sent_at ТОЛЬКО после успешной отправки: не дошло -- следующий
 * проход попробует снова, а дубля не будет, потому что первый заход не пометил.
 */
export async function drainOutbox(env: Env, now: Date = new Date()): Promise<number> {
  const { results } = await env.DB.prepare(
    `SELECT n.id, n.task_id, n.org_id, n.payload, ${scheduleCols('o')}
     FROM notifications n
     LEFT JOIN orgs o ON o.id = n.org_id
     -- attempts < MAX: строка, которую не удаётся доставить, обязана выпасть из
     -- очереди. Иначе она вечно занимает место в первых BATCH и держит за собой
     -- всё остальное -- проверено: 55 задач неподключённому человеку блокировали
     -- доставку ВСЕМ, включая срочные эскалации.
     WHERE n.sent_at IS NULL AND n.attempts < ? ORDER BY n.scheduled_at LIMIT ?`,
  )
    .bind(MAX_ATTEMPTS, BATCH)
    .all<{ id: string; task_id: string; org_id: string | null; payload: string } & Omit<OrgSchedule, 'id'>>();

  let sent = 0;
  for (const row of results) {
    let p: Payload;
    try {
      p = JSON.parse(row.payload) as Payload;
    } catch {
      // Нечитаемый payload не починится ретраем -- гасим строку, чтобы она не
      // блокировала очередь навсегда, но следа не теряем.
      await env.DB.prepare("UPDATE notifications SET sent_at = ?, attempts = attempts + 1 WHERE id = ?").bind(nowIso(), row.id).run();
      continue;
    }

    // Адрес резолвится СЕЙЧАС, а не при постановке: человек мог подключить бота
    // уже после неё. Не подключил -- строка ЖДЁТ (ADR-4: личка или ничего;
    // падать назад в групповой чат нельзя, это и есть закрываемая утечка).
    //
    // ЧЛЕНСТВО проверяется здесь же и по той же причине, по которой здесь стоят
    // гейты времени: это единственная точка отправки, и предикат, поставленный
    // тут, накрывает все источники строк (переходы, проходы cron, поводы).
    // requireAuth перечитывает членство на КАЖДОМ запросе, но очередь живёт без
    // запроса -- уволенный продолжал бы получать заголовки задач бывшего
    // работодателя бессрочно. Режим уведомлений -- у получателя, поэтому он
    // читается вместе с адресом, ДО гейтов.
    const to = await env.DB.prepare(
      `SELECT u.telegram_user_id, COALESCE(u.notify_mode, 'all') AS notify_mode, m.frozen_at FROM users u
       JOIN org_memberships m ON m.user_id = u.id AND m.org_id = ? AND m.left_at IS NULL AND m.confirmed_at IS NOT NULL
       JOIN orgs og ON og.id = m.org_id AND og.archived_at IS NULL
       WHERE u.id = ?`,
    )
      .bind(row.org_id, p.recipient_user_id)
      .first<{ telegram_user_id: string | null; notify_mode: string; frozen_at: string | null }>();
    // Замороженный (отпуск, болезнь) уведомлений не получает вовсе: строка
    // гасится, а не ждёт -- после разморозки старые «примите» уже не нужны.
    if (to?.frozen_at) {
      await env.DB.prepare('UPDATE notifications SET sent_at = ?, attempts = attempts + 1 WHERE id = ?').bind(nowIso(), row.id).run();
      continue;
    }
    const chatId = to?.telegram_user_id;
    if (!chatId) {
      // Не адресат сейчас (не подключил бота или отозван). Считаем попытку --
      // иначе строка держала бы очередь вечно (см. MAX_ATTEMPTS выше).
      await env.DB.prepare('UPDATE notifications SET attempts = attempts + 1 WHERE id = ?').bind(row.id).run();
      continue;
    }

    // ЕДИНСТВЕННАЯ точка, где действуют тихие часы и график. Строка остаётся
    // неотправленной и уедет следующим проходом -- не теряется, а ждёт. Пояс
    // берётся у организации сообщения, а не сервера. Два гейта:
    //   -- ночной пол 20:00-08:00 и воскресенье -- для всего несрочного;
    //   -- рабочие часы графика -- для напоминаний (gated) и для тех, кто
    //      выбрал «по расписанию». «Сразу из всех» получает переходы сразу.
    // Срочное (срок, просрочка) пробивает оба: предупреждение после провала
    // бесполезно.
    const s: OrgSchedule = { ...row, id: row.org_id ?? '' };
    if (p.urgent !== true) {
      // Ночной пол -- у организаций с графиком (24/7 живёт вечером); quiet_hours=0 -- выключатель для тестов.
      if (!s.always_on && s.quiet_hours === 1 && isQuiet(now, s.timezone)) continue;
      // График -- независимо от пола: для напоминаний и для режима «по расписанию».
      if ((p.gated === true || to.notify_mode === 'schedule') && !inWorkHours(s, now)) continue;
    }

    // КЛЕЙМ перед отправкой, а не пометка после.
    //
    // drainOutbox зовётся из каждого мутирующего роута, из обеих веток бота и из
    // cron. Между SELECT и UPDATE в D1 нет ни блокировки, ни SELECT FOR UPDATE,
    // поэтому два одновременных прохода выбирали одни и те же строки и слали
    // КАЖДУЮ ДВАЖДЫ -- проверено: три строки в очереди дали шесть сообщений.
    // Рассылка на 14 человек -- это 14 нажатий «Принял» в одну минуту, то есть
    // конкуренция здесь норма, а не край.
    //
    // Однооператорный клейм атомарен: `changes` скажет, досталась ли строка нам.
    // Цена: при падении между клеймом и отправкой сообщение теряется, а не
    // дублируется. Для уведомления это правильный размен -- дубль «ВЫ
    // ПРОСРОЧИЛИ» хуже пропуска, а пропущенное состояние человек увидит на доске.
    const claimed = await env.DB
      .prepare("UPDATE notifications SET sent_at = ?, attempts = attempts + 1 WHERE id = ? AND sent_at IS NULL")
      .bind(nowIso(), row.id)
      .run();
    if (!claimed.meta.changes) continue; // строку забрал другой проход

    if (p.delete_message_id) await deleteMessage(env, chatId, p.delete_message_id);
    const messageId = await sendMessage(env, chatId, p.text, p.keyboard ? { inline_keyboard: p.keyboard } : undefined);
    if (messageId === null) {
      // Не ушло -- возвращаем строку в очередь, сняв клейм. attempts уже
      // увеличен клеймом, поэтому вечного цикла не будет: после MAX_ATTEMPTS
      // строка выпадет из выборки.
      await env.DB.prepare('UPDATE notifications SET sent_at = NULL WHERE id = ?').bind(row.id).run();
      continue;
    }

    const writes: D1PreparedStatement[] = [];
    if (p.track) {
      // Единственная запись в tasks вне transition.ts, и она не про status:
      // id сообщения существует только после отправки, поэтому попасть в batch
      // перехода он физически не мог.
      writes.push(env.DB.prepare('UPDATE tasks SET telegram_message_id = ? WHERE id = ?').bind(messageId, row.task_id));
    }
    if (writes.length) await env.DB.batch(writes);
    sent++;
  }
  return sent;
}
