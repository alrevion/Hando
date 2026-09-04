// Приёмка шага 1, часть первая: applyTransition -- единственный писатель
// tasks.status.
//
// Проверка идёт ГРЕПОМ ПО ИСХОДНИКАМ, а не поведением. Поведенческий тест ловит
// только тот путь, который ему показали; шестое место, пишущее статус напрямую,
// он пропустит именно потому, что о нём никто не знал. Ровно так статус и
// разъехался по шести местам до этого шага.
//
// Исходники берутся через import.meta.glob, а не через node:fs, по двум причинам:
// @types/node в tsconfig не подключён намеренно (иначе в src стали бы доступны
// node-only API, которых в workerd нет), и glob раскрывается на сборке -- то есть
// новый файл в src/ попадает в проверку сам, без правки списка здесь.
import { describe, expect, it } from 'vitest';

const modules = (import.meta as unknown as {
  glob(pattern: string, opts: { query: string; import: string; eager: true }): Record<string, string>;
}).glob('../src/*.ts', { query: '?raw', import: 'default', eager: true });

const sources = Object.fromEntries(
  Object.entries(modules).map(([p, code]) => [p.slice(p.lastIndexOf('/') + 1), code]),
);

// Комментарии выкидываются: в них слово status встречается законно, и падение
// на собственном объяснении инварианта было бы издевательством.
const stripComments = (code: string) =>
  code.replace(/\/\*[\s\S]*?\*\//g, '').replace(/^\s*\/\/.*$/gm, '');

const read = (f: string) => sources[f];

describe('шаг 1: единственный писатель tasks.status', () => {
  it('ни один файл кроме transition.ts не выполняет UPDATE tasks SET ... status', () => {
    const offenders = Object.keys(sources)
      .filter((f) => f !== 'transition.ts')
      .filter((f) => {
        const code = stripComments(read(f));
        // Ищем UPDATE tasks SET, у которого до WHERE (или до конца оператора)
        // встречается присваивание status.
        for (const m of code.matchAll(/UPDATE\s+tasks\s+SET([\s\S]*?)(?:WHERE|`)/gi)) {
          if (/\bstatus\s*=/.test(m[1])) return true;
        }
        return false;
      });

    expect(offenders).toEqual([]);
    // Страховка от вакуумной истины: если glob однажды перестанет что-либо
    // находить, список нарушителей тоже будет пуст -- и тест соврёт.
    expect(Object.keys(sources)).toContain('routes.ts');
    expect(Object.keys(sources).length).toBeGreaterThan(5);
  });

  it('сам transition.ts статус пишет -- иначе инвариант выполнен пустотой', () => {
    // Без этой проверки тест выше остаётся зелёным и после того, как
    // applyTransition перестанет что-либо делать.
    expect(/UPDATE tasks SET \$\{columns\.join/.test(read('transition.ts'))).toBe(true);
    expect(read('transition.ts')).toContain("columns: string[] = ['status = ?'");
  });

  it('scheduled.ts не отправляет сообщений в обход outbox по закрытым задачам', () => {
    const code = stripComments(read('scheduled.ts'));
    // Три оставшихся прохода cron пишут только таймеры и шлют напоминания -- но
    // все три обязаны фильтровать по статусу, иначе архивная задача продолжит
    // получать напоминания. Это и есть «после закрытия cron молчит».
    const selects = [...code.matchAll(/FROM tasks t[\s\S]*?WHERE([\s\S]*?)`/g)].map((m) => m[1]);
    expect(selects.length).toBeGreaterThanOrEqual(3);
    for (const where of selects) expect(where).toMatch(/t\.status\s*(=|IN)/);
  });
});
