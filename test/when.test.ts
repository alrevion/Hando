import { describe, expect, it } from 'vitest';
import { resolveRepeat, resolveWhen, type When } from '../src/when';
import { MONTH_MIN } from '../src/assignees';

// Понедельник 7 сентября 2026, 10:00 по Ташкенту.
const NOW = new Date('2026-09-07T05:00:00.000Z');
const S = {
  timezone: 'Asia/Tashkent', always_on: 0, work_days: '1,2,3,4,5', work_end: '18:00',
  lunch_start: '13:00', quiet_from: '22:00', quiet_to: '08:00',
};
const W = (w: Partial<When>): When => ({
  kind: 'today', amount: null, unit: null, weekday: null, day: null, month: null, time: null, part: null, ...w,
});
/** Местное «YYYY-MM-DD HH:MM» -- так тесты читаются глазами. */
const local = (iso: string | null) =>
  new Date(Date.parse(iso!) + 5 * 3_600_000).toISOString().slice(0, 16).replace('T', ' ');

describe('срок из намерения модели', () => {
  it('«через N» минут и часов -- точный момент, дней -- конец того дня', () => {
    expect(local(resolveWhen(W({ kind: 'in', amount: 2, unit: 'minutes' }), NOW, S))).toBe('2026-09-07 10:02');
    expect(local(resolveWhen(W({ kind: 'in', amount: 3, unit: 'hours' }), NOW, S))).toBe('2026-09-07 13:00');
    expect(local(resolveWhen(W({ kind: 'in', amount: 2, unit: 'days' }), NOW, S))).toBe('2026-09-09 18:00');
    expect(local(resolveWhen(W({ kind: 'in', amount: 1, unit: 'weeks', part: 'morning' }), NOW, S))).toBe('2026-09-14 09:00');
    expect(local(resolveWhen(W({ kind: 'in', amount: 1, unit: 'months' }), NOW, S))).toBe('2026-10-07 18:00');
  });

  it('дни и часы: завтра, послезавтра, «в 15:30», «после обеда»', () => {
    expect(local(resolveWhen(W({ kind: 'tomorrow' }), NOW, S))).toBe('2026-09-08 18:00');
    expect(local(resolveWhen(W({ kind: 'after_tomorrow', time: '15:30' }), NOW, S))).toBe('2026-09-09 15:30');
    expect(local(resolveWhen(W({ kind: 'today', part: 'noon' }), NOW, S))).toBe('2026-09-07 13:00');
    expect(local(resolveWhen(W({ kind: 'today', part: 'afternoon' }), NOW, S))).toBe('2026-09-07 15:00');
  });

  it('прошедший час «сегодня» -- завтра, а не срок в прошлом', () => {
    expect(local(resolveWhen(W({ kind: 'today', time: '09:00' }), NOW, S))).toBe('2026-09-08 09:00');
  });

  it('день недели: ближайший, а сказанный в тот же день -- следующий', () => {
    expect(local(resolveWhen(W({ kind: 'weekday', weekday: 5 }), NOW, S))).toBe('2026-09-11 18:00');
    expect(local(resolveWhen(W({ kind: 'weekday', weekday: 1 }), NOW, S))).toBe('2026-09-14 18:00');
  });

  it('число и дата: прошедшее -- в следующем месяце или году; 31-е в коротком месяце -- последний день', () => {
    expect(local(resolveWhen(W({ kind: 'day_of_month', day: 15 }), NOW, S))).toBe('2026-09-15 18:00');
    expect(local(resolveWhen(W({ kind: 'day_of_month', day: 3 }), NOW, S))).toBe('2026-10-03 18:00');
    expect(local(resolveWhen(W({ kind: 'day_of_month', day: 31 }), NOW, S))).toBe('2026-09-30 18:00');
    expect(local(resolveWhen(W({ kind: 'date', day: 1, month: 3 }), NOW, S))).toBe('2027-03-01 18:00');
    expect(local(resolveWhen(W({ kind: 'date', day: 20, month: 9, time: '10:00' }), NOW, S))).toBe('2026-09-20 10:00');
  });

  it('конец недели -- по графику, конец месяца -- последний день', () => {
    expect(local(resolveWhen(W({ kind: 'end_of_week' }), NOW, S))).toBe('2026-09-11 18:00');
    expect(local(resolveWhen(W({ kind: 'end_of_week' }), NOW, { ...S, work_days: '1,2,3,4,5,6' }))).toBe('2026-09-12 18:00');
    expect(local(resolveWhen(W({ kind: 'end_of_month' }), NOW, S))).toBe('2026-09-30 18:00');
  });

  it('24/7: конец дня -- начало тихих часов', () => {
    expect(local(resolveWhen(W({ kind: 'tomorrow' }), NOW, { ...S, always_on: 1 }))).toBe('2026-09-08 22:00');
  });

  it('без срока -- null', () => {
    expect(resolveWhen(null, NOW, S)).toBeNull();
  });
});

describe('повтор из намерения модели', () => {
  const R = { n: null, weekday: null, day: null, time: null, part: null };
  it('каждый день в 9 -- с завтра (сегодняшние 9 прошли), в 12 -- с сегодня', () => {
    expect(resolveRepeat({ ...R, every: 'day', time: '09:00' }, NOW, S)).toEqual({ minutes: 1440, first: '2026-09-08T04:00:00.000Z' });
    expect(local(resolveRepeat({ ...R, every: 'day', time: '12:00' }, NOW, S)!.first)).toBe('2026-09-07 12:00');
  });

  it('каждую пятницу, каждое 1-е, раз в 3 дня', () => {
    const fri = resolveRepeat({ ...R, every: 'week', weekday: 5 }, NOW, S)!;
    expect(fri.minutes).toBe(7 * 1440);
    expect(local(fri.first)).toBe('2026-09-11 18:00');
    const first = resolveRepeat({ ...R, every: 'month', day: 1, part: 'morning' }, NOW, S)!;
    expect(first.minutes).toBe(MONTH_MIN);
    expect(local(first.first)).toBe('2026-10-01 09:00');
    expect(resolveRepeat({ ...R, every: 'n_days', n: 3 }, NOW, S)!.minutes).toBe(3 * 1440);
    expect(resolveRepeat({ ...R, every: 'n_weeks', n: 2, weekday: 1 }, NOW, S)!.minutes).toBe(14 * 1440);
  });

  it('каждый понедельник, сказанное в понедельник до срока -- сегодня', () => {
    expect(local(resolveRepeat({ ...R, every: 'week', weekday: 1 }, NOW, S)!.first)).toBe('2026-09-07 18:00');
  });
});
