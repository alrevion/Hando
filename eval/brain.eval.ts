// Корпус живых фраз через модель (src/brain.ts): что поняла, сколько токенов,
// сколько чистого времени. Ключ -- GROQ_API_KEY из окружения или .dev.vars.
//
// Каждая фраза пишется в eval/results/<LABEL>.jsonl сразу: обрыв не теряет
// сделанного, повторный запуск продолжает с места. Варианты подсказки и
// модели сравниваются по LABEL: EFFORT=low, MODEL=openai/gpt-oss-20b.
import { appendFileSync, existsSync, mkdirSync, readFileSync } from 'node:fs';
import { it } from 'vitest';
import { understand, type Act, type BrainCtx, type Plan } from '../src/brain';

const ROOT = new URL('..', import.meta.url).pathname;
const KEY = process.env.GROQ_API_KEY
  ?? /^GROQ_API_KEY\s*=\s*"?([^"\n]+)"?/m.exec(readFileSync(`${ROOT}.dev.vars`, 'utf8'))?.[1];
const LABEL = process.env.LABEL ?? 'current';
const OUT = `${ROOT}eval/results/${LABEL}.jsonl`;
const MONTH = 30 * 1440;
const TZ = 'Asia/Tashkent';
// Суббота 19 сентября 2026, 16:00 по Ташкенту.
const NOW = new Date('2026-09-19T11:00:00Z');
const SCHED = { timezone: TZ, always_on: 1, work_days: '1,2,3,4,5', work_end: '18:00', lunch_start: null, quiet_from: '22:00', quiet_to: '08:00' };
const NAMES: Record<string, string> = { yakov: 'Яков', lara: 'Лариса Сергеевна', aziz: 'Азиз Каримов', bek: 'Бек Юсупов', masha: 'Маша', alex: 'Алексей' };

function ctx(speaker: 'yakov' | 'lara'): BrainCtx {
  const people = Object.keys(NAMES).filter((id) => id !== speaker).map((id) => ({ id, name: NAMES[id] }));
  const all = [
    { id: 'flowers', title: 'Мои цветы поливать через день', authorId: 'lara', assignee: 'yakov', state: 'accepted', status: 'in progress', due: 'сб, 19 сент., 21:00' },
    { id: 'report', title: 'Подготовить отчёт', authorId: 'yakov', assignee: 'aziz', state: 'pending', status: 'not started', due: 'вс, 20 сент., 22:00' },
    { id: 'ucell', title: 'За Ucell платить', authorId: 'yakov', assignee: 'yakov', state: 'accepted', status: 'in progress', due: null },
    { id: 'design', title: 'Посмотреть оформление', authorId: 'yakov', assignee: 'yakov', state: 'accepted', status: 'in progress', due: 'сб, 19 сент., 15:57' },
    { id: 'paper', title: 'Купить бумагу', authorId: 'yakov', assignee: 'bek', state: 'accepted', status: 'in progress', due: null },
  ].filter((t) => t.authorId === speaker || t.assignee === speaker);
  return {
    now: NOW, sched: SCHED, me: { id: speaker, name: NAMES[speaker] }, people,
    tasks: all.map((t) => ({
      id: t.id, title: t.title, author: t.authorId === speaker, mine: t.assignee === speaker ? t.state : null,
      status: t.status, due: t.due, who: `${NAMES[t.assignee]} (${t.state})`, last: t.id === 'design',
    })),
    drafts: speaker === 'yakov' ? [{ id: 'setki', title: 'Съездить на Джами и забрать сетки', due: null }] : [],
    history: [],
  };
}

// ------------------------------------------------------------------ ожидания

type Check = (p: Plan) => string | null;
type Spec = { t?: RegExp; to?: string[]; at?: string | string[] | null; rep?: number | null; list?: number; ack?: boolean };
type Create = Extract<Act, { type: 'create' }>;

const local = (iso: string) => {
  const p = Object.fromEntries(new Intl.DateTimeFormat('en-GB', { timeZone: TZ, day: '2-digit', month: '2-digit', hour: '2-digit', minute: '2-digit', hourCycle: 'h23' })
    .formatToParts(new Date(iso)).map((x) => [x.type, x.value]));
  return `${p.day}.${p.month} ${p.hour}:${p.minute}`;
};

function specFail(a: Create, s: Spec): string | null {
  if (s.t && !s.t.test(a.title)) return `title «${a.title}» !~ ${s.t}`;
  if (s.to && [...a.assigneeIds].sort().join() !== [...s.to].sort().join()) return `to ${a.assigneeIds} != ${s.to}`;
  if (s.at !== undefined) {
    const got = a.deadline ? local(a.deadline) : 'none';
    if (s.at === null) { if (a.deadline) return `deadline ${got} != none`; } else {
      const want = Array.isArray(s.at) ? s.at : [s.at];
      if (!want.some((w) => got.startsWith(w))) return `deadline ${got} != ${want.join('|')}`;
    }
  }
  if (s.rep !== undefined && a.repeatMin !== s.rep) return `repeat ${a.repeatMin} != ${s.rep}`;
  if (s.list !== undefined && a.checklist.length < s.list) return `checklist ${a.checklist.length} < ${s.list}`;
  if (s.ack !== undefined && a.ack !== s.ack) return `ack ${a.ack}`;
  return null;
}
/** Создания по порядку. extra -- после названных допустимы ещё. */
const C = (specs: Spec | Spec[], extra = false): Check => (p) => {
  const list = Array.isArray(specs) ? specs : [specs];
  if (p.actions.some((a) => a.type !== 'create')) return `want create, got ${describe(p)}`;
  const got = p.actions as Create[];
  if (got.length < list.length || (!extra && got.length > list.length)) return `creates ${got.length} != ${list.length}`;
  for (const [i, s] of list.entries()) { const f = specFail(got[i], s); if (f) return `#${i + 1}: ${f}`; }
  return null;
};
const T = (id: string, op: string, s: { at?: string } = {}): Check => (p) => {
  const a = p.actions[0];
  if (p.actions.length !== 1 || a.type !== 'task') return `want task ${op}, got ${describe(p)}`;
  if (a.taskId !== id || a.op !== op) return `task ${a.taskId}:${a.op} != ${id}:${op}`;
  if (s.at && !(a.deadline && local(a.deadline).startsWith(s.at))) return `deadline ${a.deadline ? local(a.deadline) : 'none'} != ${s.at}`;
  return null;
};
const D = (op: string, id: string | string[]): Check => (p) => {
  const a = p.actions[0];
  if (p.actions.length !== 1 || a.type !== 'draft') return `want draft ${op}, got ${describe(p)}`;
  const ids = Array.isArray(id) ? id : [id];
  return a.op === op && ids.includes(a.draftId) ? null : `draft ${a.draftId}:${a.op} != ${ids.join('|')}:${op}`;
};
const S = (what: string): Check => (p) => (p.actions.length === 1 && p.actions[0].type === 'show' && p.actions[0].what === what ? null : `want show ${what}, got ${describe(p)}`);
const ASK: Check = (p) => (p.actions.length === 1 && p.actions[0].type === 'ask' ? null : `want ask, got ${describe(p)}`);
const REPLY: Check = (p) => (p.actions.length === 1 && p.actions[0].type === 'reply' ? null : `want reply, got ${describe(p)}`);
const CLAR: Check = (p) => (p.clarify && !p.actions.length ? null : `want clarify, got ${describe(p)}`);
const OR = (...checks: Check[]): Check => (p) => { const r = checks.map((c) => c(p)); return r.includes(null) ? null : r.join(' / '); };
const NOT_DONE: Check = (p) => (p.actions.some((a) => a.type === 'task' && a.op === 'done') ? 'marked done' : null);

function describe(p: Plan): string {
  if (p.clarify) return `clarify «${p.clarify}»`;
  return p.actions.map((a) => {
    switch (a.type) {
      case 'create': return `create «${a.title}»${a.description ? ` (${a.description.slice(0, 60)})` : ''} → ${a.assigneeIds.join('+')}${a.deadline ? ` @ ${local(a.deadline)}` : ''}${a.repeatMin ? ` ↻${a.repeatMin}` : ''}${a.checklist.length ? ` [${a.checklist.join('; ')}]` : ''}${a.ack ? ' ack' : ''}${a.priority ? ` ${a.priority}` : ''}`;
      case 'task': return `task ${a.taskId}:${a.op}${a.deadline ? ` @ ${local(a.deadline)}` : ''}${a.title ? ` «${a.title}»` : ''}${a.priority ? ` ${a.priority}` : ''}${a.reason ? ` (${a.reason})` : ''}`;
      case 'draft': return `draft ${a.draftId}:${a.op}${a.fix ? ` «${a.fix}»` : ''}`;
      case 'show': return `show ${a.what}`;
      case 'reply': return `reply «${a.text}»`;
      default: return a.type;
    }
  }).join(' + ') || '(nothing)';
}

const Y = ['yakov'];
const CORPUS: [string, 'yakov' | 'lara', string, Check][] = [
  ['real', 'yakov', 'В пн в 12 нужно сходить в махалинский комитет для того чтобы узнать кадастровый номер, чтобы оплатить за кварт. плату', C({ t: /комитет/i, to: Y, at: '21.09 12:00' })],
  ['real', 'yakov', 'А еще, короче, мне нужно поливать цветы у бабули каждые 3-4 дня. А потом, значит, цветы для Ларисы Сергеевны.', C({ t: /цвет/i, rep: 4320 }, true)],
  ['real', 'yakov', 'Напомни мне в воскресенье, наверное, после 12, что нужно съездить на Джами и забрать сетки.', OR(C({ t: /джами|сетк/i, at: '20.09 12:00' }), D('edit', 'setki'))],
  ['real', 'lara', 'Мне нужно завтра погладить вещи на неделю. Мне нужно сделать еще две брошки. Нужно вымыть голову. Погладить вещи Маши.', OR(
    C([{ t: /поглад/i, to: ['lara'], at: '20.09' }, { t: /брош/i, to: ['lara'] }, { t: /голов/i, to: ['lara'] }, { t: /поглад|маш/i, to: ['lara'] }]),
    C({ to: ['lara'], list: 3 }))],
  ['real', 'lara', 'Написать письмо тёте Вале.', C({ t: /письм/i, to: ['lara'], at: null })],
  ['real', 'lara', 'Дай поручение Алексею завтра до вечера решить вопрос с капающей водой крана.', C({ t: /кран|вод/i, to: ['alex'], at: ['20.09 19:00', '20.09 22:00', '20.09 18:00'] })],
  ['real', 'lara', 'Дай задание Якову собрать все мои вещи и вещи Маши и отправить через бабушку в течение недели.', C({ t: /вещ|собра/i, to: Y, at: ['20.09', '26.09'] })],
  // Такое поручение у неё уже есть -- «напомнить Якову» тоже верное прочтение.
  ['real', 'lara', 'Яков мои цветы нужно поливать через день', OR(C({ t: /цвет/i, to: Y, rep: 2880 }), T('flowers', 'remind'), CLAR, REPLY)],
  ['real', 'yakov', 'За USEL нужно платить каждое 18 число.', C({ rep: MONTH, at: '18.10' })],
  ['real', 'yakov', 'Напомню мне через 2 минуты посмотреть оформление.', OR(C({ t: /оформлен/i, at: '19.09 16:02' }), T('design', 'reschedule', { at: '19.09 16:02' }))],
  ['real', 'yakov', 'Напомню, через 2 минуты проверить оформление.', OR(C({ t: /оформлен/i, at: '19.09 16:02' }), T('design', 'reschedule', { at: '19.09 16:02' }))],
  ['real', 'yakov', 'Каждого 18 числа каждого месяца мне нужно оплачивать мобильный интернет. Запиши это в напоминание.', C({ t: /интернет/i, rep: MONTH, at: '18.10' })],
  ['real', 'yakov', 'Надо в содержании изменить: не оппонентскую плату, а абонентскую', OR(D('edit', 'setki'), CLAR)],
  ['real', 'yakov', 'удали все черновики', D('delete', ['all', 'setki'])],
  ['real', 'yakov', 'мои задачи', S('my_tasks')],
  ['real', 'yakov', 'такие мои задачи', OR(S('my_tasks'), ASK)],
  ['real', 'yakov', 'Какие у меня сейчас есть черновики?', S('drafts')],
  ['real', 'yakov', 'Черновики', S('drafts')],
  ['real', 'yakov', 'Напомни мне завтра в 10, что нужно замерить окна для того, чтобы съездить на джами и купить москитные сетки или сделать их и купить материалы.', C({ t: /замер|окн/i, at: '20.09 10:00' }, true)],
  ['real', 'yakov', 'Напомни мне через 2 минуты проверить оформление.', OR(C({ t: /оформлен/i, at: '19.09 16:02' }), T('design', 'reschedule', { at: '19.09 16:02' }))],
  ['real', 'yakov', 'Заверши её.', T('design', 'done')],
  ['real', 'yakov', 'Завершай эту задачу.', T('design', 'done')],
  ['real', 'yakov', 'нельзя поливать цветы Ларисы Сергеевны, пока не политы цветы бабули', OR(CLAR, ASK, C({}, true))],
  ['real', 'yakov', 'Мне оплатить Ucell каждого 18 числа', C({ rep: MONTH, at: '18.10' })],

  ['time', 'yakov', 'напомни завтра утром позвонить маме', C({ t: /позвон/i, at: '20.09 09:00' })],
  ['time', 'yakov', 'напомни в 7 вечера забрать Машу из садика', C({ t: /маш|садик/i, to: Y, at: '19.09 19:00' })],
  ['time', 'yakov', 'напомни через полчаса выключить духовку', C({ t: /духовк/i, at: '19.09 16:30' })],
  ['time', 'yakov', 'в пятницу к обеду купить продукты', C({ t: /продукт/i, at: '25.09 13:00' })],
  ['time', 'yakov', 'к вечеру надо оплатить свет', C({ t: /свет/i, at: ['19.09 19:00', '19.09 22:00', '19.09 18:00'] })],
  ['time', 'yakov', 'в среду в 15:30 к врачу', C({ t: /врач/i, at: '23.09 15:30' })],
  ['time', 'yakov', 'завтра в полдесятого созвон по работе', C({ t: /созвон/i, at: '20.09 09:30' })],
  ['time', 'yakov', 'послезавтра отвезти документы', C({ t: /документ/i, at: '21.09' })],
  ['time', 'yakov', 'до конца недели сдать отчёт в налоговую', C({ t: /отч|налог/i, at: '20.09' })],
  ['time', 'yakov', 'в течение месяца продлить страховку', C({ t: /страхов/i, at: '30.09' })],
  ['time', 'yakov', '25 сентября день рождения тёти Вали, купить подарок', C({ t: /подар/i, at: '25.09' })],
  ['time', 'yakov', 'через неделю напомни забрать анализы', C({ t: /анализ/i, at: '26.09' })],
  ['time', 'yakov', 'в субботу утром полить цветы на даче', C({ t: /цвет/i, at: '26.09 09:00' })],
  ['time', 'yakov', 'сегодня вечером вынести мусор', C({ t: /мусор/i, at: '19.09 19:00' })],
  ['time', 'yakov', 'в следующий понедельник записаться к стоматологу', C({ t: /стоматолог/i, at: ['21.09', '28.09'] })],
  ['time', 'yakov', 'в конце месяца заплатить за квартиру', C({ t: /квартир/i, at: '30.09' })],
  ['time', 'yakov', 'через 3 дня позвонить в банк', C({ t: /банк/i, at: '22.09' })],
  ['time', 'yakov', 'через пару часов перезвонить в сервис', C({ t: /сервис/i, at: '19.09 18:00' })],
  ['time', 'yakov', 'напомни мне в 9 утра выпить таблетку', C({ t: /таблетк/i, at: '20.09 09:00' })],
  ['time', 'yakov', 'надо не забыть завтра купить хлеб', C({ t: /хлеб/i, at: '20.09' })],
  ['time', 'yakov', 'в обед забрать посылку', C({ t: /посылк/i, at: ['20.09 13:00', '19.09 13:00'] })],
  ['time', 'yakov', 'в 10 вечера закрыть окна', C({ t: /окн/i, at: '19.09 22:00' })],

  ['repeat', 'yakov', 'каждое утро выпивать таблетку', C({ t: /таблетк/i, rep: 1440, at: '20.09 09:00' })],
  ['repeat', 'yakov', 'каждый понедельник выносить мусор', C({ t: /мусор/i, rep: 10080, at: '21.09' })],
  ['repeat', 'yakov', 'по пятницам созвон с поставщиком', C({ t: /созвон|поставщ/i, rep: 10080, at: '25.09' })],
  ['repeat', 'yakov', 'раз в неделю поливать цветы', C({ t: /цвет/i, rep: 10080 })],
  ['repeat', 'yakov', 'каждые две недели менять фильтр', C({ t: /фильтр/i, rep: 20160 })],
  ['repeat', 'yakov', 'ежедневно в 8 утра зарядка', C({ t: /заряд/i, rep: 1440, at: '20.09 08:00' })],
  ['repeat', 'yakov', 'каждый день в 9 вечера проверять уроки Маши', C({ t: /урок/i, to: Y, rep: 1440, at: '19.09 21:00' })],
  ['repeat', 'yakov', 'по выходным уборка', C({ t: /убор|убра/i, rep: 10080 }, true)],
  ['repeat', 'yakov', 'каждое 1 число платить за интернет', C({ t: /интернет/i, rep: MONTH, at: '01.10' })],
  ['repeat', 'yakov', 'каждый месяц 5 числа оплатить садик', C({ t: /садик/i, rep: MONTH, at: '05.10' })],

  ['assign', 'yakov', 'Азизу подготовить отчёт до пятницы', OR(C({ t: /отч/i, to: ['aziz'], at: '25.09' }), T('report', 'reschedule', { at: '25.09' }))],
  ['assign', 'yakov', 'Азиз, подготовь отчёт к пятнице', OR(C({ t: /отч/i, to: ['aziz'], at: '25.09' }), T('report', 'reschedule', { at: '25.09' }))],
  ['assign', 'yakov', 'попроси Азиза подготовить презентацию', C({ t: /презент/i, to: ['aziz'] })],
  ['assign', 'yakov', 'скажи Беку купить бумагу', OR(C({ t: /бумаг/i, to: ['bek'] }), T('paper', 'remind'))],
  ['assign', 'yakov', 'поручи Маше убрать комнату', C({ t: /комнат/i, to: ['masha'] })],
  ['assign', 'yakov', 'Маше и Беку убрать гараж в субботу', C({ t: /гараж/i, to: ['masha', 'bek'], at: '26.09' })],
  ['assign', 'yakov', 'Бек пусть заберёт посылку завтра', C({ t: /посылк/i, to: ['bek'], at: '20.09' })],
  ['assign', 'yakov', 'Алексею срочно починить кран', C({ t: /кран/i, to: ['alex'] })],
  ['assign', 'yakov', 'нужно чтобы Азиз позвонил поставщику', C({ t: /поставщ/i, to: ['aziz'] })],
  ['assign', 'yakov', 'передай Ларисе Сергеевне, что завтра приеду в 6', C({ to: ['lara'] })],
  ['assign', 'yakov', 'Азизу и Беку ознакомиться с новым расписанием', C({ t: /расписан/i, to: ['aziz', 'bek'], ack: true })],
  ['assign', 'yakov', 'кто первый, забрать Машу из школы', OR(C({ t: /маш|школ/i }), CLAR)],
  ['assign', 'yakov', 'мне и Азизу подготовить презентацию к понедельнику', C({ t: /презент/i, to: ['yakov', 'aziz'], at: '21.09' })],
  ['assign', 'yakov', 'Дай задание Маше помыть посуду', C({ t: /посуд/i, to: ['masha'] })],

  ['command', 'yakov', 'готово', T('design', 'done')],
  ['command', 'yakov', 'сделал', T('design', 'done')],
  ['command', 'yakov', 'всё, полил цветы', T('flowers', 'done')],
  ['command', 'yakov', 'цветы полил', T('flowers', 'done')],
  ['command', 'yakov', 'мои цветы поливать через день готово', T('flowers', 'done')],
  ['command', 'yakov', 'взял в работу мои цветы поливать через день', T('flowers', 'start')],
  ['command', 'yakov', 'не успеваю с цветами, завтра полью', T('flowers', 'late')],
  ['command', 'yakov', 'отказываюсь от мои цветы поливать через день, уезжаю', T('flowers', 'decline')],
  ['command', 'yakov', 'перенеси подготовить отчёт на понедельник', T('report', 'reschedule', { at: '21.09' })],
  ['command', 'yakov', 'перенеси её на завтра', T('design', 'reschedule', { at: '20.09' })],
  ['command', 'yakov', 'сделай подготовить отчёт срочной', T('report', 'set_priority')],
  ['command', 'yakov', 'удали за ucell платить', T('ucell', 'delete')],
  ['command', 'yakov', 'напомни Азизу про отчёт', T('report', 'remind')],
  ['command', 'yakov', 'поторопи Азиза', T('report', 'remind')],
  ['command', 'yakov', 'принимаю работу подготовить отчёт', T('report', 'confirm')],
  ['command', 'yakov', 'я её ещё не сделал', NOT_DONE],
  ['command', 'yakov', 'удали задачу про оформление', T('design', 'delete')],
  ['command', 'yakov', 'переименуй посмотреть оформление в проверить дизайн', T('design', 'rename')],
  ['command', 'yakov', 'что с отчётом?', ASK],
  ['command', 'yakov', 'Азиз сделал отчёт?', ASK],
  ['command', 'yakov', 'отчёт готов', OR(ASK, CLAR, T('report', 'confirm'))],
  ['command', 'yakov', 'купил бумагу', OR(ASK, CLAR, REPLY, T('paper', 'confirm'))],

  ['question', 'yakov', 'что у меня на сегодня?', OR(ASK, S('my_tasks'))],
  ['question', 'yakov', 'что горит?', OR(ASK, S('my_tasks'))],
  ['question', 'yakov', 'за что взяться сначала?', ASK],
  ['question', 'yakov', 'сколько у меня задач', OR(ASK, S('my_tasks'))],
  ['question', 'yakov', 'как отметить выполненную?', ASK],
  ['question', 'yakov', 'как пригласить жену', ASK],
  ['question', 'yakov', 'что умеет бот', ASK],
  ['question', 'yakov', 'кто видит мои задачи?', ASK],
  ['question', 'yakov', 'как удалить черновик?', ASK],
  ['question', 'yakov', 'можно поставить повтор?', ASK],
  ['question', 'yakov', 'спасибо', REPLY],
  ['question', 'yakov', 'ок', REPLY],
  ['question', 'yakov', 'привет', OR(REPLY, ASK)],
  ['question', 'yakov', 'а что с цветами?', ASK],
  ['question', 'yakov', 'какие задачи у Азиза?', ASK],
  ['question', 'yakov', 'что я поручил Азизу', OR(ASK, S('assigned'))],
  ['question', 'yakov', 'мои поручения', S('assigned')],
  ['question', 'yakov', 'что просрочено', OR(ASK, S('my_tasks'))],

  ['drafts', 'yakov', 'удали черновик', D('delete', 'setki')],
  ['drafts', 'yakov', 'удали черновик про сетки', D('delete', 'setki')],
  ['drafts', 'yakov', 'покажи черновики', S('drafts')],
  ['drafts', 'yakov', 'отмени', OR(D('delete', 'setki'), CLAR)],
  ['drafts', 'yakov', 'создай', OR(D('create', 'setki'), CLAR)],

  ['noise', 'yakov', 'ну короче это самое завтра в общем надо позвонить в банк', C({ t: /^Позвонить в банк$/i, at: '20.09' })],
  ['noise', 'yakov', 'эээ напомни ну в пятницу купить подарок', C({ t: /подар/i, at: '25.09' })],
  ['noise', 'yakov', 'Купить молоко, хлеб, яйца, сыр', C({ t: /куп|продукт/i, list: 3 })],
  ['noise', 'yakov', 'срочно!!! позвонить в налоговую', C({ t: /налог/i })],
  ['noise', 'yakov', 'не срочно разобрать архив когда будет время', C({ t: /архив/i, at: null })],
  ['noise', 'yakov', 'позвонить маме', C({ t: /мам/i })],
  ['noise', 'yakov', 'Маша', CLAR],
  ['noise', 'yakov', 'завтра', CLAR],
  ['noise', 'yakov', 'в 5', CLAR],
  ['noise', 'yakov', 'Может быть завтра схожу в банк, наверное', C({ t: /банк/i, at: '20.09' })],
];

// ------------------------------------------------------------------ сеть

// 429 -- ждём и повторяем, время ожидания вычитается: меряем модель, а не
// лимит ключа. EFFORT и MODEL подменяют параметры запроса без правки кода.
const real = globalThis.fetch;
let waited = 0;
/** Суточный лимит ключа: дальше мерить нечего, сделанное сохранено. */
let exhausted = '';
let tokens = { prompt: 0, completion: 0, cached: 0 };
globalThis.fetch = (async (input: RequestInfo | URL, init?: RequestInit) => {
  const body = JSON.parse(String(init?.body ?? '{}'));
  if (process.env.EFFORT) body.reasoning_effort = process.env.EFFORT;
  if (process.env.MODEL) body.model = process.env.MODEL;
  for (let i = 0; ; i++) {
    const res = await real(input, { ...init, body: JSON.stringify(body), signal: undefined });
    if (res.status !== 429 || i >= 20) {
      const u = (await res.clone().json().catch(() => ({}))) as { usage?: { prompt_tokens: number; completion_tokens: number; prompt_tokens_details?: { cached_tokens?: number } } };
      if (u.usage) {
        tokens.prompt += u.usage.prompt_tokens;
        tokens.completion += u.usage.completion_tokens;
        tokens.cached += u.usage.prompt_tokens_details?.cached_tokens ?? 0;
      }
      return res;
    }
    const wait = (Number(res.headers.get('retry-after') ?? 10) + 1) * 1000;
    // Минутный лимит ждём, суточный -- нет: он просит часы, и прогон молча
    // спал бы до вечера. Сделанное сохранено, запуск завтра продолжит.
    if (wait > 60_000 || (await res.clone().text()).includes('tokens per day')) {
      exhausted = `суточный лимит Groq: ждать ${Math.round(wait / 60_000)} мин`;
      return res;
    }
    waited += wait;
    await new Promise((r) => setTimeout(r, wait));
  }
}) as typeof fetch;

it(`корпус через модель: ${LABEL}`, async () => {
  if (!KEY) throw new Error('нет GROQ_API_KEY');
  const env = { GROQ_API_KEY: KEY, GROQ_LLM_MODEL: 'openai/gpt-oss-120b' } as never;
  const only = process.env.ONLY ? new RegExp(process.env.ONLY, 'i') : null;
  mkdirSync(`${ROOT}eval/results`, { recursive: true });
  const done = new Set(existsSync(OUT)
    ? readFileSync(OUT, 'utf8').split('\n').filter(Boolean).map((l) => (JSON.parse(l) as { phrase: string }).phrase)
    : []);
  for (const [cls, speaker, phrase, check] of CORPUS) {
    if (done.has(phrase) || (only && !only.test(cls) && !only.test(phrase))) continue;
    waited = 0;
    tokens = { prompt: 0, completion: 0, cached: 0 };
    const t0 = Date.now();
    const plan = await understand(env, ctx(speaker), phrase);
    // Отказ по лимиту -- не ответ модели: такую фразу не записываем.
    if (exhausted) { console.log(exhausted); break; }
    const ms = Date.now() - t0 - waited;
    const fail = plan ? check(plan) : 'no plan (fallback)';
    appendFileSync(OUT, JSON.stringify({ cls, phrase, ok: !fail, fail, got: plan ? describe(plan) : null, ms, tokens }) + '\n');
    console.log(`${fail ? '✗' : '✓'} [${cls}] ${phrase}\n    ${plan ? describe(plan) : 'NULL'}${fail ? `\n    ✗ ${fail}` : ''}`);
  }
});
