// Входящий канал Telegram (шаг 4a плана) -- ТРЕТЬЯ дверь в систему.
//
// Первые две закрыты: /api сидит под requireAuth, /mcp -- под constant-time
// bearer. Эта дверь публичная и безкуковая, поэтому у неё собственная защита:
//   1) X-Telegram-Bot-Api-Secret-Token -- Telegram шлёт его на каждом апдейте;
//   2) резолв telegram_user_id -> user_id + org_id по БД.
//
// Монтируется в index.ts рядом с /mcp, а НЕ внутри apiRoutes. Причина не
// стилистическая: `apiRoutes.use('*', requireAuth)` накрывает всё, что
// зарегистрировано ниже, и вебхук получал бы 401. Telegram на 401 ретраит, а
// затем отключает вебхук -- отказ был бы тихим и обнаружился бы через сутки
// молчания бота.
//
// Неизвестный отправитель получает МОЛЧАНИЕ, а не «вы не зарегистрированы»:
// последнее -- оракул существования, ровно то, что запрещено для проектов.
import { Hono } from 'hono';
import type { Env, Role } from './types';
import { nowIso, uuid } from './db';
import { myAssignee, transitionAssignee } from './assignees';
import { answerCallbackQuery, editMessageReplyMarkup, sendMessage } from './telegram';
import { drainOutbox } from './outbox';
import { membershipRole, resolveOrgId } from './auth';
import { safeEqual } from './auth';

const enc = new TextEncoder();

export const botApp = new Hono<{ Bindings: Env }>();

type TgUser = { id: number; username?: string };
type Update = {
  message?: { chat: { id: number }; from?: TgUser; text?: string };
  callback_query?: { id: string; from: TgUser; data?: string; message?: { chat: { id: number }; message_id: number } };
};

/** Кто это. null -- неизвестный, и тогда мы молчим. */
async function whoIs(env: Env, tg: TgUser): Promise<{ userId: string; orgId: string; role: Role } | null> {
  const row = await env.DB.prepare('SELECT id FROM users WHERE telegram_user_id = ?')
    .bind(String(tg.id))
    .first<{ id: string }>();
  if (!row) return null;
  const orgId = await resolveOrgId(env.DB, row.id);
  if (!orgId) return null;
  const role = await membershipRole(env.DB, orgId, row.id);
  if (!role) return null;
  return { userId: row.id, orgId, role };
}

/**
 * Подключение по одноразовой ссылке ?start=inv_xxxx.
 * Токен гасится сразу: ссылка одноразовая, иначе переслать её -- значит отдать
 * чужой доступ.
 */
async function connectByInvite(env: Env, tg: TgUser, token: string): Promise<string | null> {
  const row = await env.DB.prepare('SELECT id, name FROM users WHERE invite_token = ? AND telegram_user_id IS NULL')
    .bind(token)
    .first<{ id: string; name: string }>();
  if (!row) return null;
  await env.DB.prepare('UPDATE users SET telegram_user_id = ?, telegram_username = COALESCE(?, telegram_username), invite_token = NULL, connected_at = ? WHERE id = ?')
    .bind(String(tg.id), tg.username ?? null, nowIso(), row.id)
    .run();
  return row.name;
}

botApp.post('/webhook', async (c) => {
  // Секрет проверяется constant-time и ПЕРВЫМ: без него роут -- открытая дверь
  // для кого угодно, кто знает адрес воркера.
  const secret = c.env.TELEGRAM_WEBHOOK_SECRET;
  const got = c.req.header('x-telegram-bot-api-secret-token') ?? '';
  if (!secret || !safeEqual(enc.encode(got), enc.encode(secret))) {
    return c.json({ error: 'forbidden' }, 403);
  }

  const update = await c.req.json<Update>().catch(() => ({}) as Update);

  // ------------------------------------------------------------ нажатие кнопки
  if (update.callback_query) {
    const cq = update.callback_query;
    // answerCallbackQuery отправляется НА КАЖДОЕ нажатие, включая отвергнутые:
    // без него у нажавшего крутится спиннер до таймаута.
    const who = await whoIs(c.env, cq.from);
    if (!who) {
      await answerCallbackQuery(c.env, cq.id);
      return c.json({ ok: true });
    }

    const [action, taskId] = (cq.data ?? '').split(':');
    const task = taskId
      ? await c.env.DB.prepare('SELECT * FROM tasks WHERE id = ? AND org_id = ?').bind(taskId, who.orgId).first<import('./types').Task>()
      : null;
    if (!task) {
      await answerCallbackQuery(c.env, cq.id, 'Задача недоступна');
      return c.json({ ok: true });
    }

    // Ветка поводов идёт ДО проверки «ты адресат» намеренно: повод адресован
    // АВТОРУ поручения, а он обычно не входит в список исполнителей. Проверка
    // адресата выше отбивала бы собственные кнопки автора.
    // Нажатие отмечается в nudges: без acted_at метрика «доля
    // поводов без нажатия за сутки» не имеет числителя.
    if (action === 'nudge_remind' || action === 'nudge_confirm') {
      await c.env.DB.prepare(
        'UPDATE nudges SET acted_at = ? WHERE user_id = ? AND task_id = ? AND acted_at IS NULL',
      ).bind(nowIso(), who.userId, task.id).run();

      if (action === 'nudge_confirm') {
        // Подтвердить может только автор -- тот же гейт, что у POST /confirm.
        // Повод адресован автору, но кнопку могли переслать.
        if (task.author_id !== who.userId) {
          await answerCallbackQuery(c.env, cq.id, 'Принимает работу автор');
          return c.json({ ok: true });
        }
        await c.env.DB.prepare('UPDATE tasks SET confirmed_at = ? WHERE id = ? AND org_id = ?')
          .bind(nowIso(), task.id, who.orgId).run();
        await answerCallbackQuery(c.env, cq.id, 'Принято');
      } else {
        await answerCallbackQuery(c.env, cq.id, 'Напомним исполнителям');
        // Сброс флага эскалации -- повторное напоминание пойдёт штатным проходом
        // cron, а не отдельной рассылкой в обход тихих часов.
        await c.env.DB.prepare(
          "UPDATE task_assignees SET last_escalated_at = NULL WHERE task_id = ? AND state = 'pending'",
        ).bind(task.id).run();
      }
      if (cq.message) await editMessageReplyMarkup(c.env, String(cq.message.chat.id), String(cq.message.message_id));
      await drainOutbox(c.env);
      return c.json({ ok: true });
    }

    // Сообщение уходит в ЛИЧКУ адресата (ADR-4), но нажать всё равно может
    // только тот, у кого есть своя строка: пересланное сообщение кнопку не
    // делает чужой.
    const mine = await myAssignee(c.env, task.id, who.userId, who.orgId);
    if (!mine) {
      await answerCallbackQuery(c.env, cq.id, 'Это не ваше поручение');
      return c.json({ ok: true });
    }

    const target = action === 'accept' ? 'accepted' : action === 'done' ? 'done' : null;
    if (!target) {
      await answerCallbackQuery(c.env, cq.id);
      return c.json({ ok: true });
    }

    const res = await transitionAssignee(c.env, {
      task, assignee: mine, to: target, actorId: who.userId,
      notify: target === 'accepted'
        ? { emoji: '🚀', label: 'В работе', track: true }
        : { emoji: '✅', label: 'Готово', deletePrevious: true },
    });
    await answerCallbackQuery(c.env, cq.id, res.ok ? (target === 'accepted' ? 'Принято' : 'Отмечено готовым') : 'Уже нельзя');

    // Клавиатура гасится РОВНО ОДИН РАЗ на переход: иначе ту же кнопку можно
    // нажать второй раз, и человек увидит «уже нельзя» на собственное действие.
    if (res.ok && cq.message) {
      await editMessageReplyMarkup(c.env, String(cq.message.chat.id), String(cq.message.message_id));
    }
    await drainOutbox(c.env);
    return c.json({ ok: true });
  }

  // ------------------------------------------------------------ текст
  const msg = update.message;
  if (!msg?.from) return c.json({ ok: true });

  const start = msg.text?.match(/^\/start\s+(\S+)/);
  if (start) {
    const name = await connectByInvite(c.env, msg.from, start[1]);
    if (name) {
      await sendMessage(c.env, String(msg.chat.id), `Здравствуйте, ${name}. Бот подключён.`);
      // Накопленное за время до подключения уедет сразу: строки ждали в очереди
      // именно этого (ADR-4 запрещает падать назад в групповой чат).
      await drainOutbox(c.env);
    }
    // Неверный токен -- молчание: подтверждение «такой ссылки нет» позволило бы
    // перебирать токены и узнавать, какие существуют.
    return c.json({ ok: true });
  }

  const who = await whoIs(c.env, msg.from);
  if (!who) return c.json({ ok: true }); // неизвестный -- молчим

  if (msg.text === '/moe' || msg.text === '/мое' || msg.text === '/моё') {
    // «Моё» -- ОДИН список на человека, а не по одному на организацию: у него
    // один Telegram-аккаунт, и разделять его список по арендаторам значило бы
    // заставлять переключаться, чтобы увидеть свой день целиком.
    const { results } = await c.env.DB.prepare(
      `SELECT t.title, o.name AS org_name, a.due_at
       FROM task_assignees a
       JOIN tasks t ON t.id = a.task_id
       JOIN orgs o ON o.id = a.org_id
       WHERE a.user_id = ? AND a.state IN ('pending','accepted','rejected') AND t.status <> 'archived'
       ORDER BY a.due_at IS NULL, a.due_at`,
    ).bind(who.userId).all<{ title: string; org_name: string; due_at: string | null }>();

    const text = results.length
      ? ['Ваши задачи:', ...results.map((r) => `• ${r.title} — ${r.org_name}${r.due_at ? ` (до ${r.due_at.slice(0, 10)})` : ''}`)].join('\n')
      : 'Активных задач нет.';
    await sendMessage(c.env, String(msg.chat.id), text);
    return c.json({ ok: true });
  }

  if (msg.text === '/promah' || msg.text === '/промах') {
    // Счётчик промахов личного слоя: по нему считается метрика «≤2 за 14 дней»
    // и требование «по убыванию».
    await c.env.DB.prepare(
      `INSERT INTO events (id, actor_id, org_id, target_type, target_id, action, comment, overdue_by, created_at)
       VALUES (?, ?, ?, 'user', ?, 'miss', NULL, NULL, ?)`,
    ).bind(uuid(), who.userId, who.orgId, who.userId, nowIso()).run();
    await sendMessage(c.env, String(msg.chat.id), 'Отмечено. Спасибо, что сказали.');
    return c.json({ ok: true });
  }

  return c.json({ ok: true });
});
