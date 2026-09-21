// Понимание фразы моделью: ОДИН запрос, ответ -- действия по строгой схеме.
//
// Раньше фразу вели правила и три отдельных вызова модели (намерение, разбор,
// помощник), и каждый видел её по-своему: «напомни мне завтра» уходило в
// вопрос, «заверши её» -- в новую задачу. Здесь модель видит всё сразу --
// людей, задачи, черновики, разговор -- и отвечает не текстом, а действиями.
//
// Что сделано ради точности (по замерам, см. разбор в переписке):
//  - строгая схема (constrained decoding): ответ не может выйти из формы;
//  - люди, задачи и черновики -- перечислением коротких ссылок (p1, t3, d1):
//    выдумать id модель физически не может;
//  - дату модель НЕ считает: описывает сказанное, календарь -- when.ts;
//  - инструкция по-английски, свободный текст (темы, вопросы) -- по-русски;
//  - неверный по смыслу ответ -- один повтор с названной ошибкой, потом null,
//    и фраза идёт старым путём правил.
import type { Env } from './types';
import { resolveRepeat, resolveWhen, type Part, type Repeat, type Sched, type When } from './when';

const GROQ = 'https://api.groq.com/openai/v1';

export type BrainCtx = {
  now: Date;
  sched: Sched;
  me: { id: string; name: string };
  /** Кому можно поручать, без самого человека. */
  people: { id: string; name: string; aliases?: string[] }[];
  tasks: {
    id: string; title: string; author: boolean;
    /** Состояние строки человека-исполнителя; null -- он не исполнитель. */
    mine: string | null;
    status: string; due: string | null; who: string;
    /** О ней бот писал последней: на неё указывают «её», «готово». */
    last: boolean;
  }[];
  drafts: { id: string; title: string; due: string | null }[];
  history: { role: 'user' | 'assistant'; text: string }[];
};

export const TASK_OPS = ['done', 'accept', 'start', 'late', 'decline', 'confirm', 'return', 'reschedule', 'set_priority', 'rename', 'remind', 'delete', 'after'] as const;
export type TaskOpName = typeof TASK_OPS[number];
/** Что делает исполнитель; всё остальное -- решения автора. */
const BY_ASSIGNEE = new Set<string>(['done', 'accept', 'start', 'late', 'decline']);
type Priority = 'urgent' | 'medium' | 'low';

export type Act =
  | { type: 'create'; title: string; description: string | null; assigneeIds: string[]; ack: boolean; deadline: string | null; repeatMin: number | null; checklist: string[]; priority: Priority | null }
  | { type: 'task'; taskId: string; op: TaskOpName; deadline: string | null; priority: Priority | null; title: string | null; afterId: string | null; reason: string | null }
  | { type: 'draft'; draftId: string | 'all'; op: 'delete' | 'create' | 'edit'; fix: string | null }
  | { type: 'show'; what: 'my_tasks' | 'assigned' | 'drafts' }
  | { type: 'ask' }
  | { type: 'reply'; text: string };

export type Plan = { actions: Act[]; clarify: string | null };

// ------------------------------------------------------------------ схема

const obj = (properties: Record<string, unknown>, description?: string) => ({
  type: 'object', ...(description ? { description } : {}),
  properties, required: Object.keys(properties), additionalProperties: false,
});
const oneOf = (values: readonly string[], description?: string) => ({ type: 'string', enum: values, ...(description ? { description } : {}) });
const str = (description?: string) => ({ type: ['string', 'null'], ...(description ? { description } : {}) });
const int = (description?: string) => ({ type: ['integer', 'null'], ...(description ? { description } : {}) });

const PARTS = ['none', 'morning', 'noon', 'afternoon', 'evening', 'end_of_day'] as const;
const WHEN = obj({
  kind: oneOf(['none', 'in', 'today', 'tomorrow', 'after_tomorrow', 'weekday', 'date', 'day_of_month', 'end_of_week', 'end_of_month']),
  amount: int('for kind=in'),
  unit: oneOf(['none', 'minutes', 'hours', 'days', 'weeks', 'months'], 'for kind=in'),
  weekday: int('1=Monday … 7=Sunday'),
  day: int('day of month'),
  month: int('1-12'),
  time: str('exact clock time HH:MM, 24h'),
  part: oneOf(PARTS),
});
const REPEAT = obj({
  every: oneOf(['none', 'day', 'week', 'month', 'n_days', 'n_weeks']),
  n: int('for n_days / n_weeks'),
  weekday: int('1=Monday … 7=Sunday'),
  day: int('day of month, for every=month'),
  time: str('HH:MM, 24h'),
  part: oneOf(PARTS),
});

const refs = (prefix: string, n: number) => Array.from({ length: n }, (_, i) => `${prefix}${i + 1}`);

export function schema(ctx: BrainCtx) {
  const people = ['me', ...refs('p', ctx.people.length)];
  const tasks = refs('t', ctx.tasks.length);
  const drafts = refs('d', ctx.drafts.length);
  const kinds: unknown[] = [
    obj({
      type: oneOf(['create']),
      title: { type: 'string' },
      description: str(),
      assignees: { type: 'array', items: oneOf(people) },
      announcement: { type: 'boolean' },
      priority: oneOf(['none', 'urgent', 'medium', 'low'], 'none unless importance is said'),
      checklist: { type: 'array', items: { type: 'string' } },
      when: WHEN,
      repeat: REPEAT,
    }, 'a new task or reminder'),
    obj({ type: oneOf(['show']), what: oneOf(['my_tasks', 'assigned', 'drafts']) }),
    obj({ type: oneOf(['ask']) }, 'a question for the assistant'),
    obj({ type: oneOf(['reply']), text: { type: 'string' } }, 'small talk only'),
  ];
  // Пустое перечисление схема не допускает -- нет задач, нет и действия над ними.
  if (tasks.length) {
    kinds.splice(1, 0, obj({
      type: oneOf(['task']),
      task: oneOf(tasks),
      op: oneOf(TASK_OPS),
      when: WHEN,
      priority: oneOf(['none', 'urgent', 'medium', 'low']),
      title: str('new title, for op=rename'),
      after: oneOf(['none', ...tasks], 'for op=after'),
      reason: str('for late / decline / return: the reason in the user\'s words, Russian'),
    }, 'an operation on an existing task'));
  }
  if (drafts.length) {
    kinds.splice(1, 0, obj({
      type: oneOf(['draft']),
      draft: oneOf([...drafts, 'all']),
      op: oneOf(['delete', 'create', 'edit']),
      fix: str('for op=edit: the correction as said, Russian'),
    }, 'an operation on an unconfirmed draft'));
  }
  return obj({
    actions: { type: 'array', items: { anyOf: kinds } },
    clarify: str('a short question in Russian, only with empty actions'),
  });
}

// ------------------------------------------------------------------ подсказка

const RULES = `You turn one message from a Hando user into structured actions. Hando is a Telegram bot for tasks in small teams and families. Messages are in Russian, often dictated by voice: expect filler words («ну», «короче», «это самое», «наверное»), recognition errors and several requests in one message.

Put every request of the message into "actions", in the order spoken. Never invent requests.

ACTIONS
create — a NEW task or reminder. «напомни мне …», «надо …», «нужно …», «купить …», «Азизу подготовить …» are new tasks, even when they start with «напомни». «передай Маше, что …» / «скажи Маше …» → a task for Маша (announcement=true when it is only information). Several independent things to do → several create actions. A list of items inside one errand («купить молоко, хлеб, яйца») → one create with "checklist".
  title: the essence in 2–6 Russian words, imperative infinitive («Подготовить отчёт», «Позвонить маме»); no names, dates, times, priority words, filler.
  description: other useful details in Russian (purpose, place, conditions) or null. Never repeat the title.
  assignees: refs from PEOPLE who must do it. [] or ["me"] = the user. «мне и Азизу» → ["me","p1"].
  announcement: true only for «ознакомиться / прочитать / довести до сведения».
  priority: urgent («срочно», «горит») / low («не срочно», «когда будет время») only when said about THIS task; otherwise none.
  when, repeat: see DATES.
task — an operation on an EXISTING task from TASKS. When the message points at one of them: by title words in any form («с цветами» → «Мои цветы поливать через день»), or by «её / эту / это / задачу» / a bare «готово / сделал» → the task marked LAST (never clarify then). Check the user's role in TASKS: assignee ops only for tasks where the user is an assignee, author ops only where the user is the author. ops:
  done — the user finished a task assigned to them («готово», «сделал», «полил цветы» for «Полить цветы»).
  accept — agrees to take it. start — began working on it.
  late — (assignee) cannot make it in time («не успеваю с цветами, завтра полью» → late, not a new task). decline — (assignee) refuses.
  confirm — (author) accepts submitted work («принимаю работу …»). return — (author) rejects submitted work; "when" = new deadline if said.
  reschedule — (author) new deadline in "when". set_priority — (author) "priority". rename — (author) new "title".
  remind — (author) nudge the assignees now («напомни Азизу про отчёт», «поторопи Бека»).
  delete — (author) cancel the task completely. after — the task may start only after the task in "after" is done.
  A reminder for the user themself at a time («напомни мне завтра про отчёт») is a create, not remind.
draft — DRAFTS are unconfirmed tasks waiting for the «Создать» button. op: delete (one draft, or "all"), create (press «Создать»), edit ("fix" = the correction as said).
show — the user wants a list: my_tasks («мои задачи»), assigned («мои поручения», «что я поручил»), drafts («черновики», «какие у меня черновики?»).
ask — a question that needs an answer: how to use Hando, planning advice, status of tasks («что с отчётом?», «что горит?», «какие задачи у Азиза?»), anything else that is not a command. The assistant answers it; do not answer yourself.
reply — small talk only (thanks, greetings, «ок»): a short friendly reply in Russian.
clarify — a short question in Russian, with actions = []. Only when the message is a command but you cannot tell WHICH task / draft / person is meant, or nothing actionable is said (a bare name, a bare date). A missing deadline or assignee is never a reason to clarify. If your previous message was a clarifying question, the new message answers it: act on both together.

DATES — never calculate dates. Describe what was said; code computes the calendar.
  when.kind: none | in (amount + unit: «через 2 дня», «через полчаса» = 30 minutes) | today | tomorrow | after_tomorrow | weekday (1=Mon … 7=Sun) | date (day + month) | day_of_month (day) | end_of_week | end_of_month.
  when.time: an exact clock time "HH:MM", 24h («в 7 вечера» → "19:00", «полдесятого» → "09:30", «после 12» → "12:00", never a part of day). A bare hour 1–6 without «утра / ночи» is afternoon: «в 3» → "15:00", «к 5» → "17:00". when.part: morning | noon («в обед», «к обеду») | afternoon («после обеда») | evening | end_of_day | none. Use time or part, not both: a named hour always goes to time («в 8 утра» → "08:00", «после 12» → "12:00"); part only when no hour is said («утром», «вечером»).
  «до», «к», «в течение» mark a deadline like «в»: «до пятницы» → weekday 5; «в течение недели» → end_of_week; «в течение месяца» → end_of_month. A time alone («в 5») with other content → kind today.
  repeat.every: none | day | week (+ weekday) | month (+ day) | n_days (+ n: «через день» = 2, «каждые 3-4 дня» = 3) | n_weeks (+ n). «по выходным» → week, weekday 6. repeat.time / part as in when. For a repeating task leave when.kind = none.

REFERENCES — use only the refs given (me, p1…, t1…, d1…). A person missing from PEOPLE cannot be an assignee: mention them in the description.

EXAMPLES (refs illustrative)
«Азизу до пятницы подготовить отчёт, срочно» → create {title "Подготовить отчёт", assignees ["p1"], when {kind weekday, weekday 5}}
«напомни мне через 2 минуты посмотреть оформление» → create {title "Посмотреть оформление", when {kind in, amount 2, unit minutes}}
«готово» → task {task = the LAST one, op done}
«перенеси отчёт на понедельник» → task {task = «Подготовить отчёт», op reschedule, when {kind weekday, weekday 1}}
«поливать цветы через день» → create {title "Поливать цветы", repeat {every n_days, n 2}}
«удали черновик про сетки» → draft {draft = the one about сетки, op delete}
«как отметить выполненную?» → ask
«спасибо» → reply`;

/** Темы и имена пишут другие люди: перевод строки подделал бы строку TASKS или PEOPLE. */
const one = (s: string) => s.replace(/\s+/g, ' ').trim();

function context(ctx: BrainCtx): string {
  const local = new Intl.DateTimeFormat('en-GB', {
    timeZone: ctx.sched.timezone, weekday: 'long', year: 'numeric', month: '2-digit', day: '2-digit', hour: '2-digit', minute: '2-digit',
  }).format(ctx.now);
  const people = [`me = ${one(ctx.me.name)} (the user)`,
    ...ctx.people.map((p, i) => `p${i + 1} = ${one(p.name)}${p.aliases?.length ? ` (also: ${one(p.aliases.join(', '))})` : ''}`)];
  const tasks = ctx.tasks.map((t, i) => {
    const role = [t.author ? 'author' : null, t.mine ? `assignee (${t.mine})` : null].filter(Boolean).join(' + ');
    return `t${i + 1} = «${one(t.title)}» · user is ${role} · assignees: ${one(t.who)} · status: ${t.status} · due: ${t.due ?? 'none'}${t.last ? ' · LAST' : ''}`;
  });
  const drafts = ctx.drafts.map((d, i) => `d${i + 1} = «${one(d.title) || 'no title yet'}» · due: ${d.due ?? 'none'}`);
  return [
    `NOW: ${local} (${ctx.sched.timezone})`,
    'PEOPLE:\n' + people.join('\n'),
    'TASKS:\n' + (tasks.join('\n') || '(none)'),
    'DRAFTS (newest first):\n' + (drafts.join('\n') || '(none)'),
  ].join('\n\n');
}

// ------------------------------------------------------------------ ответ

type RawWhen = { kind: string; amount: number | null; unit: string; weekday: number | null; day: number | null; month: number | null; time: string | null; part: string };
type RawRepeat = { every: string; n: number | null; weekday: number | null; day: number | null; time: string | null; part: string };
type Raw = { actions: Record<string, unknown>[]; clarify: string | null };

const none = <T extends string>(v: string): T | null => (v === 'none' ? null : v as T);

/** Важность -- только из перечня: любое другое значение значит «не сказана». */
const priorityOf = (v: unknown): Priority | null => (v === 'urgent' || v === 'medium' || v === 'low' ? v : null);

const HHMM = /^([01]?\d|2[0-3]):[0-5]\d$/;
const within = (v: number | null, lo: number, hi: number) => v !== null && Number.isInteger(v) && v >= lo && v <= hi;

/** Негодное описание срока -- словами для повтора: иначе when.ts молча подставил бы понедельник или конец дня. */
function badWhen(w: RawWhen): string | null {
  if (w.kind === 'none') return null;
  if (w.time !== null && !HHMM.test(w.time)) return 'when.time must be HH:MM or null';
  if (w.kind === 'in' && (!within(w.amount, 1, 1000) || w.unit === 'none')) return 'when kind=in needs amount >= 1 and a unit';
  if (w.kind === 'weekday' && !within(w.weekday, 1, 7)) return 'when.weekday must be 1..7';
  if ((w.kind === 'date' || w.kind === 'day_of_month') && !within(w.day, 1, 31)) return 'when.day must be 1..31';
  if (w.kind === 'date' && w.month !== null && !within(w.month, 1, 12)) return 'when.month must be 1..12';
  return null;
}

function badRepeat(r: RawRepeat): string | null {
  if (r.every === 'none') return null;
  if (r.time !== null && !HHMM.test(r.time)) return 'repeat.time must be HH:MM or null';
  if ((r.every === 'n_days' || r.every === 'n_weeks') && !within(r.n, 1, 365)) return 'repeat.n must be >= 1';
  if (r.weekday !== null && !within(r.weekday, 1, 7)) return 'repeat.weekday must be 1..7';
  if (r.day !== null && !within(r.day, 1, 31)) return 'repeat.day must be 1..31';
  return null;
}

function toWhen(w: RawWhen): When | null {
  if (!w || w.kind === 'none') return null;
  return { ...w, kind: w.kind as When['kind'], unit: none(w.unit), part: none<Part>(w.part) };
}

function toRepeat(r: RawRepeat): Repeat | null {
  if (!r || r.every === 'none') return null;
  return { ...r, every: r.every as Repeat['every'], part: none<Part>(r.part) };
}

/**
 * Ответ модели -> действия с настоящими id и посчитанными сроками. Строка --
 * что не так по смыслу: её модель получит при повторе.
 */
export function resolve(raw: Raw, ctx: BrainCtx): Plan | string {
  const byRef = <T extends { id: string }>(list: T[], prefix: string, ref: unknown): T | undefined =>
    typeof ref === 'string' && ref.startsWith(prefix) ? list[Number(ref.slice(prefix.length)) - 1] : undefined;
  const person = (ref: unknown) => (ref === 'me' ? ctx.me : byRef(ctx.people, 'p', ref));
  const actions: Act[] = [];
  for (const [i, a] of (raw.actions ?? []).entries()) {
    const at = `actions[${i}]`;
    switch (a.type) {
      case 'create': {
        const title = String(a.title ?? '').trim();
        if (title.length < 2) return `${at}: empty title`;
        const who = (a.assignees as unknown[]).map(person);
        if (who.some((p) => !p)) return `${at}: unknown assignee ref`;
        const bad = badWhen(a.when as RawWhen) ?? badRepeat(a.repeat as RawRepeat);
        if (bad) return `${at}: ${bad}`;
        const repeat = resolveRepeat(toRepeat(a.repeat as RawRepeat), ctx.now, ctx.sched);
        actions.push({
          type: 'create', title: title[0].toUpperCase() + title.slice(1),
          description: typeof a.description === 'string' && a.description.trim() ? a.description.trim() : null,
          assigneeIds: who.length ? [...new Set(who.map((p) => p!.id))] : [ctx.me.id],
          ack: a.announcement === true,
          deadline: resolveWhen(toWhen(a.when as RawWhen), ctx.now, ctx.sched) ?? repeat?.first ?? null,
          repeatMin: repeat?.minutes ?? null,
          checklist: ((a.checklist as unknown[]) ?? []).map((s) => String(s).trim()).filter(Boolean),
          priority: priorityOf(a.priority),
        });
        break;
      }
      case 'task': {
        const task = byRef(ctx.tasks, 't', a.task);
        if (!task) return `${at}: unknown task ref`;
        const op = a.op as TaskOpName;
        if (!TASK_OPS.includes(op)) return `${at}: unknown op`;
        const bad = badWhen(a.when as RawWhen);
        if (bad) return `${at}: ${bad}`;
        // Роль -- частая ошибка модели: «принимаю работу» автора она читала как
        // «принял задачу», а «отчёт готов» от автора -- как «сдал сам». Повтор
        // с объяснением исправляет это до того, как runTaskOp откажет.
        if (BY_ASSIGNEE.has(op) && !task.mine) {
          return `${at}: the user is not an assignee of ${a.task}, so "${op}" is impossible. `
            + (task.author ? 'As its author: confirm / return / remind / reschedule, or ask.' : 'Use ask.');
        }
        if (!BY_ASSIGNEE.has(op) && !task.author) {
          return `${at}: the user is not the author of ${a.task}, so "${op}" is impossible. As an assignee: done / accept / start / late / decline.`;
        }
        const deadline = resolveWhen(toWhen(a.when as RawWhen), ctx.now, ctx.sched);
        if (op === 'reschedule' && !deadline) return `${at}: reschedule needs "when"`;
        const priority = priorityOf(a.priority);
        if (op === 'set_priority' && !priority) return `${at}: set_priority needs "priority"`;
        const title = typeof a.title === 'string' && a.title.trim().length >= 3 ? a.title.trim() : null;
        if (op === 'rename' && !title) return `${at}: rename needs "title"`;
        const after = byRef(ctx.tasks, 't', a.after);
        if (op === 'after' && (!after || after.id === task.id)) return `${at}: "after" must be another task`;
        const reason = typeof a.reason === 'string' && a.reason.trim() ? a.reason.trim() : null;
        actions.push({ type: 'task', taskId: task.id, op, deadline, priority, title, afterId: after?.id ?? null, reason });
        break;
      }
      case 'draft': {
        const draft = a.draft === 'all' ? 'all' : byRef(ctx.drafts, 'd', a.draft)?.id;
        if (!draft) return `${at}: unknown draft ref`;
        const op = a.op as 'delete' | 'create' | 'edit';
        if (draft === 'all' && op !== 'delete') return `${at}: "all" is only for delete`;
        const fix = typeof a.fix === 'string' && a.fix.trim() ? a.fix.trim() : null;
        if (op === 'edit' && !fix) return `${at}: edit needs "fix"`;
        actions.push({ type: 'draft', draftId: draft, op, fix });
        break;
      }
      case 'show':
        actions.push({ type: 'show', what: a.what as 'my_tasks' | 'assigned' | 'drafts' });
        break;
      case 'ask':
        actions.push({ type: 'ask' });
        break;
      case 'reply': {
        const text = String(a.text ?? '').trim();
        if (!text) return `${at}: empty reply`;
        actions.push({ type: 'reply', text });
        break;
      }
      default:
        return `${at}: unknown type`;
    }
  }
  const clarify = typeof raw.clarify === 'string' && raw.clarify.trim() ? raw.clarify.trim() : null;
  // Действия важнее вопроса: модель, которая и сделала, и спросила, уже решила.
  if (actions.length) return { actions, clarify: null };
  if (clarify) return { actions, clarify };
  return 'no actions and no clarify';
}

/**
 * Понять фразу. null -- модели нет, сеть упала или ответ дважды неверен:
 * тогда фраза идёт старым путём, и человек этого не заметит.
 */
export async function understand(env: Env, ctx: BrainCtx, phrase: string): Promise<Plan | null> {
  if (!env.GROQ_API_KEY) return null;
  const messages: { role: string; content: string }[] = [
    { role: 'system', content: RULES + '\n\n' + context(ctx) },
    ...ctx.history.slice(-6).map((h) => ({ role: h.role, content: h.text })),
    { role: 'user', content: phrase.slice(0, 2000) },
  ];
  const format = { type: 'json_schema', json_schema: { name: 'hando_actions', strict: true, schema: schema(ctx) } };
  for (let attempt = 0; attempt < 2; attempt++) {
    let raw: string;
    try {
      const res = await fetch(`${GROQ}/chat/completions`, {
        method: 'POST',
        headers: { Authorization: `Bearer ${env.GROQ_API_KEY}`, 'Content-Type': 'application/json' },
        // Дважды по 12 секунд -- предел: дольше пусть отвечают правила, иначе
        // Telegram не дождётся ответа и пришлёт то же сообщение снова.
        signal: AbortSignal.timeout(12_000),
        body: JSON.stringify({
          model: env.GROQ_LLM_MODEL || 'openai/gpt-oss-120b',
          messages, temperature: 0.3, max_completion_tokens: 3000,
          reasoning_effort: 'medium', include_reasoning: false,
          response_format: format,
        }),
      });
      if (!res.ok) {
        // Без журнала отказ схемы (400) тихо превратил бы BRAIN=1 в одни правила.
        console.error('brain http', res.status, (await res.text()).slice(0, 500));
        return null;
      }
      const data = (await res.json()) as { choices?: { message?: { content?: string } }[] };
      raw = data.choices?.[0]?.message?.content ?? '';
    } catch (e) {
      console.error('brain fetch', String(e));
      return null;
    }
    let verdict: Plan | string;
    try {
      verdict = resolve(JSON.parse(raw) as Raw, ctx);
    } catch (e) {
      verdict = `invalid JSON or shape: ${String(e).slice(0, 200)}`;
    }
    if (typeof verdict !== 'string') return verdict;
    console.error('brain invalid', verdict);
    messages.push({ role: 'assistant', content: raw }, { role: 'user', content: `That answer is invalid: ${verdict}. Answer again for the same message.` });
  }
  return null;
}
