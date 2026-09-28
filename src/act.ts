// Исполнение того, что поняла модель (brain.ts), -- теми же функциями, что
// кнопки и правила: черновик -- saveDraft, этапы задачи -- runTaskOp, отмена
// -- кнопкой «🗑 Отменить задачу» с подтверждением. Своих путей изменения
// данных здесь нет, только выбор, какой из существующих вызвать.
import type { Env, Role, Task } from './types';
import { understand, type Act, type BrainCtx, type Plan } from './brain';
import { assignableMembers } from './hierarchy';
import { lastMentioned, runTaskOp, type TaskOp } from './intake';
import {
  assigneesOf, confirmDraft, draftAssignable, latestDraft, listDrafts, mediaOf, patchDraft, removeDraft,
  renderCreated, renderDraft, saveDraft,
} from './drafts';
import { formatWhen, matchPeople, matchPriority, refineDraft, type Draft, type Person } from './parse';
import { dayEnd, weekEndDay, type OrgSchedule } from './schedule';
import { sendMessage } from './telegram';
import { openButton } from './transition';
import { drainOutbox } from './outbox';
import type { Media } from './media';

export type Turn = {
  /** Списки показывает бот: страницы задач и карточки черновиков живут там. */
  show: ('my_tasks' | 'assigned' | 'drafts')[];
  /** Вопрос -- помощнику, со всей его памятью разговора. */
  ask: boolean;
  /** Уточняющий вопрос модели: бот кладёт его в историю разговора. */
  asked: string | null;
};

type Who = { userId: string; orgId: string; role: Role };

async function buildCtx(env: Env, who: Who, sched: OrgSchedule, history: BrainCtx['history'], now: Date, pointedId?: string): Promise<BrainCtx> {
  const tz = sched.timezone;
  const members = await assignableMembers(env, who.orgId, who.userId, who.role);
  const meRow = await env.DB.prepare('SELECT name FROM users WHERE id = ?').bind(who.userId).first<{ name: string }>();
  // Ответили на сообщение о задаче -- она и есть «та самая», сколько бы
  // времени ни прошло; иначе -- последняя, о которой бот писал.
  const last = pointedId ? { id: pointedId } : await lastMentioned(env, who.orgId, who.userId, now);
  // Задачи, о которых человек может говорить: его и им поручённые, ещё живые.
  // Последняя упомянутая -- всегда первой: на неё указывает голое «готово».
  const { results } = await env.DB.prepare(
    `SELECT t.id, t.title, t.author_id, t.status, t.deadline,
            (SELECT a.state FROM task_assignees a WHERE a.task_id = t.id AND a.user_id = ?) AS mine,
            (SELECT group_concat(u.name || ' (' || a.state || ')', ', ') FROM task_assignees a JOIN users u ON u.id = a.user_id
              WHERE a.task_id = t.id AND a.state <> 'declined') AS who
     FROM tasks t
     WHERE t.org_id = ? AND t.status IN ('todo','in_progress','done') AND t.confirmed_at IS NULL
       AND (t.author_id = ? OR EXISTS (SELECT 1 FROM task_assignees a WHERE a.task_id = t.id AND a.user_id = ? AND a.state <> 'declined'))
     ORDER BY t.id = ? DESC, t.updated_at DESC LIMIT 30`,
  ).bind(who.userId, who.orgId, who.userId, who.userId, last?.id ?? '')
    .all<{ id: string; title: string; author_id: string | null; status: string; deadline: string | null; mine: string | null; who: string | null }>();
  const drafts = await listDrafts(env, who.userId, who.orgId);
  return {
    now,
    sched,
    me: { id: who.userId, name: meRow?.name ?? '' },
    people: members.filter((m) => m.id !== who.userId).map((m) => ({
      id: m.id, name: m.name, aliases: m.aliases ? (JSON.parse(m.aliases) as string[]) : undefined,
    })),
    tasks: results.map((t) => ({
      id: t.id, title: t.title, author: t.author_id === who.userId, mine: t.mine,
      status: t.status === 'done' ? 'submitted' : t.status === 'todo' ? 'not started' : 'in progress',
      due: t.deadline ? formatWhen(t.deadline, tz) : null, who: t.who ?? 'nobody', last: t.id === last?.id,
    })),
    drafts: drafts.slice(0, 15).map((d) => ({ id: d.id, title: d.title.trim(), due: d.deadline ? formatWhen(d.deadline, tz) : null })),
    history,
  };
}

/** Ответ модели -> команда runTaskOp. null -- удаление: оно идёт через подтверждение. */
function taskOp(a: Extract<Act, { type: 'task' }>, reason: string, pred: Task | null): TaskOp | null {
  switch (a.op) {
    case 'done': case 'accept': case 'start': case 'confirm': case 'remind': return { op: a.op };
    case 'late': case 'decline': return { op: a.op, reason };
    case 'return': return { op: 'return', reason, deadline: a.deadline };
    case 'reschedule': return { op: 'edit', deadline: a.deadline };
    case 'set_priority': return { op: 'edit', priority: a.priority };
    case 'rename': return { op: 'edit', title: a.title };
    case 'after': return pred ? { op: 'after', pred } : null;
    case 'delete': return null;
  }
}

/**
 * Понять фразу моделью и сделать. null -- модель выключена или не ответила
 * внятно: бот ведёт фразу старым путём правил, и человек этого не замечает.
 */
export async function brainTurn(
  env: Env, who: Who, phrase: string, chat: string, media: Media | null,
  history: BrainCtx['history'], roster: Person[], sched: OrgSchedule, packId?: string | null,
  /** Задача сообщения, на которое ответили. */
  pointedId?: string,
): Promise<Turn | null> {
  if (env.BRAIN !== '1' || !env.GROQ_API_KEY) return null;
  // Тёзки -- переспрос «кого именно?», а не выбор модели: поручение, ушедшее
  // не тому, дороже вопроса. Это умеет старый путь, и фраза уходит туда.
  if (matchPeople(phrase, roster).ambiguous.length > 0) return null;
  const now = new Date();
  let plan;
  try {
    plan = await understand(env, await buildCtx(env, who, sched, history, now, pointedId), phrase);
  } catch (e) {
    console.error('brain ctx', String(e));
    return null;
  }
  if (!plan) return null;
  console.log('brain', JSON.stringify({ phrase: phrase.slice(0, 200), plan }));
  try {
    return await perform(env, who, phrase, chat, media, plan, roster, sched, packId, now);
  } catch (e) {
    // Ответить Telegram всё равно нужно: иначе он пришлёт то же сообщение
    // снова, и уже сделанное сделалось бы второй раз.
    console.error('brain act', String(e));
    await sendMessage(env, chat, 'Сделал не всё — проверьте в приложении.').catch(() => undefined);
    return { show: [], ask: false, asked: null };
  }
}

async function perform(
  env: Env, who: Who, phrase: string, chat: string, media: Media | null, plan: Plan,
  roster: Person[], sched: OrgSchedule, packId: string | null | undefined, now: Date,
): Promise<Turn> {
  const tz = sched.timezone;

  const turn: Turn = { show: [], ask: false, asked: plan.clarify };
  if (plan.clarify) {
    await sendMessage(env, chat, plan.clarify);
    return turn;
  }

  const lines: string[] = [];
  let changed = false;
  let attach = media ? [media] : [];
  // Одно действие -- причина и важность из всей фразы, словарём (у него и слова
  // отраслей). Несколько -- от модели по каждому: «Азизу срочно отчёт, а мне
  // хлеб» не делает срочным хлеб, а причина одного не уходит другому.
  const single = plan.actions.length === 1;
  const dict = matchPriority(phrase, packId);
  for (const a of plan.actions) {
    switch (a.type) {
      case 'create': {
        const priority = a.priority ?? (single && dict.usedWords.size > 0 ? dict.priority : null);
        const draft: Draft = {
          title: a.title, description: a.description, assigneeIds: a.assigneeIds, deadline: a.deadline,
          repeatMin: a.repeatMin, checklist: a.checklist.length >= 2 ? a.checklist : null,
          priority: priority ?? 'medium', priorityExplicit: priority !== null,
          kind: a.ack ? 'ack' : a.assigneeIds.length > 1 ? 'each' : 'single',
          source: 'llm', ambiguous: [],
        };
        // Черновик из файла без подписи ждёт ответа «чего это касается?» --
        // первая же суть достаётся ему, а не новому черновику рядом.
        const waiting = await latestDraft(env, who.userId, who.orgId);
        if (waiting && !waiting.title.trim()) {
          const updated = await patchDraft(env, waiting.id, {
            title: draft.title, description: draft.description ?? null, assigneeIds: draft.assigneeIds,
            deadline: draft.deadline, repeatMin: draft.repeatMin ?? null,
            priority: draft.priority, priorityExplicit: draft.priorityExplicit, kind: draft.kind,
            ...(attach.length ? { media: [...mediaOf(waiting), ...attach] } : {}),
          });
          if (updated) await renderDraft(env, updated, chat, tz, true);
        } else {
          await renderDraft(env, await saveDraft(env, who, draft, phrase, attach), chat, tz);
        }
        attach = []; // файл -- к первому черновику, а не к каждому
        break;
      }
      case 'task': {
        const task = await env.DB.prepare('SELECT * FROM tasks WHERE id = ? AND org_id = ?').bind(a.taskId, who.orgId).first<Task>();
        if (!task) {
          lines.push('Эта задача уже недоступна.');
          break;
        }
        if (a.op === 'delete') {
          // Отмена необратима и уходит исполнителям -- только кнопкой, как у
          // карточки отказа. Модель предлагает, человек нажимает.
          if (task.author_id !== who.userId) {
            lines.push(`«${task.title}» поручили вам — отменить её может только автор.`);
            break;
          }
          await sendMessage(env, chat, `Отменить «${task.title}»? Исполнители получат уведомление.`, {
            inline_keyboard: [[{ text: '🗑 Отменить задачу', callback_data: `cancel:${task.id}` }, { text: 'Оставить', callback_data: `keep:${task.id}` }]],
          });
          break;
        }
        const pred = a.afterId
          ? await env.DB.prepare('SELECT * FROM tasks WHERE id = ? AND org_id = ?').bind(a.afterId, who.orgId).first<Task>()
          : null;
        const cmd = taskOp(a, single ? phrase : a.reason ?? '', pred);
        if (!cmd) {
          lines.push(`Не нашёл задачу, после которой делать «${task.title}».`);
          break;
        }
        const res = await runTaskOp(env, who, task, cmd, tz, now);
        if (typeof res === 'string') lines.push(res);
        else {
          changed = true;
          await sendMessage(env, chat, res.text, { inline_keyboard: [[openButton(res.taskId)]] });
        }
        break;
      }
      case 'draft': {
        const rows = await listDrafts(env, who.userId, who.orgId);
        const picked = a.draftId === 'all' ? rows : rows.filter((r) => r.id === a.draftId);
        if (picked.length === 0) {
          lines.push('Этого черновика уже нет.');
          break;
        }
        if (a.op === 'delete') {
          for (const r of picked) await removeDraft(env, r.id);
          // Отмены у удаления нет -- поэтому тема удалённого называется.
          lines.push(`Удалено: ${picked.map((r) => `«${r.title.trim() || 'без темы'}»`).join(', ')}.`);
          break;
        }
        const row = picked[0];
        if (a.op === 'edit') {
          const patch = await refineDraft(env, {
            title: row.title, description: row.description, assigneeIds: assigneesOf(row), deadline: row.deadline,
            priority: row.priority, priorityExplicit: row.priority_explicit === 1,
          }, a.fix!, roster, tz, packId, now, dayEnd(sched), weekEndDay(sched));
          const updated = Object.keys(patch).length ? await patchDraft(env, row.id, patch) : null;
          if (updated) await renderDraft(env, updated, chat, tz, true);
          else lines.push(`Не понял, что поправить в «${row.title.trim() || 'без темы'}».`);
          break;
        }
        // «Создай» -- то же, что кнопка: пустую тему и недоступного адресата не пропускаем.
        if (row.title.trim().length < 2) lines.push('Сначала напишите, чего касается черновик.');
        else if (!(await draftAssignable(env, row))) lines.push('Кому-то из адресатов сейчас поручать нельзя — поправьте черновик.');
        else {
          const taskId = await confirmDraft(env, row);
          if (taskId) {
            changed = true;
            await renderCreated(env, row, chat, tz, taskId);
          } else lines.push('Вас пока не добавили ни на одну доску — попросите руководителя.');
        }
        break;
      }
      case 'show':
        turn.show.push(a.what);
        break;
      case 'ask':
        turn.ask = true;
        break;
      case 'reply':
        lines.push(a.text);
        break;
    }
  }
  if (lines.length) await sendMessage(env, chat, lines.join('\n\n'));
  if (changed) await drainOutbox(env);
  return turn;
}
