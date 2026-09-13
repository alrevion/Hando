// Приём поручения: разобранный черновик -> задача в базе.
//
// ОДИН путь для бота и для приложения. Раньше этот код жил в bot.ts, и
// приложение просто не умело того, что умеет бот. Копия здесь была бы хуже
// отсутствия: две ветки создания задач разошлись бы в мелочах (источник,
// уведомления, вложение), и разошлись бы молча.
import type { Env, Task } from './types';
import { nowIso, uuid } from './db';
import { logEvent } from './db';
import { formatWhen, matchDeadline, matchPriority, type Draft } from './parse';
import { buildAssignees, clearReminders, confirmWork, declineAssignee, lateAssignee, loadAssignees, myAssignee, startWork, transitionAssignee, type Assignee } from './assignees';
import { applyTransition, assigneeButtons, buildNotification } from './transition';
import { storeByFileId, type Media } from './media';
import { ensureDefaultProject } from './signup';

export async function createFromDraft(
  env: Env,
  who: { userId: string; orgId: string },
  draft: Draft,
  /** Вложения черновика. Голосовое тоже здесь -- оно остаётся доказательством. */
  media: Media[],
  rawPhrase: string,
  /** Содержание: подробности, которые человек дописал к теме в приложении. */
  description?: string | null,
): Promise<string | null> {
  const project = await env.DB.prepare(
    `SELECT p.id, p.telegram_chat_id FROM projects p
     LEFT JOIN project_memberships m ON m.project_id = p.id AND m.user_id = ?
     WHERE p.org_id = ? AND p.archived_at IS NULL AND (m.user_id IS NOT NULL OR p.created_by = ?)
     ORDER BY p.created_at LIMIT 1`,
  ).bind(who.userId, who.orgId, who.userId).first<{ id: string }>();
  // В только что созданной организации досок нет вовсе -- заводим первую, иначе
  // класть задачу физически некуда (tasks.project_id NOT NULL). Если доски
  // есть, а этой строки нет -- человека просто не добавили ни на одну, и это
  // другой разговор: молча заводить ему личную доску нельзя.
  const projectId = project?.id ?? (
    (await env.DB.prepare('SELECT id FROM projects WHERE org_id = ? AND archived_at IS NULL LIMIT 1').bind(who.orgId).first())
      ? null
      : await ensureDefaultProject(env, who.orgId, who.userId)
  );
  if (!projectId) return null;

  const taskId = uuid();
  const now = nowIso();
  const task = {
    id: taskId, org_id: who.orgId, project_id: projectId, title: draft.title,
    author_id: who.userId, kind: draft.kind, deadline: draft.deadline,
    telegram_message_id: null,
  } as Task;

  const writes = [
    env.DB.prepare(
      `INSERT INTO tasks (id, org_id, project_id, title, description, repeat_min, checklist, author_id, kind, source, status, priority, deadline)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, 'todo', ?, ?)`,
    ).bind(taskId, who.orgId, projectId, draft.title, description ?? '',
      draft.repeatMin ?? null,
      draft.checklist?.length ? JSON.stringify(draft.checklist.map((t) => ({ t, d: null }))) : null,
      who.userId, draft.kind,
      // source различает разбор паттернами и моделью -- это и есть замер для
      // порога-гейта шага 4b: сколько фраз обошлось без обращения к сети.
      media.some((m) => m.hasAudio) ? 'voice' : draft.source === 'llm' ? 'bot_llm' : 'bot', draft.priority, draft.deadline),
    env.DB.prepare(
      `INSERT INTO events (id, actor_id, org_id, target_type, target_id, action, comment, overdue_by, created_at)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)`,
    ).bind(uuid(), who.userId, who.orgId, 'task', taskId, 'created', rawPhrase.slice(0, 500), null, now),
    ...buildAssignees(env, task, draft.assigneeIds, draft.deadline),
  ];

  // Уведомление каждому адресату, кроме самого автора: он только что это и
  // продиктовал.
  for (const uid of draft.assigneeIds) {
    if (uid === who.userId) continue;
    writes.push(await buildNotification(env, task, 'created', { emoji: '📌', label: 'Вам поручено', buttons: assigneeButtons(task, uid) }, draft.deadline, uid, who.userId));
  }
  await env.DB.batch(writes);

  // Файлы кладутся ПОСЛЕ задачи и отдельно: сеть может подвести, и терять
  // из-за этого разобранное поручение нельзя.
  for (const m of media) {
    const stored = await storeByFileId(env, m);
    if (!stored) continue;
    const attachmentId = uuid();
    await env.DB.prepare(
      `INSERT INTO attachments (id, org_id, task_id, telegram_file_id, telegram_message_id, filename, mime_type, size_bytes, uploaded_by)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)`,
    ).bind(attachmentId, who.orgId, taskId, stored.fileId, stored.messageId, m.filename, m.mimeType, m.sizeBytes, who.userId).run();
    // Голосовое остаётся доказательством: «покажи, что я тогда сказал».
    if (m.hasAudio) {
      await env.DB.prepare('UPDATE tasks SET origin_audio_id = COALESCE(origin_audio_id, ?) WHERE id = ?')
        .bind(attachmentId, taskId).run();
    }
  }
  return taskId;
}


/**
 * Ставит срок задаче и всем её адресатам.
 *
 * Срок живёт в ДВУХ местах: tasks.deadline -- то, что видно на доске, и
 * task_assignees.due_at -- то, по чему считает напоминание (см. scheduled.ts).
 * Писать только в одно значило бы «срок вижу, а напоминания нет».
 * Журнал напоминаний стирается: у нового срока свои «за час» и «в срок».
 */
export async function setTaskDeadline(env: Env, taskId: string, orgId: string, iso: string | null): Promise<void> {
  await env.DB.batch([
    env.DB.prepare('UPDATE tasks SET deadline = ?, updated_at = ? WHERE id = ? AND org_id = ?')
      .bind(iso, nowIso(), taskId, orgId),
    env.DB.prepare('UPDATE task_assignees SET due_at = ? WHERE task_id = ? AND org_id = ?')
      .bind(iso, taskId, orgId),
    clearReminders(env, taskId),
  ]);
}


// ------------------------------------- ГОЛОСОМ И ТЕКСТОМ по действующей задаче
//
// Одна фраза -- одно действие над УЖЕ созданной задачей: двинуть по этапам,
// принять работу, отпроситься, перенести срок, сменить важность, переименовать.
// До сих пор словами правился только черновик: стоило нажать «Создать», и всё
// остальное делалось руками в приложении. Диктовка ради этого и существует.
//
// ОБЩИЙ ПРЕДИКАТ у всех команд один и тот же и состоит из трёх условий:
//   (1) во фразе есть глагол команды;
//   (2) в ней ДОСЛОВНО названа тема задачи, к которой человек причастен;
//   (3) команда реально что-то меняет.
// Любое несовпадение -- и фраза идёт обычным путём, то есть становится новым
// черновиком. Так «Азизу подготовить отчёт» при существующей задаче
// «Подготовить отчёт» остаётся новым поручением, а не командой.

/**
 * Глагол ищется ТОЛЬКО с начала слова.
 *
 * \b для этого не годится: в JS граница слова считается по ASCII, и рядом с
 * кириллицей её просто нет. А без границы «готов» находится внутри
 * «подготовить» -- и фраза «взял в работу подготовить отчёт» читалась бы как
 * «готово», то есть задача прыгала бы сразу на проверку. Отрицательный
 * ретроспективный просмотр даёт ровно нужное: перед глаголом не буква.
 */
const startOfWord = (body: string) => new RegExp(`(?<![а-яёa-zA-Z])(?:${body})`, 'i');

/** Согласиться взять поручение. «Принял» -- это ещё не «делаю». */
const V_ACCEPT = startOfWord(String.raw`принима[ею]|принял|согласен|берусь|возьму`);
/** Сесть за работу: следующий шаг после согласия. */
const V_START = startOfWord(String.raw`в\s+работу|начал|начина[ею]|приступил|приступа[ею]|беру|взял|занялся|делаю`);
/** Сдать на проверку. */
const V_DONE = startOfWord(String.raw`готов[оа]?|сдела[нл]|выполн[иел]|законч|заверш|сда[лю]|отправил\s+на\s+проверку`);
/** Принять работу -- это делает автор. */
const V_CONFIRM = startOfWord(String.raw`принима[ею]\s+работу|принял\s+работу|подтвержда[ею]|зач[её]т|проверил\s+и\s+принял`);
/**
 * Вернуть на доработку -- тоже автор. Проверяется РАНЬШЕ приёмки: «не принимаю
 * работу» содержит «принимаю работу», и при обратном порядке возврат читался бы
 * как приёмка, то есть задача закрывалась бы вместо возврата.
 */
const V_RETURN = startOfWord(String.raw`верн[уи]|возвраща|на\s+доработку|передела|не\s+принима[ею]|не\s+принял|отклоня[ею]|отклонил`);
/**
 * Отказаться от поручения -- исполнитель. Проверяется РАНЬШЕ «взять в работу»:
 * «не возьму» содержит «возьму».
 */
const V_DECLINE = startOfWord(String.raw`отказ|откаж|не\s+буду|не\s+возьму|не\s+мо[её]|снима[ею]\s+с\s+себя`);
/** Не успеваю: причина -- сама фраза. */
const V_LATE = startOfWord(String.raw`не\s+успева[ею]|не\s+успе[юл]|опазд|задержива[ею]сь`);
/**
 * Правка полей. «сделай» тут намеренно шире остальных: он же начинает
 * «сделай срочной», а пустая правка отсекается условием (3).
 */
const EDIT_VERB = startOfWord(String.raw`перенес|перенёс|перенеси|подвин|сдвин|поменя|измени|исправ|переименуй|обнови|продли|отлож|сдела[йи]`);

/**
 * Переименование -- ТОЛЬКО с явным указателем: «переименуй «X» в «Y»»,
 * «тема: Y», «поменяй тему по «X» на Y».
 *
 * Предлог обязателен, и берётся ПОСЛЕДНИЙ: во фразе «переименуй подготовить
 * отчёт в закрыть акты» первое «в» стоит внутри старой темы, и жадная звёздочка
 * нужна ровно затем, чтобы новой темой стало «закрыть акты», а не вся фраза.
 *
 * \b здесь НЕТ намеренно: в JS граница слова считается по ASCII, и после «й»
 * её не существует -- регулярка с \b не срабатывала ни на одной русской фразе.
 */
const RENAME = [
  /(?:переименуй|тем[ауы]|назван[а-яё]+|заголов[а-яё]+)[^:]*:\s*(.{3,200})$/i,
  /(?:переименуй|тем[ауы]|назван[а-яё]+|заголов[а-яё]+).*\s(?:в|на)\s+(.{3,200})$/i,
];

/**
 * Задача, названная во фразе дословно. Берётся САМАЯ ДЛИННАЯ совпавшая тема:
 * «отчёт» подойдёт трём задачам, «подготовить отчёт по продажам» -- одной.
 *
 * Ищем среди тех, к которым человек причастен -- свои поручения и то, что
 * поручили ему: команда этапа принадлежит исполнителю, команда правки -- автору,
 * и разделяет их уже вызывающий.
 */
async function taskInPhrase(env: Env, orgId: string, userId: string, phrase: string): Promise<Task | null> {
  const q = phrase.toLowerCase();
  const { results } = await env.DB.prepare(
    `SELECT DISTINCT t.* FROM tasks t
     LEFT JOIN task_assignees a ON a.task_id = t.id AND a.user_id = ?
     WHERE t.org_id = ? AND t.status IN ('todo','in_progress','done')
       AND (t.author_id = ? OR a.user_id IS NOT NULL)
     ORDER BY t.updated_at DESC LIMIT 40`,
  ).bind(userId, orgId, userId).all<Task>();
  return results
    .filter((t) => t.title.trim().length >= 4 && q.includes(t.title.toLowerCase()))
    .sort((a, b) => b.title.length - a.title.length)[0] ?? null;
}

const PRI_RU: Record<string, string> = { urgent: 'высокая', medium: 'средняя', low: 'низкая' };

/**
 * Команда по действующей задаче. Возвращает, что сделано, -- или null, если
 * фраза командой не оказалась и должна идти дальше обычным путём.
 */
export async function commandTaskByPhrase(
  env: Env,
  who: { userId: string; orgId: string },
  phrase: string,
  timeZone: string,
  packId?: string | null,
  dayEndHm?: string,
  /** Последний рабочий день недели организации (1=пн..7=вс). */
  weekEnd?: number,
  now: Date = new Date(),
): Promise<{ taskId: string; text: string } | null> {
  const anyVerb = V_ACCEPT.test(phrase) || V_START.test(phrase) || V_DONE.test(phrase) || V_CONFIRM.test(phrase)
    || V_RETURN.test(phrase) || V_DECLINE.test(phrase) || V_LATE.test(phrase) || EDIT_VERB.test(phrase);
  if (!anyVerb) return null;
  const task = await taskInPhrase(env, who.orgId, who.userId, phrase);
  if (!task) return null;

  const mine = await myAssignee(env, task.id, who.userId, who.orgId);
  const author = task.author_id === who.userId;

  // ---- этапы. ПОРЯДОК ВЕТОК -- часть смысла, а не стиль: длинная формулировка
  // содержит короткую, и первой обязана идти длинная.
  //   «не принимаю работу» содержит «принимаю работу» -> возврат перед приёмкой;
  //   «не возьму»          содержит «возьму»          -> отказ перед началом;
  //   «принял работу»      содержит «принял»          -> приёмка перед началом.
  if (V_RETURN.test(phrase) && author) {
    if (task.status !== 'done') return null;
    // Кому вернуть: всем, кто сдал. У рассылки сдавших может быть несколько.
    const { results: submitted } = await env.DB.prepare(
      "SELECT * FROM task_assignees WHERE task_id = ? AND org_id = ? AND state = 'done'",
    ).bind(task.id, who.orgId).all<Assignee>();
    if (submitted.length === 0) return null;
    // Новый срок: названный во фразе, иначе завтрашний день. Молча оставлять
    // прежний нельзя -- он уже прошёл, раз работу сдавали, и задача вернулась бы
    // просроченной в ту же секунду.
    const when = matchDeadline(phrase, now, timeZone, dayEndHm, weekEnd);
    const newDeadline = when.iso ?? new Date(now.getTime() + 24 * 60 * 60 * 1000).toISOString();
    const comment = phrase.trim().slice(0, 500);
    for (const a of submitted) {
      await transitionAssignee(env, {
        task, assignee: a, to: 'rejected', actorId: who.userId, reason: comment, dueAt: newDeadline,
        notify: { emoji: '❌', label: 'Отклонено, возвращено в работу', extraLine: `Причина: ${comment}` },
      });
    }
    // Срок самой задачи тоже сдвигается: списки показывают его, а не персональные.
    await applyTransition(env, {
      task, to: 'in_progress', actorId: who.userId, action: 'rejected', comment,
      set: { done_at: null, confirmed_at: null, deadline: newDeadline },
    });
    return { taskId: task.id, text: `❌ «${task.title}» вернул в работу. Новый срок — ${formatWhen(newDeadline, timeZone)}.` };
  }
  if (V_CONFIRM.test(phrase) && author) {
    if (task.status !== 'done' || task.confirmed_at) return null;
    await confirmWork(env, task, who.userId);
    return { taskId: task.id, text: `✅ «${task.title}» принята. Задача закрыта.` };
  }
  if (mine && V_DECLINE.test(phrase)) {
    // Причина -- сама фраза, как и у «не успеваю». Автору уходит карточка с
    // кнопками «Переназначить» и «Отменить задачу»: отказ по ошибке
    // отыгрывается назад переназначением, а не правкой базы.
    const res = await declineAssignee(env, task, mine, who.userId, phrase);
    if (!res.ok) return null;
    return { taskId: task.id, text: `🚫 Отказ передан автору: «${task.title}».` };
  }
  if (mine && V_LATE.test(phrase)) {
    // Причина -- сама фраза: человек уже всё объяснил, второй раз спрашивать
    // незачем. Автор получит её вместе с кнопками «перенести срок» и прочими.
    if (!(await lateAssignee(env, task, mine, who.userId, phrase))) return null;
    return { taskId: task.id, text: `⏳ Передал автору: не успеваете по «${task.title}».` };
  }
  // «Начал» по уже принятой задаче -- отметка времени, а не переход.
  if (mine && V_START.test(phrase) && !V_DONE.test(phrase) && mine.state === 'accepted' && !mine.started_at) {
    await startWork(env, task, mine, who.userId);
    return { taskId: task.id, text: `🚀 «${task.title}» — в работе.` };
  }
  if (mine && (V_ACCEPT.test(phrase) || V_START.test(phrase) || V_DONE.test(phrase))) {
    const to = V_DONE.test(phrase) ? 'done' : 'accepted';
    // Зависимость держит старт так же, как в приложении: «проверить договор»
    // нельзя начать раньше «составить договор».
    if (to === 'accepted' && task.depends_on_task_id) {
      const dep = await env.DB.prepare('SELECT title, status FROM tasks WHERE id = ? AND org_id = ?')
        .bind(task.depends_on_task_id, who.orgId).first<{ title: string; status: string }>();
      if (dep && dep.status !== 'done' && dep.status !== 'archived') {
        return { taskId: task.id, text: `⛔️ Сначала «${dep.title}» — «${task.title}» ждёт её.` };
      }
    }
    // «Готово» из «не принял» -- две ступени сразу: человек не обязан сперва
    // нажимать «в работу», если он уже всё сделал.
    const steps = to === 'done' && mine.state === 'pending' ? (['accepted', 'done'] as const) : ([to] as const);
    let row = mine;
    for (const step of steps) {
      const res = await transitionAssignee(env, {
        task, assignee: row, to: step, actorId: who.userId,
        notify: step === to
          ? (to === 'accepted' ? { emoji: '🚀', label: 'Принято', track: true } : { emoji: '✅', label: 'Готово', deletePrevious: true })
          : undefined,
      });
      if (!res.ok) return null; // переход не разрешён -- значит это была не команда
      row = { ...row, state: step, accepted_at: row.accepted_at ?? nowIso() };
    }
    // ЗАДАЧА СЕБЕ закрывается сразу: спрашивать у себя же «примите работу» не у кого.
    const fresh = await env.DB.prepare('SELECT * FROM tasks WHERE id = ?').bind(task.id).first<Task>();
    if (to === 'done' && author && fresh && fresh.status === 'done' && !fresh.confirmed_at) {
      const live = await loadAssignees(env, task.id, who.orgId);
      if (live.filter((a) => a.state !== 'declined').every((a) => a.user_id === who.userId)) {
        await confirmWork(env, fresh, who.userId, false);
      }
    }
    // «Взял в работу» на непринятой задаче делает оба шага сразу: согласие и
    // начало. Отдельного «примите сначала» человек не поймёт -- он уже сказал,
    // что делает.
    if (to === 'accepted' && V_START.test(phrase)) {
      const fresh = await myAssignee(env, task.id, who.userId, who.orgId);
      if (fresh) await startWork(env, task, fresh, who.userId);
      return { taskId: task.id, text: `🚀 «${task.title}» — в работе.` };
    }
    return {
      taskId: task.id,
      text: to === 'accepted' ? `👌 «${task.title}» принята.` : `✅ «${task.title}» сдана на проверку.`,
    };
  }

  // ---- правка полей. Только АВТОР: срок и важность -- его решения, а
  // исполнителю для «не успеваю» есть ветка выше.
  if (!author || !EDIT_VERB.test(phrase)) return null;
  const when = matchDeadline(phrase, now, timeZone, dayEndHm, weekEnd);
  const pri = matchPriority(phrase, packId);
  const rename = RENAME.reduce<RegExpMatchArray | null>((hit, re) => hit ?? phrase.match(re), null);
  const newTitle = rename ? rename[1].trim().replace(/^[«"']|[»"'.]$/g, '') : null;

  const said: string[] = [];
  if (when.iso) {
    await setTaskDeadline(env, task.id, who.orgId, when.iso);
    said.push(`срок — ${formatWhen(when.iso, timeZone)}`);
  }
  if (pri.usedWords.size > 0 && pri.priority !== task.priority) {
    await env.DB.prepare('UPDATE tasks SET priority = ?, updated_at = ? WHERE id = ? AND org_id = ?')
      .bind(pri.priority, nowIso(), task.id, who.orgId).run();
    said.push(`важность — ${PRI_RU[pri.priority]}`);
  }
  if (newTitle && newTitle.length >= 3 && newTitle.toLowerCase() !== task.title.toLowerCase()) {
    await env.DB.prepare('UPDATE tasks SET title = ?, updated_at = ? WHERE id = ? AND org_id = ?')
      .bind(newTitle[0].toUpperCase() + newTitle.slice(1), nowIso(), task.id, who.orgId).run();
    said.push(`тема — «${newTitle}»`);
  }
  // Условие (3): глагол был, задача нашлась, а менять нечего -- не команда.
  if (said.length === 0) return null;

  await logEvent(env.DB, { actorId: who.userId, orgId: who.orgId, targetType: 'task', targetId: task.id, action: 'edited' });
  return { taskId: task.id, text: `✏️ «${task.title}»: ${said.join(', ')}.` };
}
