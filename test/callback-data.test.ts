// Инвариант: в callback_data кнопки Telegram помещается 64 БАЙТА.
//
// Проверка ГРЕПОМ ПО ИСХОДНИКАМ, а не поведением, по той же причине, что и
// единственный писатель статуса: поведенческий тест ловит только тот путь,
// который ему показали. Именно это и случилось вживую -- «join_ok:» с двумя
// UUID давало 81 байт, Telegram отвергал ВСЁ сообщение с кнопками, sendMessage
// молча возвращал null, и заявка на вступление пропадала без следа.
//
// Худший случай считается подстановкой UUID (36 символов) в каждую дырку
// `${...}`: почти все наши идентификаторы -- именно они.
import { describe, expect, it } from 'vitest';

const modules = (import.meta as unknown as {
  glob(pattern: string, opts: { query: string; import: string; eager: true }): Record<string, string>;
}).glob('../src/*.ts', { query: '?raw', import: 'default', eager: true });

const UUID_LEN = 36;

describe('callback_data укладывается в предел Telegram', () => {
  it('ни одна кнопка в src не может превысить 64 байта', () => {
    const offenders: string[] = [];
    let found = 0;

    for (const [path, code] of Object.entries(modules)) {
      // callback_data: `...` -- шаблон до закрывающей обратной кавычки.
      for (const m of code.matchAll(/callback_data:\s*`([^`]*)`/g)) {
        found++;
        const worst = m[1].replace(/\$\{[^}]*\}/g, 'x'.repeat(UUID_LEN));
        const bytes = new TextEncoder().encode(worst).length;
        if (bytes > 64) offenders.push(`${path}: «${m[1]}» -> ${bytes} байт`);
      }
    }

    expect(offenders).toEqual([]);
    // Страховка от вакуумной истины: если шаблон перестанет совпадать, тест
    // обязан упасть, а не молча ничего не проверить.
    expect(found).toBeGreaterThan(0);
  });
});
