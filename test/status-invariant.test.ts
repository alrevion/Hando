// ИНВАРИАНТ: колонка задачи на доске всегда совпадает с тем, что говорят строки
// исполнителей.
//
// Зачем именно перебором, а не списком проверок. Статус задачи хранится полем И
// выводится из строк исполнителей -- два источника правды. Расхождение даёт
// застрявшую карточку: задача в «Todo», строка Азиза говорит «принял», и он не
// может взять её снова («вы уже принимали»). Ровно так и было: четыре пути из
// четырёх забыли сбросить строки.
//
// Список проверок «по одной на маршрут» устарел бы на пятом маршруте -- то есть
// ровно тогда, когда защита нужна. Поэтому тест берёт РЕЕСТР маршрутов Hono,
// дёргает каждый меняющий и после каждого сверяет инвариант. Новый маршрут,
// забывший про строки, роняет его САМ, без правки этого файла.
//
// Единственное исключение -- 'archived'. Архив это действие над самой задачей, а
// не итог чьей-то работы: из строк он не выводится ни при каком раскладе.
import { env as testEnv } from 'cloudflare:test';
import { afterEach, describe, expect, it } from 'vitest';
import { apiRoutes } from '../src/routes';
import { rollup, type AssigneeState, type TaskKind } from '../src/assignees';
import { cookie, envWith, ORG_A, stubTelegram } from './fixture';

let restore: { mockRestore(): void } | null = null;
afterEach(() => { restore?.mockRestore(); restore = null; });
const tg = () => (restore = stubTelegram());

const boss = { id: 'boss', phone: '+1', name: 'Директор', role: 'creator' };
const aziz = { id: 'aziz', phone: '+2', name: 'Азиз', role: 'admin' };
const bek = { id: 'bek', phone: '+3', name: 'Бек', role: 'admin' };

const world = (kind: string) =>
  envWith({
    users: [boss, aziz, bek],
    memberships: [{ project_id: 'p1', user_id: 'boss' }, { project_id: 'p1', user_id: 'aziz' }, { project_id: 'p1', user_id: 'bek' }],
    projects: [{ id: 'p1', telegram_chat_id: '-100999', created_by: 'boss' }],
    tasks: [{ id: 't1', project_id: 'p1', status: 'todo', responsible_user_id: 'aziz', author_id: 'boss', kind, deadline: '2030-01-01T00:00:00.000Z' }],
  });

/** Сверяет колонку задачи со свёрткой её строк. Возвращает описание расхождения. */
async function mismatch(taskId: string): Promise<string | null> {
  const task = await testEnv.DB.prepare('SELECT status, kind FROM tasks WHERE id = ?').bind(taskId).first<{ status: string; kind: TaskKind }>();
  if (!task) return null;
  if (task.status === 'archived') return null; // архив из строк не выводится
  const { results } = await testEnv.DB.prepare('SELECT state FROM task_assignees WHERE task_id = ?').bind(taskId).all<{ state: AssigneeState }>();
  const expected = rollup(task.kind, results.map((r) => r.state));
  return expected === task.status
    ? null
    : `статус «${task.status}», а строки дают «${expected}» (${results.map((r) => r.state).join(', ')})`;
}

// Сценарий = подготовка + проверяемая операция. Каждый идёт в СВОЁМ мире.
//
// Прежняя редакция гоняла операции одной цепочкой, и это было ошибкой того
// самого класса, который здесь и ловится: правка сбрасывала задачу в Todo,
// поэтому «подтверждение» и «отклонение» ниже по цепочке молча отваливались с
// 409 и не проверяли НИЧЕГО. Мутация, гасившая их, оставалась незамеченной.
// Отсюда правило: каждая операция обязана реально пройти, и это утверждается.
type Step = { path: string; method?: 'POST' | 'PATCH' | 'DELETE'; body?: unknown; as: 'boss' | 'aziz' | 'bek' };
type Scenario = {
  name: string; setup: Step[]; act: Step; expectRows?: string;
  /** Подготовка данных, которых нет в фикстуре (например список пунктов). */
  before?: () => Promise<void>;
  // Требует, чтобы работу сдали ВСЕ адресаты. У 'each' и 'ack' задача не
  // считается сданной, пока не закрылся последний, и подтверждать нечего --
  // прежняя редакция получала здесь 409 и молча ничего не проверяла.
  needsAll?: boolean;
};

const move = (as: 'boss' | 'aziz' | 'bek', to: string): Step => ({ path: '/tasks/t1/move', method: 'POST', body: { to }, as });

const SCENARIOS: Scenario[] = [
  { name: 'принял', setup: [], act: move('aziz', 'in_progress') },
  { name: 'сдал', setup: [move('aziz', 'in_progress')], act: move('aziz', 'done') },
  {
    // Быстрая правка срочности/срока НЕ трогает ни статус, ни строки
    // адресатов -- и именно это здесь проверяется: свёртка обязана остаться
    // согласованной, а строка Азиза -- нетронутой.
    name: 'срочность кнопкой',
    setup: [move('aziz', 'in_progress')],
    act: { path: '/tasks/t1/quick', method: 'PATCH', body: { priority: 'urgent' }, as: 'boss' },
    expectRows: 'accepted',
  },
  {
    // Галочка в списке -- НЕ движение задачи: отметили морковку, а поручение
    // как было в работе, так и осталось. Ровно это здесь и проверяется.
    name: 'галочка в списке',
    // Списка в фикстуре нет -- ставим его прямо перед действием.
    before: async () => {
      await testEnv.DB.prepare("UPDATE tasks SET checklist = ? WHERE id='t1'")
        .bind(JSON.stringify([{ t: 'молоко', d: null }, { t: 'хлеб', d: null }])).run();
    },
    setup: [move('aziz', 'in_progress')],
    act: { path: '/tasks/t1/checklist', method: 'POST', body: { index: 0 }, as: 'aziz' },
    expectRows: 'accepted',
  },
  {
    // «Не успею» -- комментарий автору, строка и статус не меняются.
    name: 'не успею',
    setup: [move('aziz', 'in_progress')],
    act: { path: '/tasks/t1/late', method: 'POST', body: { comment: 'болею' }, as: 'aziz' },
    expectRows: 'accepted',
  },
  {
    name: 'правка заголовка после «Принял»',
    setup: [move('aziz', 'in_progress')],
    act: { path: '/tasks/t1', method: 'PATCH', body: { title: 'Другая задача' }, as: 'boss' },
    expectRows: 'pending',
  },
  {
    name: 'подтверждение сданной работы',
    setup: [move('aziz', 'in_progress'), move('aziz', 'done')],
    act: { path: '/tasks/t1/confirm', method: 'POST', body: {}, as: 'boss' },
    needsAll: true,
    // Строки обязаны стать 'confirmed'. Иначе они навсегда остаются 'done', и
    // cron шлёт «пора проверить» по задачам, которые автор уже принял.
    expectRows: 'confirmed',
  },
  {
    name: 'отклонение сданной работы',
    setup: [move('aziz', 'in_progress'), move('aziz', 'done')],
    act: { path: '/tasks/t1/reject', method: 'POST', body: { comment: 'переделать', extra_days: 2 }, as: 'boss' },
    needsAll: true,
    // Строка помечается ОТКЛОНЁННОЙ, а не просто «снова в работе»: факт
    // отклонения остаётся в состоянии, а не только в комментарии.
    expectRows: 'rejected',
  },
  { name: 'отказ исполнителя', setup: [], act: { path: '/tasks/t1/decline', method: 'POST', body: { reason: 'не смогу' }, as: 'aziz' } },
  { name: 'архив', setup: [move('aziz', 'in_progress')], act: { path: '/tasks/t1', method: 'DELETE', as: 'boss' } },
  {
    name: 'восстановление из архива',
    setup: [move('aziz', 'in_progress'), { path: '/tasks/t1', method: 'DELETE', as: 'boss' }],
    act: { path: '/tasks/t1/restore', method: 'POST', body: { comment: 'вернули' }, as: 'boss' },
    expectRows: 'pending',
  },
];

let ENV: Awaited<ReturnType<typeof envWith>>;
const COOKIES: Record<string, string> = {};

async function run(step: Step): Promise<Response> {
  const init: RequestInit = { method: step.method ?? 'GET', headers: { Cookie: COOKIES[step.as] } };
  if (step.body !== undefined) {
    (init.headers as Record<string, string>)['Content-Type'] = 'application/json';
    init.body = JSON.stringify(step.body);
  }
  return apiRoutes.request(step.path, init, ENV);
}

describe('инвариант: колонка доски = свёртка строк исполнителей', () => {
  // Каждый вид поручения отдельно: дефект жил именно в том, что всё проверялось
  // на single, а ломалось на рассылке.
  for (const kind of ['single', 'each', 'any', 'ack'] as const) {
    for (const sc of SCENARIOS) {
      it(`kind=${kind}: ${sc.name}`, async () => {
        ENV = await world(kind);
        if (kind !== 'single') {
          // У рассылки два исполнителя: с одним 'each' и 'any' неотличимы от single.
          await testEnv.DB.prepare("INSERT INTO task_assignees (id, task_id, user_id, org_id, state, due_at) VALUES ('a2','t1','bek',?, 'pending','2030-01-01T00:00:00.000Z')").bind(ORG_A).run();
        }
        tg();
        COOKIES.boss = await cookie('boss', 'creator', ORG_A);
        COOKIES.aziz = await cookie('aziz', 'admin', ORG_A);
        if (sc.before) await sc.before();

        for (const st of sc.setup) {
          const r = await run(st);
          expect(r.status, `подготовка «${st.path}» не прошла`).toBeLessThan(300);
        }
        // Второй адресат доводит задачу до конца там, где иначе она не считается
        // сданной. Для 'ack' достаточно «принял» -- это и есть закрытие.
        if (sc.needsAll && kind !== 'single') {
          COOKIES.bek = await cookie('bek', 'admin', ORG_A);
          const bek: Step = { ...move('boss', 'in_progress'), as: 'bek' as never };
          await run(bek);
          if (kind !== 'ack') await run({ ...bek, body: { to: 'done' } });
        }
        const res = await run(sc.act);
        // Операция обязана РЕАЛЬНО пройти: молча отвалившийся 409 не проверяет
        // ничего и прячет мутацию.
        expect(res.status, `операция «${sc.name}» вернула ${res.status}`).toBeLessThan(300);

        const bad = await mismatch('t1');
        expect(bad, `после «${sc.name}» (kind=${kind}): ${bad}`).toBeNull();

        if (sc.expectRows) {
          const row = await testEnv.DB.prepare("SELECT state FROM task_assignees WHERE task_id='t1' AND user_id='aziz'").first<{ state: string }>();
          expect(row!.state, `строка Азиза после «${sc.name}»`).toBe(sc.expectRows);
        }
      });
    }
  }

  it('реестр маршрутов покрыт: меняющий маршрут задачи не забыт', () => {
    // Страховка от «инвариант держится, потому что мы ничего не дёргали»:
    // сценарии обязаны покрывать все меняющие маршруты по задаче.
    const registered = [...new Set(
      apiRoutes.routes
        .filter((r) => r.method !== 'GET' && r.method !== 'ALL')
        .map((r) => r.path)
        .filter((p) => p.startsWith('/tasks/:id') && !p.includes('attachments')),
    )].sort();
    const exercised = new Set(SCENARIOS.map((sc) => sc.act.path.replace('/tasks/t1', '/tasks/:id')));
    expect([...exercised].sort()).toEqual(registered);
  });
});

describe('ack: «принял» и есть закрытие', () => {
  const prepare = async (kind: string) => {
    ENV = await world(kind);
    tg();
    COOKIES.boss = await cookie('boss', 'creator', ORG_A);
    COOKIES.aziz = await cookie('aziz', 'admin', ORG_A);
    COOKIES.bek = await cookie('bek', 'admin', ORG_A);
  };
  const status = async () =>
    (await testEnv.DB.prepare("SELECT status FROM tasks WHERE id='t1'").first<{ status: string }>())!.status;

  it('прочитал -- задача закрыта, «Готово» не требуется', async () => {
    await prepare('ack');
    const res = await run(move('aziz', 'in_progress'));
    expect(res.status).toBe(200);
    // Человека просили прочитать -- он прочитал. Требовать сверх этого «Готово»
    // значило бы заставлять отчитываться о работе, которой не было.
    expect(await status()).toBe('done');
  });

  it('рассылка приказа закрывается, когда прочитали ВСЕ', async () => {
    await prepare('ack');
    await testEnv.DB.prepare("INSERT INTO task_assignees (id, task_id, user_id, org_id, state) VALUES ('a2','t1','bek',?, 'pending')").bind(ORG_A).run();
    await run(move('aziz', 'in_progress'));
    expect(await status(), 'один прочитал из двух').toBe('in_progress');
    await run(move('bek', 'in_progress'));
    expect(await status(), 'прочитали все').toBe('done');
  });
});

describe('правка = новая задача', () => {
  it('Азиз принял, директор поправил -- «Принял» аннулировано, он берёт заново', async () => {
    ENV = await world('single');
    tg();
    COOKIES.boss = await cookie('boss', 'creator', ORG_A);
    COOKIES.aziz = await cookie('aziz', 'admin', ORG_A);

    await run(move('aziz', 'in_progress'));
    const state = async () =>
      (await testEnv.DB.prepare("SELECT state FROM task_assignees WHERE task_id='t1' AND user_id='aziz'").first<{ state: string }>())!.state;
    expect(await state()).toBe('accepted');

    await run({ path: '/tasks/t1', method: 'PATCH', body: { title: 'Другая задача' }, as: 'boss' });

    // Азиз принимал ТУ задачу, не эту.
    expect(await state()).toBe('pending');
    // И главное: он снова МОЖЕТ её взять. Раньше здесь был 409 навсегда --
    // карточка лежала в Todo, а взять её было нельзя.
    expect((await run(move('aziz', 'in_progress'))).status).toBe(200);
  });
});
