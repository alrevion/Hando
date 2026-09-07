import { describe, expect, it } from 'vitest';
import { matchDeadline, parseByPattern } from '../src/parse';

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

  it('не принимает «ср» внутри «срочно» и «вс» внутри «всё»', () => {
    // Ровно та ловушка, из-за которой сокращения нельзя было добавить наивно.
    expect(matchDeadline('срочно закрыть акты', NOW, TZ).iso).toBeNull();
    expect(matchDeadline('всё сделать по сроку', NOW, TZ).iso).toBeNull();
    expect(matchDeadline('уточнить сроки поставки', NOW, TZ).iso).toBeNull();
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
