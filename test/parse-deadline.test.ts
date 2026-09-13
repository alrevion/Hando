import { describe, expect, it } from 'vitest';
import { matchDeadline, matchRepeat, parseByPattern } from '../src/parse';

const TZ = 'Asia/Tashkent';
// Понедельник 7 сентября 2026, 10:00 по Ташкенту.
const NOW = new Date('2026-09-07T05:00:00.000Z');

describe('срок из фразы', () => {
  it('понимает сокращения дней недели', () => {
    for (const phrase of ['сдать отчёт в пт', 'сдать отчёт в пятницу', 'сдать отчёт до пт']) {
      const { iso } = matchDeadline(phrase, NOW, TZ);
      expect(iso, phrase).not.toBeNull();
      expect(new Date(iso!).toISOString().slice(0, 10), phrase).toBe('2026-09-11');
    }
  });

  it('срок-окошко: «в течение недели» -- это конец недели, а не пустой срок', () => {
    // Понедельник 7 сентября 2026. Конец недели -- пятница 11-го.
    const day = (p: string) => {
      const { iso } = matchDeadline(p, NOW, TZ);
      expect(iso, p).not.toBeNull();
      return new Date(iso!).toISOString().slice(0, 10);
    };
    expect(day('сделать в течение недели')).toBe('2026-09-11');
    expect(day('сделать до конца недели')).toBe('2026-09-11');
    expect(day('сделать на этой неделе')).toBe('2026-09-11');
    expect(day('сделать на неделе')).toBe('2026-09-11');
    // День -- сегодняшний, два дня -- завтрашний: окно кончается последним днём.
    expect(day('сделать в течение дня')).toBe('2026-09-07');
    expect(day('сделать в течение двух дней')).toBe('2026-09-08');
    expect(day('сделать в течение 3 дней')).toBe('2026-09-09');
    // Месяц -- его последний день.
    expect(day('сделать в течение месяца')).toBe('2026-09-30');
    expect(day('сделать за две недели')).toBe('2026-09-21');
  });

  it('конец недели -- по графику организации, а не всегда пятница', () => {
    const day = (p: string, weekEnd: number) =>
      new Date(matchDeadline(p, NOW, TZ, '18:00', weekEnd).iso!).toISOString().slice(0, 10);
    // Контора пн-пт: пятница 11-го. Магазин пн-сб: суббота 12-го.
    expect(day('сделать в течение недели', 5)).toBe('2026-09-11');
    expect(day('сделать в течение недели', 6)).toBe('2026-09-12');
    // Семья 24/7: воскресенье 13-го.
    expect(day('сделать в течение недели', 7)).toBe('2026-09-13');
  });

  it('«срок» и «сроки» окошком не считаются', () => {
    expect(matchDeadline('уточнить сроки поставки', NOW, TZ).iso).toBeNull();
    expect(matchDeadline('обсудить условия на месте', NOW, TZ).iso).toBeNull();
    // «На день» в речи почти всегда не срок.
    expect(matchDeadline('купить торт на день рождения', NOW, TZ).iso).toBeNull();
  });

  it('не принимает «ср» внутри «срочно» и «вс» внутри «всё»', () => {
    // Ровно та ловушка, из-за которой сокращения нельзя было добавить наивно.
    expect(matchDeadline('срочно закрыть акты', NOW, TZ).iso).toBeNull();
    expect(matchDeadline('всё сделать по сроку', NOW, TZ).iso).toBeNull();
    expect(matchDeadline('уточнить сроки поставки', NOW, TZ).iso).toBeNull();
  });
});

describe('повтор из фразы', () => {
  it('«через день», «каждый день», «каждую неделю», «каждые 3 дня»', () => {
    expect(matchRepeat('Мои цветы поливать через день').days).toBe(2);
    expect(matchRepeat('кормить кота каждый день').days).toBe(1);
    expect(matchRepeat('сдавать отчёт каждую неделю').days).toBe(7);
    expect(matchRepeat('полить цветы каждые 3 дня').days).toBe(3);
    expect(matchRepeat('платить аренду каждый месяц').days).toBe(30);
    expect(matchRepeat('купить молоко').days).toBeNull();
  });

  it('слова повтора вычитаются из темы: иначе они остаются в названии', () => {
    const d = parseByPattern('мои цветы поливать через день', [{ id: 'me', name: 'Тимур' }], 'me', NOW, TZ)!;
    expect(d).toBeTruthy();
    expect(d.repeatDays).toBe(2);
    expect(d.title.toLowerCase()).not.toContain('через день');
  });
});

describe('поручение самому себе', () => {
  const people = [{ id: 'me', name: 'Тимур Абдуллаев' }];

  it('срок без адресата -- напоминание себе, а не сырой текст', () => {
    const d = parseByPattern('Напомни Артуру что нужно сдать отчёт в пт', people, 'me', NOW, TZ);
    expect(d).not.toBeNull();
    expect(d!.assigneeIds).toEqual(['me']);
    expect(d!.deadline).not.toBeNull();
    // «в пт» из заголовка вычеркнуто -- это срок, а не суть поручения.
    expect(d!.title.toLowerCase()).not.toContain('пт');
    expect(d!.title.toLowerCase()).toContain('отчёт');
  });

  it('без адресата и без срока -- по-прежнему пас модели', () => {
    expect(parseByPattern('надо бы разобраться с этим', people, 'me', NOW, TZ)).toBeNull();
  });
});

describe('«до завтра» -- это сегодня', () => {
  it('предлог меняет смысл: срок ставится на конец СЕГОДНЯШНИХ суток', () => {
    // Пятница 11 сентября 2026, 14:00 в Ташкенте.
    const now = new Date('2026-09-11T09:00:00.000Z');
    const due = matchDeadline('Нужно создать презентацию и сдать её до завтра', now, 'Asia/Tashkent', '18:00').iso!;
    const local = new Intl.DateTimeFormat('ru-RU', { timeZone: 'Asia/Tashkent', day: 'numeric', month: 'numeric', hour: '2-digit', minute: '2-digit', hour12: false }).format(new Date(due));
    expect(local).toContain('11.09');
    expect(local).toContain('23:59');
    // А просто «завтра» -- завтрашний день по графику организации.
    const tomorrow = matchDeadline('сдать завтра', now, 'Asia/Tashkent', '18:00').iso!;
    const t = new Intl.DateTimeFormat('ru-RU', { timeZone: 'Asia/Tashkent', day: 'numeric', month: 'numeric', hour: '2-digit', minute: '2-digit', hour12: false }).format(new Date(tomorrow));
    expect(t).toContain('12.09');
    expect(t).toContain('18:00');
  });
});
